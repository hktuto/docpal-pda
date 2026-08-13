import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { inArray, sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { transactionLogs, inventoryTransactions } from "./schema/index.js";
import { nextBoxId } from "./boxes.js";
import { now } from "./now.js";
import { completePutAwayTaskTx } from "./putawaytasks.js";
import { putAwayConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Put-away flow — staging-box model (ported from apps/api putAway.ts).
//
// A put-away "scan" is a shelf_box_items row in a staging box (a shelf_boxes
// row with shelf_code IS NULL, auto-created on first scan; ids from nextBoxId
// — BOX-H-<YYYYMMDD>-<seq>). Assigning a scan into a real box moves the row
// and MATERIALIZES the inventory lot (keyed part_no + shelf + box_id + batch
// attrs + the BOX's org_id/sub_inventory_code pair — the pair lives on
// shelf_boxes since 2026-07-23, box_id = the shelf box's id) with
// inventory_lot_sources +
// put_away_qty and two ledger rows (PUT_AWAY dock −qty / on_hand +qty);
// removing a scan reverses all of it.
//
// shelf_boxes has no receiving_order_id: a box's order derives from its items
// (shelf_box_items → receiving_invoice_items → receiving_invoices), falling
// back to the creation transition-log metadata for empty boxes (boxOrderId).
// ---------------------------------------------------------------------------

interface ShelfBoxRow {
  id: string;
  shelfCode: string | null;
  status: string;
}

async function loadShelfBox(tx: DbOrTx, boxId: string): Promise<ShelfBoxRow> {
  const box = await queryGet<ShelfBoxRow>(
    tx,
    sql`SELECT id, shelf_code AS "shelfCode", status
        FROM shelf_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shelf_box_not_found" });
  return box;
}

/**
 * A box's receiving order, derived from its items (boxes are single-order —
 * assignScanToBoxTx guards mixing); for empty boxes falls back to the
 * creation transition-log metadata (createShelfBox logs {order}).
 */
async function boxOrderId(tx: DbOrTx, boxId: string): Promise<string | null> {
  const row = await queryGet<{ orderId: string | null }>(
    tx,
    sql`SELECT COALESCE(
          (SELECT ri.receiving_order_id
           FROM shelf_box_items sbi
           JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
           JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
           WHERE sbi.shelf_box_id = ${boxId} LIMIT 1),
          (SELECT tl.metadata->>'order'
           FROM transaction_logs tl
           WHERE tl.entity_type = 'shelf_box' AND tl.entity_id = ${boxId} AND tl.to_state = 'open'
           ORDER BY tl.created_date DESC LIMIT 1)
        ) AS "orderId"`
  );
  return row?.orderId ?? null;
}

async function assertActor(tx: DbOrTx, actorId: string): Promise<void> {
  const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${actorId}`);
  if (!actor) throw new HTTPException(400, { message: "actor_not_found" });
}

async function logShelfBox(
  tx: DbOrTx,
  boxId: string,
  fromState: string | null,
  toState: string,
  actorId: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await tx.insert(transactionLogs).values({
    id: newId(),
    entityType: "shelf_box",
    entityId: boxId,
    fromState,
    toState,
    actorId,
    metadata,
    createdDate: now(),
  });
}

/** Find-or-create the order's staging box (shelf_code IS NULL): the staging
 *  box holding this order's scans, else any empty open staging box, else a
 *  new one. */
async function ensureStagingBox(tx: DbOrTx, receivingOrderId: string): Promise<string> {
  const existing = await queryGet<{ id: string }>(
    tx,
    sql`SELECT sb.id FROM shelf_boxes sb
        WHERE sb.shelf_code IS NULL AND sb.status = 'open'
          AND (
            EXISTS (
              SELECT 1 FROM shelf_box_items sbi
              JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
              JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
              WHERE sbi.shelf_box_id = sb.id AND ri.receiving_order_id = ${receivingOrderId}
            )
            OR NOT EXISTS (SELECT 1 FROM shelf_box_items sbi WHERE sbi.shelf_box_id = sb.id)
          )
        ORDER BY sb.created_date
        LIMIT 1`
  );
  if (existing) {
    // An empty staging box may be reused across orders — refresh its pair
    // (informational only; lots are stamped from the real box).
    const reusePair = await orderPair(tx, receivingOrderId);
    await queryRun(
      tx,
      sql`UPDATE shelf_boxes SET org_id = ${reusePair.orgId}, sub_inventory_code = ${reusePair.subInventoryCode} WHERE id = ${existing.id}`
    );
    return existing.id;
  }
  const id = await nextBoxId(tx, "H");
  // Staging boxes carry the order's pair for consistency (a box's pair is the
  // stock location pair for its contents since 2026-07-23).
  const pair = await orderPair(tx, receivingOrderId);
  await queryRun(
    tx,
    sql`INSERT INTO shelf_boxes (id, shelf_code, org_id, sub_inventory_code, status, created_date)
        VALUES (${id}, NULL, ${pair.orgId}, ${pair.subInventoryCode}, 'open', ${now()})`
  );
  await logShelfBox(tx, id, null, "open", null, { kind: "staging", order: receivingOrderId });
  return id;
}

/** The receiving order's stock location pair (mandatory on the order). */
async function orderPair(tx: DbOrTx, receivingOrderId: string): Promise<{ orgId: number; subInventoryCode: string }> {
  const row = await queryGet<{ orgId: number; subInventoryCode: string }>(
    tx,
    sql`SELECT org_id AS "orgId", sub_inventory_code AS "subInventoryCode" FROM receiving_orders WHERE id = ${receivingOrderId}`
  );
  if (!row) throw new HTTPException(404, { message: "receiving_order_not_found" });
  return row;
}

interface PutAwayItemRow {
  id: string;
  partNo: string;
  receivingOrderId: string;
  received: number;
  picked: number;
  putAway: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

async function loadItemForPutAway(tx: DbOrTx, itemId: string): Promise<PutAwayItemRow> {
  const item = await queryGet<PutAwayItemRow>(
    tx,
    sql`SELECT rii.id, rii.part_no AS "partNo", ri.receiving_order_id AS "receivingOrderId",
               rii.received_qty AS "received", rii.picked_qty AS "picked", rii.put_away_qty AS "putAway",
               rii.date_code AS "dateCode", rii.lot_code AS "lotCode", rii.coo, rii.cow
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE rii.id = ${itemId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
  return item;
}

/** received − picked − put away − allocated − staged (in the staging box). */
async function remainingAfterStaged(tx: DbOrTx, item: PutAwayItemRow): Promise<number> {
  const alloc = await queryGet<{ s: number }>(
    tx,
    sql`SELECT COALESCE(SUM(qty), 0)::int AS s FROM allocations WHERE receiving_invoice_item_id = ${item.id}`
  );
  const staged = await queryGet<{ s: number }>(
    tx,
    sql`SELECT COALESCE(SUM(sbi.qty), 0)::int AS s
        FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
        WHERE sbi.receiving_invoice_item_id = ${item.id} AND sb.shelf_code IS NULL`
  );
  return item.received - item.picked - item.putAway - (alloc?.s ?? 0) - (staged?.s ?? 0);
}

/** Any stock change invalidates verification: reset item flags, verified → closed. */
async function markBoxStockChanged(tx: DbOrTx, shelfBoxId: string): Promise<void> {
  await queryRun(
    tx,
    sql`UPDATE shelf_box_items SET verified = false, verified_at = NULL WHERE shelf_box_id = ${shelfBoxId}`
  );
  await queryRun(tx, sql`UPDATE shelf_boxes SET status = 'closed' WHERE id = ${shelfBoxId} AND status = 'verified'`);
}

/**
 * Auto-clear: an in_hand order with nothing left to put away or pick (every
 * item's remaining ≤ 0) moves to 'clear' + a transition log.
 */
export async function tryMarkReceivingOrderClear(
  tx: DbOrTx,
  input: { receivingOrderId: string; actorId: string | null }
): Promise<void> {
  const order = await queryGet<{ id: string; status: string }>(
    tx,
    sql`SELECT id, status FROM receiving_orders WHERE id = ${input.receivingOrderId}`
  );
  if (!order || order.status !== "in_hand") return;
  const items = await queryAll<PutAwayItemRow>(
    tx,
    sql`SELECT rii.id, rii.part_no AS "partNo", ri.receiving_order_id AS "receivingOrderId",
               rii.received_qty AS "received", rii.picked_qty AS "picked", rii.put_away_qty AS "putAway",
               rii.date_code AS "dateCode", rii.lot_code AS "lotCode", rii.coo, rii.cow
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${order.id}`
  );
  if (items.length === 0) return;
  for (const it of items) {
    if ((await remainingAfterStaged(tx, it)) > 0) return;
  }
  const at = now();
  await queryRun(tx, sql`UPDATE receiving_orders SET status = 'clear', last_update_date = ${at} WHERE id = ${order.id}`);
  await tx.insert(transactionLogs).values({
    id: newId(),
    entityType: "receiving_order",
    entityId: order.id,
    fromState: "in_hand",
    toState: "clear",
    actorId: input.actorId,
    createdDate: at,
  });
  // Complete the put-away task (if one exists) in the same tx — nothing left
  // to put away means the task is done, however the stock was consumed.
  await completePutAwayTaskTx(tx, { receivingOrderId: order.id, actorId: input.actorId });
}

// ---------------------------------------------------------------------------
// Reads (called by the routes; kept here so tests can exercise them).
// ---------------------------------------------------------------------------

export interface PutAwayCandidateRow {
  id: string;
  batchNo: string;
  status: string;
  supplierCode: string | null;
  supplierName: string | null;
  orgId: number;
  subInventoryCode: string;
  receivedItems: number;
  unboxedItems: number;
}

/** Receivable orders (in_hand / provisional_received) with per-order item counts. */
export async function listPutAwayCandidates(db: AppDb): Promise<PutAwayCandidateRow[]> {
  return queryAll<PutAwayCandidateRow>(
    db,
    sql`
      SELECT
        ro.id,
        ro.batch_no AS "batchNo",
        ro.status,
        s.code AS "supplierCode",
        s.name AS "supplierName",
        ro.org_id AS "orgId",
        ro.sub_inventory_code AS "subInventoryCode",
        COUNT(rii.id) FILTER (WHERE rii.received_qty > 0)::int AS "receivedItems",
        COUNT(rii.id) FILTER (WHERE
          rii.received_qty - rii.picked_qty - rii.put_away_qty
            - COALESCE(alloc.qty, 0) - COALESCE(staged.qty, 0) > 0)::int AS "unboxedItems"
      FROM receiving_orders ro
      LEFT JOIN suppliers s ON s.code = ro.supplier_code
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      LEFT JOIN (
        SELECT receiving_invoice_item_id, SUM(qty)::int AS qty
        FROM allocations
        WHERE receiving_invoice_item_id IS NOT NULL
        GROUP BY receiving_invoice_item_id
      ) alloc ON alloc.receiving_invoice_item_id = rii.id
      LEFT JOIN (
        SELECT sbi.receiving_invoice_item_id, SUM(sbi.qty)::int AS qty
        FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
        WHERE sb.shelf_code IS NULL
        GROUP BY sbi.receiving_invoice_item_id
      ) staged ON staged.receiving_invoice_item_id = rii.id
      WHERE ro.status IN ('in_hand', 'provisional_received')
      GROUP BY ro.id, s.id
      ORDER BY ro.created_date DESC
    `
  );
}

export interface PutAwayLotRow {
  id: string;
  partNo: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

export interface PutAwayScanRow {
  id: string;
  receivingInvoiceItemId: string | null;
  partNo: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

export interface PutAwayBoxItemRow {
  id: string;
  receivingInvoiceItemId: string | null;
  partNo: string;
  qty: number;
  verified: boolean | null;
  verifiedAt: Date | null;
}

export type PutAwaySuggestionReason = "same-part-box" | "same-part-stock" | "sub-inventory-shelf";

export interface PutAwayExpectedItemRow {
  id: string;
  partNo: string;
  lineQty: number;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  allocatedQty: number;
  remainingQty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  /** Advisory shelf/box suggestion (spec 2026-08-12-put-away-shelf-org-suggestion-design.md);
   *  all null when nothing matches or suggestShelf is "off". */
  suggestedShelfCode: string | null;
  suggestedBoxId: string | null;
  suggestionReason: PutAwaySuggestionReason | null;
}

export interface PutAwayAggregate {
  order: { id: string; batchNo: string; status: string };
  items: PutAwayExpectedItemRow[];
  lots: PutAwayLotRow[];
  scans: PutAwayScanRow[];
  boxes: {
    id: string;
    shelfCode: string | null;
    status: string;
    createdDate: Date;
    items: PutAwayBoxItemRow[];
  }[];
}

/**
 * The one aggregate read for the put-away detail screen: the order's expected
 * items (receivable list with remaining = received − picked − put away −
 * allocated − staged, the candidates-list formula), each with an advisory
 * shelf/box suggestion, lots materialized from this order (via
 * inventory_lot_sources), scans still in the staging box, and the
 * non-staging boxes with their item rows.
 */
export async function getPutAwayAggregate(db: AppDb, orderId: string): Promise<PutAwayAggregate> {
  const order = await queryGet<{ id: string; batchNo: string; status: string; orgId: number; subInventoryCode: string }>(
    db,
    sql`SELECT id, batch_no AS "batchNo", status, org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
        FROM receiving_orders WHERE id = ${orderId}`
  );
  if (!order) throw new HTTPException(404, { message: "receiving_order_not_found" });

  const lots = await queryAll<PutAwayLotRow>(
    db,
    sql`
      SELECT DISTINCT
        il.id, il.part_no AS "partNo",
        il.date_code AS "dateCode", il.lot_code AS "lotCode", il.coo, il.cow,
        il.shelf_code AS "shelfCode", il.box_id AS "boxId",
        il.org_id AS "orgId", il.sub_inventory_code AS "subInventoryCode",
        il.total_qty AS "totalQty", il.allocated_qty AS "allocatedQty",
        il.available_qty AS "availableQty"
      FROM inventory_lots il
      JOIN inventory_lot_sources ils ON ils.inventory_lot_id = il.id
      JOIN receiving_invoice_items rii ON rii.id = ils.receiving_invoice_item_id
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE ri.receiving_order_id = ${orderId}
      ORDER BY il.shelf_code, il.id
    `
  );

  // Expected items with the candidates-list remaining formula (received −
  // picked − put away − allocated − staged) — the put-away page's receivable
  // item list.
  const items = await queryAll<PutAwayExpectedItemRow>(
    db,
    sql`
      SELECT
        rii.id, rii.part_no AS "partNo",
        rii.line_qty AS "lineQty", rii.received_qty AS "receivedQty", rii.picked_qty AS "pickedQty",
        rii.put_away_qty AS "putAwayQty",
        COALESCE(alloc.qty, 0)::int AS "allocatedQty",
        (rii.received_qty - rii.picked_qty - rii.put_away_qty
          - COALESCE(alloc.qty, 0) - COALESCE(staged.qty, 0))::int AS "remainingQty",
        rii.date_code AS "dateCode", rii.lot_code AS "lotCode", rii.coo, rii.cow
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      LEFT JOIN (
        SELECT receiving_invoice_item_id, SUM(qty)::int AS qty
        FROM allocations
        WHERE receiving_invoice_item_id IS NOT NULL
        GROUP BY receiving_invoice_item_id
      ) alloc ON alloc.receiving_invoice_item_id = rii.id
      LEFT JOIN (
        SELECT sbi.receiving_invoice_item_id, SUM(sbi.qty)::int AS qty
        FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
        WHERE sb.shelf_code IS NULL
        GROUP BY sbi.receiving_invoice_item_id
      ) staged ON staged.receiving_invoice_item_id = rii.id
      WHERE ri.receiving_order_id = ${orderId}
      ORDER BY rii.po_no, rii.po_line, rii.id
    `
  );

  // Per-item shelf/box suggestion, ranked within the order's org +
  // sub-inventory (same rules as the put-away task detail). Advisory, computed
  // at read time, never stored; all null when suggestShelf is "off".
  const suggestions =
    putAwayConfig().suggestShelf !== "off"
      ? await computeShelfSuggestions(db, [...new Set(items.map((it) => it.partNo))], order.orgId, order.subInventoryCode)
      : new Map<string, ShelfSuggestion>();
  const itemsWithSuggestions: PutAwayExpectedItemRow[] = items.map((it) => {
    const s = suggestions.get(it.partNo);
    return {
      ...it,
      suggestedShelfCode: s?.shelfCode ?? null,
      suggestedBoxId: s?.boxId ?? null,
      suggestionReason: s?.reason ?? null,
    };
  });

  const scans = await queryAll<PutAwayScanRow>(
    db,
    sql`
      SELECT
        sbi.id, sbi.receiving_invoice_item_id AS "receivingInvoiceItemId",
        sbi.part_no AS "partNo", sbi.qty,
        rii.date_code AS "dateCode", rii.lot_code AS "lotCode", rii.coo, rii.cow
      FROM shelf_box_items sbi
      JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
      JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE ri.receiving_order_id = ${orderId} AND sb.shelf_code IS NULL
      ORDER BY sbi.id
    `
  );

  const boxes = await queryAll<{ id: string; shelfCode: string | null; status: string; createdDate: Date }>(
    db,
    sql`
      SELECT sb.id, sb.shelf_code AS "shelfCode", sb.status, sb.created_date AS "createdDate"
      FROM shelf_boxes sb
      WHERE sb.shelf_code IS NOT NULL AND (
        EXISTS (
          SELECT 1 FROM shelf_box_items sbi
          JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE sbi.shelf_box_id = sb.id AND ri.receiving_order_id = ${orderId}
        )
        OR (
          NOT EXISTS (SELECT 1 FROM shelf_box_items sbi WHERE sbi.shelf_box_id = sb.id)
          AND EXISTS (
            SELECT 1 FROM transaction_logs tl
            WHERE tl.entity_type = 'shelf_box' AND tl.entity_id = sb.id AND tl.to_state = 'open'
              AND tl.metadata->>'order' = ${orderId}
          )
        )
      )
      ORDER BY CASE WHEN sb.status = 'open' THEN 0 ELSE 1 END, sb.created_date DESC
    `
  );

  const boxIds = boxes.map((b) => b.id);
  const boxItems = boxIds.length
    ? await queryAll<PutAwayBoxItemRow & { shelfBoxId: string }>(
        db,
        sql`
          SELECT
            sbi.id, sbi.shelf_box_id AS "shelfBoxId",
            sbi.receiving_invoice_item_id AS "receivingInvoiceItemId",
            sbi.part_no AS "partNo", sbi.qty,
            sbi.verified, sbi.verified_at AS "verifiedAt"
          FROM shelf_box_items sbi
          WHERE ${inArray(sql`sbi.shelf_box_id`, boxIds)}
          ORDER BY sbi.id
        `
      )
    : [];

  return {
    order: { id: order.id, batchNo: order.batchNo, status: order.status },
    items: itemsWithSuggestions,
    lots,
    scans,
    boxes: boxes.map((b) => ({
      ...b,
      items: boxItems
        .filter((i) => i.shelfBoxId === b.id)
        .map(({ shelfBoxId: _shelfBoxId, ...rest }) => rest),
    })),
  };
}

interface ShelfSuggestion {
  shelfCode: string | null;
  boxId: string | null;
  reason: PutAwaySuggestionReason;
}

/**
 * Shelf/box suggestions per part_no, ranked within the order's org +
 * sub-inventory (spec 2026-08-12-put-away-shelf-org-suggestion-design.md):
 *   1. same-part-box   — most recent OPEN shelf box already containing the
 *                        part (part_no only, any date code) → its shelf + box
 *   2. same-part-stock — shelf of the most recent lot of the same part
 *   3. sub-inventory-shelf — first shelf (by code) tagged with the
 *      sub-inventory
 */
async function computeShelfSuggestions(
  db: AppDb,
  partNos: string[],
  orgId: number,
  subInventoryCode: string
): Promise<Map<string, ShelfSuggestion>> {
  const suggestions = new Map<string, ShelfSuggestion>();
  if (partNos.length === 0) return suggestions;
  const partList = sql.join(partNos.map((p) => sql`${p}`), sql`, `);
  // 1. same-part-box: most recent OPEN shelf box already holding the part
  //    (part_no only — date code intentionally not matched)
  const boxRows = await queryAll<{ partNo: string; boxId: string; shelfCode: string }>(
    db,
    sql`SELECT DISTINCT ON (sbi.part_no) sbi.part_no AS "partNo",
               sb.id AS "boxId", sb.shelf_code AS "shelfCode"
        FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
        WHERE sbi.part_no IN (${partList})
          AND sb.status = 'open'
          AND sb.org_id = ${orgId}
          AND sb.sub_inventory_code = ${subInventoryCode}
          AND sb.shelf_code IS NOT NULL
        ORDER BY sbi.part_no, sb.created_date DESC, sb.id`
  );
  for (const r of boxRows) suggestions.set(r.partNo, { shelfCode: r.shelfCode, boxId: r.boxId, reason: "same-part-box" });
  // 2. same-part-stock: shelf of the most recent lot of the same part
  const stockRows = await queryAll<{ partNo: string; shelfCode: string }>(
    db,
    sql`SELECT DISTINCT ON (part_no) part_no AS "partNo", shelf_code AS "shelfCode"
        FROM inventory_lots
        WHERE part_no IN (${partList})
          AND org_id = ${orgId}
          AND sub_inventory_code = ${subInventoryCode}
          AND shelf_code IS NOT NULL
        ORDER BY part_no, created_date DESC, id`
  );
  for (const r of stockRows) {
    if (!suggestions.has(r.partNo)) suggestions.set(r.partNo, { shelfCode: r.shelfCode, boxId: null, reason: "same-part-stock" });
  }
  // 3. sub-inventory-shelf fallback for parts with no stock history at all
  const missing = partNos.filter((p) => !suggestions.has(p));
  if (missing.length > 0) {
    const taggedShelf = await queryGet<{ code: string }>(
      db,
      sql`SELECT code FROM shelves WHERE ${subInventoryCode} = ANY(sub_inventory_codes) ORDER BY code LIMIT 1`
    );
    if (taggedShelf) {
      for (const p of missing) suggestions.set(p, { shelfCode: taggedShelf.code, boxId: null, reason: "sub-inventory-shelf" });
    }
  }
  return suggestions;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface RecordPutAwayScanInput {
  actorId: string;
  receivingInvoiceItemId: string;
  qty: number;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
  /** When set, the scan is assigned straight into this open shelf box in the
   *  same tx (active-box auto-put) instead of staying in staging. */
  shelfBoxId?: string | null;
}

/**
 * Record one staging scan: backfills NULL batch attributes on the invoice
 * item (the RII row is the batch source of truth) and inserts a
 * shelf_box_items row into the order's staging box. Guarded by the remaining
 * qty (received − picked − put away − allocated − staged). With `shelfBoxId`
 * the scan is immediately assigned into that open box in the same tx
 * (lot + ledger included); otherwise no ledger rows — nothing moved physically.
 */
export async function recordPutAwayScan(
  db: AppDb,
  orderId: string,
  input: RecordPutAwayScanInput
): Promise<PutAwayScanRow> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string }>(tx, sql`SELECT id FROM receiving_orders WHERE id = ${orderId}`);
    if (!order) throw new HTTPException(404, { message: "receiving_order_not_found" });
    await assertActor(tx, input.actorId);
    const item = await loadItemForPutAway(tx, input.receivingInvoiceItemId);
    if (item.receivingOrderId !== orderId) {
      throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
    }
    if (!Number.isInteger(input.qty) || input.qty <= 0) {
      throw new HTTPException(400, { message: "qty_must_be_positive_integer" });
    }
    const remaining = await remainingAfterStaged(tx, item);
    if (input.qty > remaining) throw new HTTPException(409, { message: "scanned_qty_exceeds_remaining" });

    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items
          SET date_code = COALESCE(date_code, ${input.dateCode ?? null}),
              lot_code = COALESCE(lot_code, ${input.lotCode ?? null}),
              coo = COALESCE(coo, ${input.coo ?? null}),
              cow = COALESCE(cow, ${input.cow ?? null})
          WHERE id = ${item.id}`
    );

    const stagingBoxId = await ensureStagingBox(tx, item.receivingOrderId);
    const id = newId();
    await queryRun(
      tx,
      sql`INSERT INTO shelf_box_items (id, shelf_box_id, receiving_invoice_item_id, part_no, qty, verified)
          VALUES (${id}, ${stagingBoxId}, ${item.id}, ${item.partNo}, ${input.qty}, false)`
    );
    // Active-box auto-put: assign the just-staged scan into the target box in
    // the same tx (guards/materialization/ledger/auto-clear reused; a guard
    // failure rolls back the staging insert too).
    if (input.shelfBoxId) {
      await assignScanToBoxTx(tx, { scanId: id, shelfBoxId: input.shelfBoxId, actorId: input.actorId });
    }
    const row = await queryGet<PutAwayScanRow>(
      tx,
      sql`SELECT sbi.id, sbi.receiving_invoice_item_id AS "receivingInvoiceItemId",
                 sbi.part_no AS "partNo", sbi.qty,
                 rii.date_code AS "dateCode", rii.lot_code AS "lotCode", rii.coo, rii.cow
          FROM shelf_box_items sbi
          JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
          WHERE sbi.id = ${id}`
    );
    return row!;
  });
}

export interface ShelfBoxDto {
  id: string;
  receivingOrderId: string | null;
  shelfCode: string | null;
  status: string;
  createdDate: Date;
}

/**
 * Create a real (non-staging) shelf box for an order; logs the open transition.
 * With `boxId` (a scanned physical box QR) the box uses that id instead of a
 * server-generated one: an existing open box of the same order is returned
 * unchanged (idempotent re-scan — the client just makes it active), any other
 * existing id is a 409 conflict.
 */
export async function createShelfBox(
  db: AppDb,
  input: { receivingOrderId: string; shelfCode: string; actorId: string; boxId?: string | null }
): Promise<ShelfBoxDto> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM receiving_orders WHERE id = ${input.receivingOrderId}`
    );
    if (!order) throw new HTTPException(404, { message: "receiving_order_not_found" });
    const shelf = await queryGet<{ code: string }>(tx, sql`SELECT code FROM shelves WHERE code = ${input.shelfCode}`);
    if (!shelf) throw new HTTPException(404, { message: "shelf_not_found" });
    await assertActor(tx, input.actorId);
    // The box's stock location pair defaults to the receiving order's pair
    // (admin can override later); put-away stamps lots with the box's pair.
    const pair = await orderPair(tx, input.receivingOrderId);

    const requestedId = input.boxId?.trim() || null;
    if (input.boxId != null && !requestedId) {
      throw new HTTPException(400, { message: "box_id_required" });
    }
    if (requestedId) {
      const existing = await queryGet<ShelfBoxRow & { createdDate: Date; receivingOrderId: string | null }>(
        tx,
        sql`SELECT id, shelf_code AS "shelfCode", status, created_date AS "createdDate"
            FROM shelf_boxes WHERE id = ${requestedId}`
      );
      if (existing) {
        const existingOrder = await boxOrderId(tx, existing.id);
        if (existing.status === "open" && existing.shelfCode !== null
            && (existingOrder === null || existingOrder === input.receivingOrderId)) {
          return { ...existing, receivingOrderId: existingOrder ?? input.receivingOrderId };
        }
        throw new HTTPException(409, { message: "box_id_already_exists" });
      }
    }

    const id = requestedId ?? (await nextBoxId(tx, "H"));
    const at = now();
    await queryRun(
      tx,
      sql`INSERT INTO shelf_boxes (id, shelf_code, org_id, sub_inventory_code, status, created_date)
          VALUES (${id}, ${input.shelfCode}, ${pair.orgId}, ${pair.subInventoryCode}, 'open', ${at})`
    );
    await logShelfBox(tx, id, null, "open", input.actorId, {
      order: input.receivingOrderId,
      shelf: input.shelfCode,
    });
    return { id, receivingOrderId: input.receivingOrderId, shelfCode: input.shelfCode, status: "open", createdDate: at };
  });
}

/** Cancel an empty, open, non-staging box: transition log + hard delete. */
export async function cancelShelfBox(db: AppDb, input: { shelfBoxId: string; actorId: string }): Promise<void> {
  return db.transaction(async (tx) => {
    const box = await loadShelfBox(tx, input.shelfBoxId);
    await assertActor(tx, input.actorId);
    if (box.status !== "open") throw new HTTPException(409, { message: "shelf_box_not_open" });
    if (box.shelfCode === null) throw new HTTPException(409, { message: "cannot_cancel_staging_box" });
    const cnt = (
      await queryGet<{ c: number }>(tx, sql`SELECT COUNT(*)::int AS c FROM shelf_box_items WHERE shelf_box_id = ${box.id}`)
    )!.c;
    if (cnt > 0) throw new HTTPException(409, { message: "shelf_box_not_empty" });
    await logShelfBox(tx, box.id, "open", "cancelled", input.actorId);
    await queryRun(tx, sql`DELETE FROM shelf_boxes WHERE id = ${box.id}`);
  });
}

async function assignScanToBoxTx(
  tx: DbOrTx,
  input: { scanId: string; shelfBoxId: string; actorId: string }
): Promise<void> {
  const scan = await queryGet<{ id: string; itemId: string; qty: number; shelfBoxId: string | null; partNo: string }>(
    tx,
    sql`SELECT id, receiving_invoice_item_id AS "itemId", qty, shelf_box_id AS "shelfBoxId", part_no AS "partNo"
        FROM shelf_box_items WHERE id = ${input.scanId}`
  );
  if (!scan) throw new HTTPException(404, { message: "scan_not_found" });
  const scanBox = scan.shelfBoxId
    ? await queryGet<{ shelfCode: string | null }>(
        tx,
        sql`SELECT shelf_code AS "shelfCode" FROM shelf_boxes WHERE id = ${scan.shelfBoxId}`
      )
    : undefined;
  if (!scanBox || scanBox.shelfCode !== null) {
    throw new HTTPException(409, { message: "scan_not_in_staging_box" });
  }
  const box = await loadShelfBox(tx, input.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf_box_not_open" });
  if (box.shelfCode === null) throw new HTTPException(409, { message: "cannot_assign_into_staging_box" });
  const item = await loadItemForPutAway(tx, scan.itemId);
  const boxOrder = await boxOrderId(tx, box.id);
  if (boxOrder !== null && boxOrder !== item.receivingOrderId) {
    throw new HTTPException(409, { message: "different_receiving_orders" });
  }

  await queryRun(tx, sql`UPDATE shelf_box_items SET shelf_box_id = ${box.id}, verified = false WHERE id = ${scan.id}`);

  // The box carries the location pair (org_id + sub_inventory_code) stamped
  // onto the lot (pre-2026-07-23: taken from the shelf).
  const boxPair = (
    await queryGet<{ orgId: number | null; subInventoryCode: string | null }>(
      tx,
      sql`SELECT org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
          FROM shelf_boxes WHERE id = ${box.id}`
    )
  )!;

  // Lot lookup mirrors the unique index (part_no + batch attrs + shelf + box
  // + location pair); a match merges into the existing lot.
  const lot = await queryGet<{ id: string }>(
    tx,
    sql`SELECT id FROM inventory_lots
        WHERE part_no = ${item.partNo} AND shelf_code = ${box.shelfCode} AND box_id = ${box.id}
          AND date_code IS NOT DISTINCT FROM ${item.dateCode}
          AND lot_code IS NOT DISTINCT FROM ${item.lotCode}
          AND coo IS NOT DISTINCT FROM ${item.coo}
          AND cow IS NOT DISTINCT FROM ${item.cow}
          AND org_id IS NOT DISTINCT FROM ${boxPair.orgId}
          AND sub_inventory_code IS NOT DISTINCT FROM ${boxPair.subInventoryCode}`
  );
  let lotId: string;
  if (lot) {
    lotId = lot.id;
    await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = total_qty + ${scan.qty} WHERE id = ${lotId}`);
  } else {
    lotId = newId();
    await queryRun(
      tx,
      sql`INSERT INTO inventory_lots (id, part_no, date_code, lot_code, coo, cow, shelf_code, box_id,
                                     org_id, sub_inventory_code, total_qty, allocated_qty)
          VALUES (${lotId}, ${item.partNo}, ${item.dateCode}, ${item.lotCode}, ${item.coo}, ${item.cow},
                  ${box.shelfCode}, ${box.id},
                  ${boxPair.orgId}, ${boxPair.subInventoryCode},
                  ${scan.qty}, 0)`
    );
  }

  const src = await queryGet<{ id: string }>(
    tx,
    sql`SELECT id FROM inventory_lot_sources WHERE inventory_lot_id = ${lotId} AND receiving_invoice_item_id = ${scan.itemId}`
  );
  if (src) {
    await queryRun(tx, sql`UPDATE inventory_lot_sources SET qty = qty + ${scan.qty} WHERE id = ${src.id}`);
  } else {
    await queryRun(
      tx,
      sql`INSERT INTO inventory_lot_sources (id, inventory_lot_id, receiving_invoice_item_id, qty)
          VALUES (${newId()}, ${lotId}, ${scan.itemId}, ${scan.qty})`
    );
  }

  await queryRun(
    tx,
    sql`UPDATE receiving_invoice_items SET put_away_qty = put_away_qty + ${scan.qty} WHERE id = ${scan.itemId}`
  );

  // Ledger: stock leaves the dock and lands on the shelf (two rows, one per
  // qty type — balances confirm-arrival's RECEIVE_TO_DOCK dock +qty).
  const at = now();
  const base = {
    inventoryLotId: lotId,
    partNo: item.partNo,
    shelfCode: box.shelfCode,
    boxId: box.id,
    txnType: "PUT_AWAY",
    dateCode: item.dateCode,
    lotCode: item.lotCode,
    coo: item.coo,
    cow: item.cow,
    referenceType: "shelf_box",
    referenceId: box.id,
    receivingInvoiceItemId: scan.itemId,
    actorId: input.actorId,
    txnReason: "put away",
    txnAt: at,
  };
  await tx.insert(inventoryTransactions).values([
    { ...base, id: newId(), qtyType: "dock", qtyDelta: -scan.qty },
    { ...base, id: newId(), qtyType: "on_hand", qtyDelta: scan.qty },
  ]);

  await markBoxStockChanged(tx, box.id);
  await tryMarkReceivingOrderClear(tx, { receivingOrderId: item.receivingOrderId, actorId: input.actorId });
}

