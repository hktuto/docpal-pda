import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { inventoryTransactions, transactionLogs } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { computeItemShelfSuggestions, type PutAwaySuggestionReason } from "./putaway.js";
import { putAwayConfig, dateCodeFormat } from "../config.js";
import { toCanonicalDateCode } from "./dateCode.js";

// ---------------------------------------------------------------------------
// CN put-away (spec docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md).
// Dedicated variant reading put_away_tasks_cn + receiving_invoice_items_cn,
// gated by the flow-config cnReceiving flag (routes 404 when off). Completion
// writes inventory_lots + a single PUT_AWAY on_hand ledger row per item — CN
// stock never passes through the dock ledger (accepted v1 difference), so
// there is no dock −qty row and no inventory_lot_sources row (its FK targets
// the standard receiving_invoice_items). The CN item id travels in the ledger
// metadata instead; stock-search/allocation see the lot exactly like standard
// put-away output.
// ---------------------------------------------------------------------------

export interface CnPutAwayTaskListRow {
  id: string;
  status: string;
  receivingOrderCnId: string;
  batchNo: string;
  invoiceNos: string | null;
  deliveryDate: Date | null;
  orgId: number | null;
  subInventoryCode: string | null;
  receivedItems: number;
  remainingItems: number;
  createdDate: Date;
}

/** CN task queue, oldest first. Item counts mirror the standard candidates
 *  formula minus the standard-only allocation/staging deductions. No
 *  allowedOrgIds filter — a task row only exists after its order arrived in
 *  this warehouse, so it's always actionable work here. */
export async function listCnPutAwayTasks(db: AppDb, status?: string): Promise<CnPutAwayTaskListRow[]> {
  return queryAll<CnPutAwayTaskListRow>(
    db,
    sql`
      SELECT
        t.id, t.status,
        t.receiving_order_cn_id AS "receivingOrderCnId",
        ro.batch_no AS "batchNo",
        string_agg(DISTINCT ri.invoice_no, ', ') AS "invoiceNos",
        ro.delivery_date AS "deliveryDate",
        t.org_id AS "orgId",
        t.sub_inventory_code AS "subInventoryCode",
        COUNT(rii.id) FILTER (WHERE rii.received_qty > 0)::int AS "receivedItems",
        COUNT(rii.id) FILTER (WHERE rii.received_qty - rii.picked_qty - rii.put_away_qty > 0)::int AS "remainingItems",
        t.created_date AS "createdDate"
      FROM put_away_tasks_cn t
      JOIN receiving_orders_cn ro ON ro.id = t.receiving_order_cn_id
      JOIN receiving_invoices_cn ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items_cn rii ON rii.receiving_invoice_id = ri.id
      WHERE TRUE
      ${status ? sql`AND t.status = ${status}` : sql``}
      GROUP BY t.id, ro.id
      ORDER BY t.created_date ASC, t.id
    `
  );
}

export interface CnPutAwayItemRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  lineQty: number | null;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  remainingQty: number;
  ctnNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  suggestedShelfCode: string | null;
  suggestedBoxId: string | null;
  suggestionReason: PutAwaySuggestionReason | null;
}

