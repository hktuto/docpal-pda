import { newId } from "./id.js";
import { HTTPException } from "hono/http-exception";
import { inArray, sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { transactionLogs, inventoryTransactions } from "./schema/index.js";
import { nextBoxId } from "./boxes.js";
import { now } from "./now.js";
import { completePutAwayTaskTx } from "./putawaytasks.js";
import { putAwayConfig, receivingOrderNameTemplate } from "../config.js";
import { formatReceivingOrderName } from "../receivingOrderName.js";
import { allowedOrgFilter } from "./org-filter.js";
import {
  checkOutdatedDateCode,
  recordOutdatedWarning,
  unresolvedOutdatedWarningCount,
  type OutdatedWarningInfo,
} from "./outdated.js";

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

/** Find-or-create the order's shelf box on a shelf (the shelf-direct flow's
 *  invisible box — spec 2026-10-06): the open box on this shelf holding this
 *  order's items → reuse; any empty open box on the shelf → adopt (refresh
 *  its pair from the order); else create (order pair, open transition log
 *  with {order} metadata so boxOrderId resolves while empty). */
async function ensureOrderShelfBoxTx(tx: DbOrTx, receivingOrderId: string, shelfCode: string): Promise<string> {
  const shelf = await queryGet<{ code: string }>(tx, sql`SELECT code FROM shelves WHERE code = ${shelfCode}`);
  if (!shelf) throw new HTTPException(404, { message: "shelf_not_found" });
  const pair = await orderPair(tx, receivingOrderId);
  const existing = await queryGet<{ id: string }>(
    tx,
    sql`SELECT sb.id FROM shelf_boxes sb
        WHERE sb.shelf_code = ${shelfCode} AND sb.status = 'open'
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
    // An adopted empty box takes this order's pair (informational only; lots
    // are stamped from the box at assign time).
    await queryRun(
      tx,
      sql`UPDATE shelf_boxes SET org_id = ${pair.orgId}, sub_inventory_code = ${pair.subInventoryCode} WHERE id = ${existing.id}`
    );
    return existing.id;
  }
  const id = await nextBoxId(tx, "H");
  await queryRun(
    tx,
    sql`INSERT INTO shelf_boxes (id, shelf_code, org_id, sub_inventory_code, status, created_date)
        VALUES (${id}, ${shelfCode}, ${pair.orgId}, ${pair.subInventoryCode}, 'open', ${now()})`
  );
  await logShelfBox(tx, id, null, "open", null, { order: receivingOrderId, shelf: shelfCode });
  return id;
}

/**
 * The receiving order's stock location pair, derived from its items
 * (receiving_invoice_items.org_id + sub_inventory_code — order-level
 * partitioning is gone since 2026-08-18). Uniform pair across the order's
 * items → that pair; mixed pairs (or no items) → both NULL. A uniform pair
 * with a NULL component comes back as-is (box pair stamps accept NULL).
 */
export async function orderPair(tx: DbOrTx, receivingOrderId: string): Promise<{ orgId: number | null; subInventoryCode: string | null }> {
  const rows = await queryAll<{ orgId: number | null; subInventoryCode: string | null }>(
    tx,
    sql`SELECT DISTINCT rii.org_id AS "orgId", rii.sub_inventory_code AS "subInventoryCode"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${receivingOrderId}`
  );
  if (rows.length === 1) return rows[0];
  return { orgId: null, subInventoryCode: null };
}

interface PutAwayItemRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
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
    sql`SELECT rii.id, rii.part_no AS "partNo", rii.wcl_item_no AS "wclItemNo", ri.receiving_order_id AS "receivingOrderId",
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
 * Held (no transition, no task completion) while the order has unresolved
 * outdated-scan warnings — an admin resolve-order re-runs this check via
 * retryReceivingOrderClear (spec 2026-10-07).
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
  if ((await unresolvedOutdatedWarningCount(tx, "putaway", order.id)) > 0) return;
  const items = await queryAll<PutAwayItemRow>(
    tx,
    sql`SELECT rii.id, rii.part_no AS "partNo", rii.wcl_item_no AS "wclItemNo", ri.receiving_order_id AS "receivingOrderId",
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

/**
 * Post-resolution re-check (spec 2026-10-07): after an admin resolves the
 * order's outdated warnings, run the auto-clear check again (it was held
 * while warnings were unresolved).
 */
export async function retryReceivingOrderClear(
  db: AppDb,
  input: { receivingOrderId: string; actorId: string | null }
): Promise<void> {
  return db.transaction((tx) => tryMarkReceivingOrderClear(tx, input));
}

// ---------------------------------------------------------------------------
// Reads (called by the routes; kept here so tests can exercise them).
// ---------------------------------------------------------------------------

export interface PutAwayCandidateRow {
  id: string;
  batchNo: string;
  /** Order name per the receivingOrderNameTemplate flow config ([name] on the
   *  put-away PDA list). */
  displayName: string;
  status: string;
  supplierCode: string | null;
  supplierName: string | null;
  invoiceNos: string | null;
  deliveryDate: Date | null;
  dateCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  receivedItems: number;
  unboxedItems: number;
  /** Unresolved outdated-scan warnings (spec 2026-10-07); 0 = none. */
  outdatedWarningCount: number;
}

/** Receivable orders (in_hand / provisional_received) with per-order item counts. */
export async function listPutAwayCandidates(db: AppDb): Promise<PutAwayCandidateRow[]> {
  const rows = await queryAll<Omit<PutAwayCandidateRow, "displayName">>(
    db,
    sql`
      SELECT
        ro.id,
        ro.batch_no AS "batchNo",
        ro.status,
        s.code AS "supplierCode",
        s.name AS "supplierName",
        string_agg(DISTINCT ri.invoice_no, ', ') AS "invoiceNos",
        ro.delivery_date AS "deliveryDate",
        ro.date_code AS "dateCode",
        pair."orgId" AS "orgId",
        pair."subInventoryCode" AS "subInventoryCode",
        COUNT(rii.id) FILTER (WHERE rii.received_qty > 0)::int AS "receivedItems",
        COUNT(rii.id) FILTER (WHERE
          rii.received_qty - rii.picked_qty - rii.put_away_qty
            - COALESCE(alloc.qty, 0) - COALESCE(staged.qty, 0) > 0)::int AS "unboxedItems",
        (SELECT COUNT(*)::int FROM outdated_scan_warnings osw
         WHERE osw.order_kind = 'putaway' AND osw.order_id = ro.id AND osw.resolved_at IS NULL) AS "outdatedWarningCount"
      FROM receiving_orders ro
      LEFT JOIN suppliers s ON s.code = ro.supplier_code
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      -- item-derived pair: the single DISTINCT item pair, NULL when mixed
      LEFT JOIN LATERAL (
        SELECT CASE WHEN COUNT(*) = 1 THEN MAX(p.org_id) END AS "orgId",
               CASE WHEN COUNT(*) = 1 THEN MAX(p.sub_inventory_code) END AS "subInventoryCode"
        FROM (
          SELECT DISTINCT rii2.org_id, rii2.sub_inventory_code
          FROM receiving_invoice_items rii2
          JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
          WHERE ri2.receiving_order_id = ro.id
        ) p
      ) pair ON true
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
      ${allowedOrgFilter(sql`ro.org_id`)}
      GROUP BY ro.id, s.id, pair."orgId", pair."subInventoryCode"
      ORDER BY ro.created_date DESC
    `
  );
  const nameTemplate = receivingOrderNameTemplate();
  return rows.map((row) => ({
    ...row,
    displayName: formatReceivingOrderName(
      {
        batchNo: row.batchNo,
        invoiceNo: row.invoiceNos,
        supplierCode: row.supplierCode,
        supplierName: row.supplierName,
        deliveryDate: row.deliveryDate,
        dateCode: row.dateCode,
      },
      nameTemplate
    ),
  }));
}

export interface PutAwayLotRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
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
  wclItemNo: string | null;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  /** The shelf the scan is committed to; NULL = still pending (staging). */
  shelfCode: string | null;
  /** The (invisible) shelf box holding the committed scan; NULL when pending. */
  boxId: string | null;
}

export interface PutAwayBoxItemRow {
  id: string;
  receivingInvoiceItemId: string | null;
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  verified: boolean | null;
  verifiedAt: Date | null;
}

export type PutAwaySuggestionReason = "same-part-box" | "same-part-stock" | "sub-inventory-shelf";

export interface PutAwayExpectedItemRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  lineQty: number | null;
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
  /** Unresolved outdated-scan warnings on the order (spec 2026-10-07); 0 = none. */
  outdatedWarningCount: number;
  items: PutAwayExpectedItemRow[];
  lots: PutAwayLotRow[];
  scans: PutAwayScanRow[];
  /** The order's open staging box (shelf_code IS NULL) holding its scans, when
   *  one exists — lets the PDA recognize a scan of the staging box's own QR
   *  label instead of treating it as an unknown box id. */
  stagingBoxId: string | null;
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
 * inventory_lot_sources), ALL scans of the order (pending scans carry
 * shelfCode NULL; committed scans carry their shelf + box), and the
 * non-staging boxes with their item rows.
 */
export async function getPutAwayAggregate(db: AppDb, orderId: string): Promise<PutAwayAggregate> {
  const order = await queryGet<{ id: string; batchNo: string; status: string; outdatedWarningCount: number }>(
    db,
    sql`SELECT id, batch_no AS "batchNo", status,
               (SELECT COUNT(*)::int FROM outdated_scan_warnings osw
                WHERE osw.order_kind = 'putaway' AND osw.order_id = ro.id AND osw.resolved_at IS NULL) AS "outdatedWarningCount"
        FROM receiving_orders ro WHERE id = ${orderId}`
  );
  if (!order) throw new HTTPException(404, { message: "receiving_order_not_found" });

  const lots = await queryAll<PutAwayLotRow>(
    db,
    sql`
      SELECT DISTINCT
        il.id, il.part_no AS "partNo",
        COALESCE(il.wcl_item_no, rii.wcl_item_no) AS "wclItemNo",
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
  // item list. Each row also carries the item's own location pair (used for
  // the per-item shelf suggestion below; stripped from the response rows).
  const items = await queryAll<PutAwayExpectedItemRow & { itemOrgId: number | null; itemSubInventoryCode: string | null }>(
    db,
    sql`
      SELECT
        rii.id, rii.part_no AS "partNo", rii.wcl_item_no AS "wclItemNo",
        rii.line_qty AS "lineQty", rii.received_qty AS "receivedQty", rii.picked_qty AS "pickedQty",
        rii.put_away_qty AS "putAwayQty",
        COALESCE(alloc.qty, 0)::int AS "allocatedQty",
        (rii.received_qty - rii.picked_qty - rii.put_away_qty
          - COALESCE(alloc.qty, 0) - COALESCE(staged.qty, 0))::int AS "remainingQty",
        rii.date_code AS "dateCode", rii.lot_code AS "lotCode", rii.coo, rii.cow,
        rii.org_id AS "itemOrgId", rii.sub_inventory_code AS "itemSubInventoryCode"
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

  // Per-item shelf/box suggestion, ranked within the ITEM's org +
  // sub-inventory (item-level partitioning since 2026-08-18; same rules as
  // the put-away task detail). Advisory, computed at read time, never stored;
  // all null when the item's pair is NULL or suggestShelf is "off".
  const suggestions =
    putAwayConfig().suggestShelf !== "off"
      ? await computeItemShelfSuggestions(db, items)
      : new Map<string, ShelfSuggestion>();
  const itemsWithSuggestions: PutAwayExpectedItemRow[] = items.map((it) => {
    const s = suggestions.get(it.partNo);
    const { itemOrgId: _o, itemSubInventoryCode: _si, ...row } = it;
    return {
      ...row,
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
        sbi.part_no AS "partNo", COALESCE(sbi.wcl_item_no, rii.wcl_item_no) AS "wclItemNo", sbi.qty,
        rii.date_code AS "dateCode", rii.lot_code AS "lotCode", rii.coo, rii.cow,
        sb.shelf_code AS "shelfCode",
        CASE WHEN sb.shelf_code IS NULL THEN NULL ELSE sb.id END AS "boxId"
      FROM shelf_box_items sbi
      JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
      JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE ri.receiving_order_id = ${orderId}
      ORDER BY (sb.shelf_code IS NOT NULL), sbi.id
    `
  );

  const stagingBox = await queryGet<{ id: string }>(
    db,
    sql`
      SELECT sb.id FROM shelf_boxes sb
      WHERE sb.shelf_code IS NULL AND sb.status = 'open'
        AND EXISTS (
          SELECT 1 FROM shelf_box_items sbi
          JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE sbi.shelf_box_id = sb.id AND ri.receiving_order_id = ${orderId}
        )
      ORDER BY sb.created_date
      LIMIT 1
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
            sbi.part_no AS "partNo", COALESCE(sbi.wcl_item_no, rii.wcl_item_no) AS "wclItemNo", sbi.qty,
            sbi.verified, sbi.verified_at AS "verifiedAt"
          FROM shelf_box_items sbi
          LEFT JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
          WHERE ${inArray(sql`sbi.shelf_box_id`, boxIds)}
          ORDER BY sbi.id
        `
      )
    : [];

  return {
    order: { id: order.id, batchNo: order.batchNo, status: order.status },
    outdatedWarningCount: order.outdatedWarningCount,
    items: itemsWithSuggestions,
    lots,
    scans,
    stagingBoxId: stagingBox?.id ?? null,
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
 * Shelf/box suggestions per part_no, ranked within the given org +
 * sub-inventory pair (spec 2026-08-12-put-away-shelf-org-suggestion-design.md):
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
  //    (affinity pairs are org-scoped: sub-inventory codes repeat across orgs)
  const missing = partNos.filter((p) => !suggestions.has(p));
  if (missing.length > 0) {
    const taggedShelf = await queryGet<{ code: string }>(
      db,
      sql`SELECT code FROM shelves
          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(sub_inventory_scopes) e
                        WHERE (e->>'orgId')::int = ${orgId} AND e->>'code' = ${subInventoryCode})
          ORDER BY code LIMIT 1`
    );
    if (taggedShelf) {
      for (const p of missing) suggestions.set(p, { shelfCode: taggedShelf.code, boxId: null, reason: "sub-inventory-shelf" });
    }
  }
  return suggestions;
}

/**
 * Suggestions for the aggregate's expected items: items are grouped by their
 * own location pair (item-level partitioning since 2026-08-18) and each group
 * is ranked within that pair; items with a NULL pair get no suggestion.
 */
export async function computeItemShelfSuggestions(
  db: AppDb,
  items: { partNo: string; itemOrgId: number | null; itemSubInventoryCode: string | null }[]
): Promise<Map<string, ShelfSuggestion>> {
  const byPair = new Map<string, { orgId: number; subInventoryCode: string; partNos: Set<string> }>();
  for (const it of items) {
    if (it.itemOrgId === null || it.itemSubInventoryCode === null) continue;
    const key = `${it.itemOrgId}|${it.itemSubInventoryCode}`;
    let group = byPair.get(key);
    if (!group) {
      group = { orgId: it.itemOrgId, subInventoryCode: it.itemSubInventoryCode, partNos: new Set() };
      byPair.set(key, group);
    }
    group.partNos.add(it.partNo);
  }
  const suggestions = new Map<string, ShelfSuggestion>();
  for (const group of byPair.values()) {
    const groupSuggestions = await computeShelfSuggestions(db, [...group.partNos], group.orgId, group.subInventoryCode);
    for (const [partNo, s] of groupSuggestions) {
      if (!suggestions.has(partNo)) suggestions.set(partNo, s);
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
  /** Shelf-direct flow (spec 2026-10-06): commit straight onto this shelf —
   *  the order's box there is found-or-created invisibly. Mutually exclusive
   *  with `shelfBoxId`; null/absent = stay pending in staging. */
  shelfCode?: string | null;
  /** Supplier-label serial (e.g. iC-Haus LTS): unique per item in the order —
   *  a repeat serial on the same receiving order is a double-scan of the same
   *  physical label and rejected with 409 label_already_scanned. */
  serialNo?: string | null;
}

/**
 * Record one staging scan: stamps the invoice item's batch attributes with
 * the scan's values when provided (later scans can correct earlier ones; a
 * null field keeps the current value — the RII row is the batch source of
 * truth) and inserts a
 * shelf_box_items row into the order's staging box. Guarded by the remaining
 * qty (received − picked − put away − allocated − staged). With `shelfBoxId`
 * the scan is immediately assigned into that open box in the same tx
 * (lot + ledger included); otherwise no ledger rows — nothing moved physically.
 */
export async function recordPutAwayScan(
  db: AppDb,
  orderId: string,
  input: RecordPutAwayScanInput
): Promise<PutAwayScanRow & { outdatedWarning: OutdatedWarningInfo | null }> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string; supplierCode: string | null }>(
      tx,
      sql`SELECT id, supplier_code AS "supplierCode" FROM receiving_orders WHERE id = ${orderId}`
    );
    if (!order) throw new HTTPException(404, { message: "receiving_order_not_found" });
    if (input.shelfBoxId && input.shelfCode) {
      throw new HTTPException(400, { message: "both_shelf_box_and_shelf_code" });
    }
    await assertActor(tx, input.actorId);
    const item = await loadItemForPutAway(tx, input.receivingInvoiceItemId);
    if (item.receivingOrderId !== orderId) {
      throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
    }
    if (!Number.isInteger(input.qty) || input.qty <= 0) {
      throw new HTTPException(400, { message: "qty_must_be_positive_integer" });
    }
    // Serial dedup pre-check (mirrors the receiving S-key check): a serial
    // already scanned on this order is a double-scan of the same physical
    // label — reject before the qty guard so the operator gets the specific
    // error. Deleting the scan frees the serial again.
    const serialNo = input.serialNo?.trim() || null;
    if (serialNo) {
      const dup = await queryGet<{ id: string }>(
        tx,
        sql`SELECT sbi.id FROM shelf_box_items sbi
            JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
            JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
            WHERE ri.receiving_order_id = ${orderId} AND sbi.serial_no = ${serialNo}
            LIMIT 1`
      );
      if (dup) throw new HTTPException(409, { message: "label_already_scanned" });
    }
    const remaining = await remainingAfterStaged(tx, item);
    if (input.qty > remaining) throw new HTTPException(409, { message: "scanned_qty_exceeds_remaining" });

    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items
          SET date_code = COALESCE(${input.dateCode ?? null}, date_code),
              lot_code = COALESCE(${input.lotCode ?? null}, lot_code),
              coo = COALESCE(${input.coo ?? null}, coo),
              cow = COALESCE(${input.cow ?? null}, cow)
          WHERE id = ${item.id}`
    );

    const stagingBoxId = await ensureStagingBox(tx, item.receivingOrderId);
    const id = newId();
    await queryRun(
      tx,
      sql`INSERT INTO shelf_box_items (id, shelf_box_id, receiving_invoice_item_id, part_no, wcl_item_no, qty, verified, serial_no)
          VALUES (${id}, ${stagingBoxId}, ${item.id}, ${item.partNo}, ${item.wclItemNo}, ${input.qty}, false, ${serialNo})`
    );
    // Auto-put: with a shelfCode the order's box on that shelf is found-or-
    // created invisibly (shelf-direct flow); with shelfBoxId the caller names
    // the box (legacy/admin). Either way the assign runs in the same tx
    // (guards/materialization/ledger/auto-clear reused; a guard failure rolls
    // back the staging insert too).
    const targetBoxId = input.shelfCode
      ? await ensureOrderShelfBoxTx(tx, orderId, input.shelfCode)
      : (input.shelfBoxId ?? null);
    if (targetBoxId) {
      await assignScanToBoxTx(tx, { scanId: id, shelfBoxId: targetBoxId, actorId: input.actorId });
    }

    // Supplier outdated date-code check (spec 2026-10-07): the scan succeeds
    // regardless — a hit records the warning row in this tx and rides on the
    // response for the PDA alert. Supplier = the receiving order's
    // supplier_code; the label's own date code is checked (none = no check).
    let outdatedWarning: OutdatedWarningInfo | null = null;
    const outdatedHit = await checkOutdatedDateCode(tx, { supplierCode: order.supplierCode, dateCode: input.dateCode });
    if (outdatedHit) {
      outdatedWarning = await recordOutdatedWarning(tx, {
        orderKind: "putaway",
        orderId: order.id,
        orderItemId: item.id,
        packageId: id,
        supplierCode: order.supplierCode!,
        wclItemNo: item.wclItemNo,
        partNo: item.partNo,
        dateCode: input.dateCode!,
        limitMonths: outdatedHit.limitMonths,
        qty: input.qty,
        scannedBy: input.actorId,
      });
    }

    const row = await queryGet<PutAwayScanRow>(
      tx,
      sql`SELECT sbi.id, sbi.receiving_invoice_item_id AS "receivingInvoiceItemId",
                 sbi.part_no AS "partNo", sbi.qty,
                 rii.date_code AS "dateCode", rii.lot_code AS "lotCode", rii.coo, rii.cow,
                 NULL AS "shelfCode", NULL AS "boxId"
          FROM shelf_box_items sbi
          JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
          WHERE sbi.id = ${id}`
    );
    return { ...row!, outdatedWarning };
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

  // The lot's wcl_item_no is the parts-master value (stock search joins
  // parts ON p.wcl_item_no = il.wcl_item_no); fall back to the item's copy.
  const partWclItemNo =
    (
      await queryGet<{ wclItemNo: string | null }>(
        tx,
        sql`SELECT wcl_item_no AS "wclItemNo" FROM parts WHERE part_no = ${item.partNo} LIMIT 1`
      )
    )?.wclItemNo ?? item.wclItemNo;

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
    await queryRun(
      tx,
      sql`UPDATE inventory_lots
          SET total_qty = total_qty + ${scan.qty},
              wcl_item_no = COALESCE(wcl_item_no, ${partWclItemNo})
          WHERE id = ${lotId}`
    );
  } else {
    lotId = newId();
    await queryRun(
      tx,
      sql`INSERT INTO inventory_lots (id, part_no, wcl_item_no, date_code, lot_code, coo, cow, shelf_code, box_id,
                                     org_id, sub_inventory_code, total_qty, allocated_qty)
          VALUES (${lotId}, ${item.partNo}, ${partWclItemNo}, ${item.dateCode}, ${item.lotCode}, ${item.coo}, ${item.cow},
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
 * ledger rows, and runs the auto-clear check. The caller schedules the
 * allocation recompute after commit.
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

/**
 * Shelf-direct commit (spec 2026-10-06): assign every pending (staging) scan
 * of the order onto the shelf in ONE transaction — the order's box there is
 * found-or-created invisibly. `scanIds` (when given) restricts the commit to
 * those staging rows (the pending list's per-row "Add to shelf"). Returns
 * {count, qty}; count 0 is a valid empty result (e.g. a concurrent device
 * committed first), not an error. A mid-loop guard failure (e.g.
 * lot_has_pick_allocations) rolls the whole commit back. Unresolved outdated-
 * scan warnings do NOT block the commit — they hold the order's transition to
 * 'clear' instead (tryMarkReceivingOrderClear, spec 2026-10-07).
 */
export async function commitPendingScansToShelf(
  db: AppDb,
  orderId: string,
  input: { actorId: string; shelfCode: string; scanIds?: string[] }
): Promise<{ count: number; qty: number }> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string }>(tx, sql`SELECT id FROM receiving_orders WHERE id = ${orderId}`);
    if (!order) throw new HTTPException(404, { message: "receiving_order_not_found" });
    await assertActor(tx, input.actorId);
    const boxId = await ensureOrderShelfBoxTx(tx, orderId, input.shelfCode);
    let scans = await queryAll<{ id: string; qty: number }>(
      tx,
      sql`SELECT sbi.id, sbi.qty
          FROM shelf_box_items sbi
          JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
          JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE sb.shelf_code IS NULL AND sb.status = 'open'
            AND ri.receiving_order_id = ${orderId}`
    );
    if (input.scanIds?.length) {
      const allow = new Set(input.scanIds);
      scans = scans.filter((s) => allow.has(s.id));
    }
    let qty = 0;
    for (const scan of scans) {
      await assignScanToBoxTx(tx, { scanId: scan.id, shelfBoxId: boxId, actorId: input.actorId });
      qty += scan.qty;
    }
    return { count: scans.length, qty };
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
 * 409 when the lot has pick allocations. The caller schedules the allocation
 * recompute after commit.
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