/**
 * Assign one staging scan into a real box: moves the row, materializes/merges
 * the inventory lot (+ sources + put_away_qty), writes the two PUT_AWAY
 * ledger rows, and runs the auto-clear check. The caller runs `allocateAll`
 * after commit (best-effort).
 */
export async function assignScanToBox(
  db: AppDb,
  input: { scanId: string; shelfBoxId: string; actorId: string }
): Promise<void> {
  return db.transaction(async (tx) => {
    await assertActor(tx, input.actorId);
    await assignScanToBoxTx(tx, input);
  });
}

/** Assign every staging scan of the box's order into the box (one tx). */
export async function addAllUnboxedToBox(
  db: AppDb,
  input: { shelfBoxId: string; actorId: string }
): Promise<{ count: number }> {
  return db.transaction(async (tx) => {
    const box = await loadShelfBox(tx, input.shelfBoxId);
    await assertActor(tx, input.actorId);
    if (box.status !== "open") throw new HTTPException(409, { message: "shelf_box_not_open" });
    if (box.shelfCode === null) throw new HTTPException(409, { message: "cannot_add_to_staging_box" });
    const boxOrder = await boxOrderId(tx, box.id);
    if (boxOrder === null) return { count: 0 };
    const scans = await queryAll<{ id: string }>(
      tx,
      sql`SELECT sbi.id FROM shelf_box_items sbi
          JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
          JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE sb.shelf_code IS NULL AND ri.receiving_order_id = ${boxOrder}
          ORDER BY sbi.id`
    );
    for (const s of scans) {
      await assignScanToBoxTx(tx, { scanId: s.id, shelfBoxId: box.id, actorId: input.actorId });
    }
    return { count: scans.length };
  });
}