export interface CnPutAwayLotRow {
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

export interface CnPutAwayTaskDetail {
  task: { id: string; status: string; receivingOrderCnId: string; createdDate: Date };
  order: {
    id: string;
    batchNo: string;
    status: string;
    deliveryDate: Date | null;
    /** Comma-joined invoice numbers (same string_agg as the task list). */
    invoiceNos: string | null;
    dateCode: string | null;
  };
  items: CnPutAwayItemRow[];
  lots: CnPutAwayLotRow[];
}

/**
 * CN task detail: the order's expected items (remaining = received − picked −
 * put away) with the same advisory shelf/box suggestion ranking the standard
 * detail uses (reused computeItemShelfSuggestions), plus the on-hand lots this
 * order's put-away has created (matched via the ledger reference — CN lots
 * carry no inventory_lot_sources rows).
 */
export async function getCnPutAwayTaskDetail(db: AppDb, taskId: string): Promise<CnPutAwayTaskDetail> {
  const task = await queryGet<CnPutAwayTaskDetail["task"]>(
    db,
    sql`SELECT id, status, receiving_order_cn_id AS "receivingOrderCnId", created_date AS "createdDate"
        FROM put_away_tasks_cn WHERE id = ${taskId}`
  );
  if (!task) throw new HTTPException(404, { message: "put_away_task_cn_not_found" });
  const order = await queryGet<CnPutAwayTaskDetail["order"]>(
    db,
    sql`SELECT ro.id, ro.batch_no AS "batchNo", ro.status, ro.delivery_date AS "deliveryDate",
               ro.date_code AS "dateCode",
               (SELECT string_agg(DISTINCT ri.invoice_no, ', ')
                FROM receiving_invoices_cn ri WHERE ri.receiving_order_id = ro.id) AS "invoiceNos"
        FROM receiving_orders_cn ro WHERE ro.id = ${task.receivingOrderCnId}`
  );
  const rawItems = await queryAll<CnPutAwayItemRow & { itemOrgId: number | null; itemSubInventoryCode: string | null }>(
    db,
    sql`
      SELECT
        rii.id, rii.part_no AS "partNo", rii.wcl_item_no AS "wclItemNo",
        rii.line_qty AS "lineQty", rii.received_qty AS "receivedQty", rii.picked_qty AS "pickedQty",
        rii.put_away_qty AS "putAwayQty",
        (rii.received_qty - rii.picked_qty - rii.put_away_qty)::int AS "remainingQty",
        rii.ctn_no AS "ctnNo", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
        rii.coo, rii.cow,
        rii.org_id AS "itemOrgId", rii.sub_inventory_code AS "itemSubInventoryCode"
      FROM receiving_invoice_items_cn rii
      JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
      WHERE ri.receiving_order_id = ${task.receivingOrderCnId}
      ORDER BY rii.po_no, rii.po_line, rii.id
    `
  );
  const suggestions =
    putAwayConfig().suggestShelf !== "off"
      ? await computeItemShelfSuggestions(db, rawItems)
      : new Map<string, { shelfCode: string | null; boxId: string | null; reason: PutAwaySuggestionReason }>();
  const items: CnPutAwayItemRow[] = rawItems.map((it) => {
    const s = suggestions.get(it.partNo);
    const { itemOrgId: _o, itemSubInventoryCode: _si, ...row } = it;
    return {
      ...row,
      suggestedShelfCode: s?.shelfCode ?? null,
      suggestedBoxId: s?.boxId ?? null,
      suggestionReason: s?.reason ?? null,
    };
  });
  const lots = await queryAll<CnPutAwayLotRow>(
    db,
    sql`
      SELECT DISTINCT
        il.id, il.part_no AS "partNo", il.wcl_item_no AS "wclItemNo",
        il.date_code AS "dateCode", il.lot_code AS "lotCode", il.coo, il.cow,
        il.shelf_code AS "shelfCode", il.box_id AS "boxId",
        il.org_id AS "orgId", il.sub_inventory_code AS "subInventoryCode",
        il.total_qty AS "totalQty", il.allocated_qty AS "allocatedQty",
        il.available_qty AS "availableQty"
      FROM inventory_lots il
      JOIN inventory_transactions it ON it.inventory_lot_id = il.id
      WHERE it.reference_type = 'receiving_order_cn' AND it.reference_id = ${task.receivingOrderCnId}
        AND it.qty_type = 'on_hand' AND it.qty_delta > 0
      ORDER BY il.shelf_code, il.id
    `
  );
  return { task, order: order!, items, lots };
}

// --- completion ---------------------------------------------------------------

export interface CompleteCnPutAwayItemInput {
  itemId: string;
  qty: number;
  shelfCode: string;
  /** Optional scanned physical box QR — the lot's box_id (plain text, no FK). */
  boxId?: string | null;
}

interface CnItemRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  receivingOrderCnId: string;
  received: number;
  picked: number;
  putAway: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
}