/**
 * Remove one scan from its box back to staging: reverses the lot / sources /
 * put_away_qty and writes the reverse ledger rows (dock +qty / on_hand −qty).
 * 409 when the lot has pick allocations. The caller runs `allocateAll` after
 * commit (best-effort).
 */
export async function removeScanFromBox(
  db: AppDb,
  input: { shelfBoxId: string; scanId: string; actorId: string }
): Promise<void> {
  return db.transaction(async (tx) => {
    const scan = await queryGet<{ id: string; itemId: string; qty: number; shelfBoxId: string | null }>(
      tx,
      sql`SELECT id, receiving_invoice_item_id AS "itemId", qty, shelf_box_id AS "shelfBoxId"
          FROM shelf_box_items WHERE id = ${input.scanId}`
    );
    if (!scan) throw new HTTPException(404, { message: "scan_not_found" });
    if (scan.shelfBoxId === null || scan.shelfBoxId !== input.shelfBoxId) {
      throw new HTTPException(409, { message: "scan_not_in_box" });
    }
    const box = await loadShelfBox(tx, input.shelfBoxId);
    await assertActor(tx, input.actorId);
    if (box.status !== "open") throw new HTTPException(409, { message: "shelf_box_not_open" });
    if (box.shelfCode === null) throw new HTTPException(409, { message: "scan_in_staging_box" });
    const item = await loadItemForPutAway(tx, scan.itemId);

    const stagingBoxId = await ensureStagingBox(tx, item.receivingOrderId);
    await queryRun(
      tx,
      sql`UPDATE shelf_box_items SET shelf_box_id = ${stagingBoxId}, verified = false WHERE id = ${scan.id}`
    );

    // Reverse the lot materialization (same key as assign: RII + box + batch).
    const src = await queryGet<{ id: string; lotId: string; qty: number }>(
      tx,
      sql`SELECT ils.id, ils.inventory_lot_id AS "lotId", ils.qty
          FROM inventory_lot_sources ils
          JOIN inventory_lots il ON il.id = ils.inventory_lot_id
          WHERE ils.receiving_invoice_item_id = ${scan.itemId} AND il.box_id = ${box.id}
            AND il.date_code IS NOT DISTINCT FROM ${item.dateCode}
            AND il.lot_code IS NOT DISTINCT FROM ${item.lotCode}
            AND il.coo IS NOT DISTINCT FROM ${item.coo}
            AND il.cow IS NOT DISTINCT FROM ${item.cow}`
    );
    let ledgerLotId: string | null = null;
    if (src) {
      const hasAllocations = (
        await queryGet<{ n: number }>(
          tx,
          sql`SELECT COUNT(*)::int AS n FROM allocations WHERE inventory_lot_id = ${src.lotId}`
        )
      )!.n;
      if (hasAllocations > 0) throw new HTTPException(409, { message: "lot_has_pick_allocations" });
      if (src.qty - scan.qty <= 0) {
        await queryRun(tx, sql`DELETE FROM inventory_lot_sources WHERE id = ${src.id}`);
      } else {
        await queryRun(tx, sql`UPDATE inventory_lot_sources SET qty = qty - ${scan.qty} WHERE id = ${src.id}`);
      }
      const total = (await queryGet<{ v: number }>(tx, sql`SELECT total_qty AS v FROM inventory_lots WHERE id = ${src.lotId}`))!.v;
      if (total - scan.qty <= 0) {
        // An emptied lot is deleted. First detach its existing ledger rows
        // (FK inventory_lot_id → inventory_lots has no ON DELETE behavior) —
        // the rows keep part/shelf/box/qty/batch snapshot for the audit trail;
        // the reverse rows written below carry inventoryLotId = null.
        await queryRun(
          tx,
          sql`UPDATE inventory_transactions SET inventory_lot_id = NULL WHERE inventory_lot_id = ${src.lotId}`
        );
        await queryRun(tx, sql`DELETE FROM inventory_lots WHERE id = ${src.lotId}`);
      } else {
        await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = total_qty - ${scan.qty} WHERE id = ${src.lotId}`);
        ledgerLotId = src.lotId;
      }
    }

    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items SET put_away_qty = put_away_qty - ${scan.qty} WHERE id = ${scan.itemId}`
    );

    const at = now();
    const base = {
      inventoryLotId: ledgerLotId,
      partNo: item.partNo,
      shelfCode: box.shelfCode,
      boxId: box.id,
      txnType: "PUT_AWAY",
      dateCode: item.dateCode,
      lotCode: item.lotCode,
      coo: item.coo,
      cow: item.cow,
      referenceType: "shelf_box",
      referenceId: box.id,
      receivingInvoiceItemId: scan.itemId,
      actorId: input.actorId,
      txnReason: "remove from box",
      txnAt: at,
    };
    await tx.insert(inventoryTransactions).values([
      { ...base, id: newId(), qtyType: "dock", qtyDelta: scan.qty },
      { ...base, id: newId(), qtyType: "on_hand", qtyDelta: -scan.qty },
    ]);

    await markBoxStockChanged(tx, box.id);
    await tryMarkReceivingOrderClear(tx, { receivingOrderId: item.receivingOrderId, actorId: input.actorId });
  });
}

/**
 * Delete a staged scan (mis-scan correction): hard-deletes the staging row.
 * Only staging rows can be deleted — a boxed scan must go through
 * removeScanFromBox first. No ledger rows (nothing moved physically) and no
 * transition log, mirroring the old API's remove-piece.
 */
export async function deleteStagedPutAwayScan(
  db: AppDb,
  input: { scanId: string; actorId: string }
): Promise<void> {
  return db.transaction(async (tx) => {
    const scan = await queryGet<{ id: string; shelfBoxId: string | null }>(
      tx,
      sql`SELECT id, shelf_box_id AS "shelfBoxId" FROM shelf_box_items WHERE id = ${input.scanId}`
    );
    if (!scan) throw new HTTPException(404, { message: "scan_not_found" });
    await assertActor(tx, input.actorId);
    if (scan.shelfBoxId === null) throw new HTTPException(409, { message: "scan_not_in_staging_box" });
    const box = await loadShelfBox(tx, scan.shelfBoxId);
    if (box.shelfCode !== null) throw new HTTPException(409, { message: "scan_not_in_staging_box" });
    await queryRun(tx, sql`DELETE FROM shelf_box_items WHERE id = ${scan.id}`);
  });
}

/** Close a non-empty, open, non-staging box (+ transition log + auto-clear). */
export async function closeShelfBox(db: AppDb, input: { shelfBoxId: string; actorId: string }): Promise<void> {
  return db.transaction(async (tx) => {
    const box = await loadShelfBox(tx, input.shelfBoxId);
    await assertActor(tx, input.actorId);
    if (box.status !== "open") throw new HTTPException(409, { message: "shelf_box_not_open" });
    if (box.shelfCode === null) throw new HTTPException(409, { message: "cannot_close_staging_box" });
    const cnt = (
      await queryGet<{ c: number }>(tx, sql`SELECT COUNT(*)::int AS c FROM shelf_box_items WHERE shelf_box_id = ${box.id}`)
    )!.c;
    if (cnt === 0) throw new HTTPException(409, { message: "cannot_close_empty_shelf_box" });
    await queryRun(tx, sql`UPDATE shelf_boxes SET status = 'closed' WHERE id = ${box.id}`);
    await logShelfBox(tx, box.id, "open", "closed", input.actorId);
    const orderId = await boxOrderId(tx, box.id);
    if (orderId) {
      await tryMarkReceivingOrderClear(tx, { receivingOrderId: orderId, actorId: input.actorId });
    }
  });
}