async function loadCnItem(tx: DbOrTx, itemId: string): Promise<CnItemRow> {
  const item = await queryGet<CnItemRow>(
    tx,
    sql`SELECT rii.id, rii.part_no AS "partNo", rii.wcl_item_no AS "wclItemNo",
               ri.receiving_order_id AS "receivingOrderCnId",
               rii.received_qty AS "received", rii.picked_qty AS "picked", rii.put_away_qty AS "putAway",
               rii.date_code AS "dateCode", rii.lot_code AS "lotCode", rii.coo, rii.cow,
               rii.org_id AS "orgId", rii.sub_inventory_code AS "subInventoryCode"
        FROM receiving_invoice_items_cn rii
        JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
        WHERE rii.id = ${itemId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving_invoice_item_cn_not_found" });
  return item;
}

/**
 * Complete CN put-away items in one tx: per item a guarded put_away_qty update,
 * an inventory_lots upsert keyed like the standard lot (part + batch attrs +
 * shelf + box + location pair — the pair from the ITEM, CN tasks have no shelf
 * box carrying one) and one PUT_AWAY on_hand ledger row referencing the CN
 * order. When every item is fully put away the task (and the order, mirroring
 * the standard auto-clear) complete with audit logs + SSE. The caller commits
 * and then schedules the allocation recompute.
 */
export async function completeCnPutAwayTx(
  tx: DbOrTx,
  input: { taskId: string; items: CompleteCnPutAwayItemInput[]; actorId: string }
): Promise<{ taskCompleted: boolean }> {
  const task = await queryGet<{ id: string; status: string; receivingOrderCnId: string }>(
    tx,
    sql`SELECT id, status, receiving_order_cn_id AS "receivingOrderCnId"
        FROM put_away_tasks_cn WHERE id = ${input.taskId}`
  );
  if (!task) throw new HTTPException(404, { message: "put_away_task_cn_not_found" });
  if (task.status !== "pending") throw new HTTPException(409, { message: "put_away_task_cn_not_pending" });
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new HTTPException(400, { message: "items must be a non-empty array" });
  }
  const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${input.actorId}`);
  if (!actor) throw new HTTPException(400, { message: "actor_not_found" });

  const at = now();
  for (const entry of input.items) {
    const item = await loadCnItem(tx, entry.itemId);
    if (item.receivingOrderCnId !== task.receivingOrderCnId) {
      throw new HTTPException(404, { message: "receiving_invoice_item_cn_not_found" });
    }
    if (!Number.isInteger(entry.qty) || entry.qty <= 0) {
      throw new HTTPException(400, { message: "qty_must_be_positive_integer" });
    }
    const remaining = item.received - item.picked - item.putAway;
    if (entry.qty > remaining) throw new HTTPException(409, { message: "scanned_qty_exceeds_remaining" });
    const shelf = await queryGet<{ code: string }>(tx, sql`SELECT code FROM shelves WHERE code = ${entry.shelfCode}`);
    if (!shelf) throw new HTTPException(404, { message: "shelf_not_found" });
    const boxId = entry.boxId?.trim() || null;

    // The lot's wcl_item_no is the parts-master value (stock search joins
    // parts ON p.wcl_item_no = il.wcl_item_no); fall back to the item's copy.
    const partWclItemNo =
      (
        await queryGet<{ wclItemNo: string | null }>(
          tx,
          sql`SELECT wcl_item_no AS "wclItemNo" FROM parts WHERE part_no = ${item.partNo} LIMIT 1`
        )
      )?.wclItemNo ?? item.wclItemNo;

    // Enclave → canonical: the CN item's date code stays in the label format;
    // the lot stores canonical YYWW (spec 2026-10-22-datecode-format-config-design.md).
    const canonicalDateCode = toCanonicalDateCode(item.dateCode, dateCodeFormat());

    // Lot upsert mirrors assignScanToBoxTx's key, with the location pair from
    // the CN item (a CN lot has no shelf box to stamp from).
    const lot = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM inventory_lots
          WHERE part_no = ${item.partNo} AND shelf_code = ${entry.shelfCode} AND box_id IS NOT DISTINCT FROM ${boxId}
            AND date_code IS NOT DISTINCT FROM ${canonicalDateCode}
            AND lot_code IS NOT DISTINCT FROM ${item.lotCode}
            AND coo IS NOT DISTINCT FROM ${item.coo}
            AND cow IS NOT DISTINCT FROM ${item.cow}
            AND org_id IS NOT DISTINCT FROM ${item.orgId}
            AND sub_inventory_code IS NOT DISTINCT FROM ${item.subInventoryCode}`
    );
    let lotId: string;
    if (lot) {
      lotId = lot.id;
      await queryRun(
        tx,
        sql`UPDATE inventory_lots
            SET total_qty = total_qty + ${entry.qty},
                wcl_item_no = COALESCE(wcl_item_no, ${partWclItemNo})
            WHERE id = ${lotId}`
      );
    } else {
      lotId = newId();
      await queryRun(
        tx,
        sql`INSERT INTO inventory_lots (id, part_no, wcl_item_no, date_code, lot_code, coo, cow, shelf_code, box_id,
                                       org_id, sub_inventory_code, total_qty, allocated_qty)
            VALUES (${lotId}, ${item.partNo}, ${partWclItemNo}, ${canonicalDateCode}, ${item.lotCode}, ${item.coo}, ${item.cow},
                    ${entry.shelfCode}, ${boxId}, ${item.orgId}, ${item.subInventoryCode},
                    ${entry.qty}, 0)`
      );
    }

    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items_cn SET put_away_qty = put_away_qty + ${entry.qty} WHERE id = ${item.id}`
    );

    // CN put-away writes on-hand stock only (no dock ledger in the CN path);
    // receiving_invoice_item_id stays NULL (its FK targets the standard
    // items table) — the CN item id rides in metadata.
    await tx.insert(inventoryTransactions).values({
      id: newId(),
      inventoryLotId: lotId,
      partNo: item.partNo,
      shelfCode: entry.shelfCode,
      boxId,
      txnType: "PUT_AWAY",
      qtyType: "on_hand",
      qtyDelta: entry.qty,
      dateCode: canonicalDateCode,
      lotCode: item.lotCode,
      coo: item.coo,
      cow: item.cow,
      referenceType: "receiving_order_cn",
      referenceId: task.receivingOrderCnId,
      actorId: input.actorId,
      txnReason: "put away (cn)",
      metadata: { receivingInvoiceItemCnId: item.id, putAwayTaskCnId: task.id },
      txnAt: at,
    });
  }

  // Task completion check: every item fully put away (mirrors the standard
  // remaining ≤ 0 rule; no allocation/staging deductions in the CN world).
  const remainingRows = await queryAll<{ n: number }>(
    tx,
    sql`SELECT COUNT(*)::int AS n
        FROM receiving_invoice_items_cn rii
        JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${task.receivingOrderCnId}
          AND rii.received_qty - rii.picked_qty - rii.put_away_qty > 0`
  );
  if ((remainingRows[0]?.n ?? 0) > 0) return { taskCompleted: false };

  await queryRun(
    tx,
    sql`UPDATE put_away_tasks_cn SET status = 'completed', last_update_date = ${at} WHERE id = ${task.id}`
  );
  await tx.insert(transactionLogs).values({
    id: newId(),
    entityType: "put_away_task_cn",
    entityId: task.id,
    fromState: "pending",
    toState: "completed",
    actorId: input.actorId,
    createdDate: at,
  });
  // Mirror the standard auto-clear: a fully put-away CN order goes 'clear'.
  const order = await queryGet<{ status: string }>(
    tx,
    sql`SELECT status FROM receiving_orders_cn WHERE id = ${task.receivingOrderCnId}`
  );
  if (order && order.status === "in_hand") {
    await queryRun(
      tx,
      sql`UPDATE receiving_orders_cn SET status = 'clear', last_update_date = ${at} WHERE id = ${task.receivingOrderCnId}`
    );
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "receiving_order_cn",
      entityId: task.receivingOrderCnId,
      fromState: "in_hand",
      toState: "clear",
      actorId: input.actorId,
      createdDate: at,
    });
  }
  await emitEvent(tx, {
    type: "put_away_task_cn.completed",
    topics: ["/put-away-cn-tasks", "/put-away-tasks"],
    data: { taskId: task.id, receivingOrderCnId: task.receivingOrderCnId },
  });
  return { taskCompleted: true };
}
