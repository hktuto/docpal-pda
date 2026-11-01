import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { queryAll, queryGet, queryRun } from "./query.js";
import { transactionLogs } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { cnOrderPair } from "./receivingCn.js";

// ---------------------------------------------------------------------------
// CN receiving scan task (PDF path) — spec
// docs/superpowers/plans/2026-11-01-cn-receiving-scan.md. The admin confirm /
// workflow finalize moves a CN order to `scanning`; the PDA 收貨掃描 task then
// resolves each item against the physical goods (scan → ok / qty-mismatch
// warning, flag → error) and finalize receives only the clean items:
// ok items get received_qty = scan_qty, warning/error items stay at 0 so the
// CN put-away (remaining = received − picked − put_away) naturally excludes
// them. Manual receipts bypass this step entirely.
// ---------------------------------------------------------------------------

export interface CnScanTaskRow {
  id: string;
  batchNo: string;
  invoiceNos: string | null;
  deliveryDate: Date | null;
  orgId: number;
  itemCount: number;
  resolvedCount: number;
  createdDate: Date;
}

/** Scan-task queue: CN orders at `scanning`, oldest first. */
export async function listCnScanTasks(db: AppDb): Promise<CnScanTaskRow[]> {
  return queryAll<CnScanTaskRow>(
    db,
    sql`
      SELECT
        ro.id, ro.batch_no AS "batchNo",
        string_agg(DISTINCT ri.invoice_no, ', ') AS "invoiceNos",
        ro.delivery_date AS "deliveryDate",
        ro.org_id AS "orgId",
        COUNT(rii.id)::int AS "itemCount",
        COUNT(rii.id) FILTER (WHERE rii.scan_status IS NOT NULL)::int AS "resolvedCount",
        ro.created_date AS "createdDate"
      FROM receiving_orders_cn ro
      JOIN receiving_invoices_cn ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items_cn rii ON rii.receiving_invoice_id = ri.id
      WHERE ro.status = 'scanning'
      GROUP BY ro.id
      ORDER BY ro.created_date ASC, ro.id
    `
  );
}

export interface CnScanItemRow {
  id: string;
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  lineQty: number | null;
  ctnNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  orgId: number;
  subInventoryCode: string | null;
  scanStatus: string | null;
  scanQty: number | null;
  scanReason: string | null;
  scanNote: string | null;
  scannedAt: Date | null;
  scannedBy: string | null;
}

const CN_SCAN_ITEM_SELECT = sql`
  SELECT
    rii.id, rii.part_no AS "partNo", rii.wcl_item_no AS "wclItemNo",
    rii.po_no AS "poNo", rii.po_line AS "poLine", rii.line_qty AS "lineQty",
    rii.ctn_no AS "ctnNo", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
    rii.coo, rii.cow, rii.org_id AS "orgId", rii.sub_inventory_code AS "subInventoryCode",
    rii.scan_status AS "scanStatus", rii.scan_qty AS "scanQty",
    rii.scan_reason AS "scanReason", rii.scan_note AS "scanNote",
    rii.scanned_at AS "scannedAt", rii.scanned_by AS "scannedBy"
  FROM receiving_invoice_items_cn rii
  JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
`;

interface CnScanningOrder {
  id: string;
  batchNo: string;
  status: string;
  orgId: number;
  deliveryDate: Date | null;
  dateCode: string | null;
}

async function loadCnOrder(db: AppDb, orderId: string): Promise<CnScanningOrder | null> {
  const row = await queryGet<CnScanningOrder>(
    db,
    sql`SELECT id, batch_no AS "batchNo", status, org_id AS "orgId",
               delivery_date AS "deliveryDate", date_code AS "dateCode"
        FROM receiving_orders_cn WHERE id = ${orderId}`
  );
  return row ?? null;
}

export interface CnScanTaskDetail {
  order: {
    id: string;
    batchNo: string;
    status: string;
    deliveryDate: Date | null;
    invoiceNos: string | null;
    dateCode: string | null;
  };
  items: CnScanItemRow[];
}

/** One scan task: order + all items with their scan fields. 404
 *  receiving_cn_scan_task_not_found unless the order is `scanning`. */
export async function getCnScanTaskDetail(db: AppDb, orderId: string): Promise<CnScanTaskDetail> {
  const order = await loadCnOrder(db, orderId);
  if (!order || order.status !== "scanning") {
    throw new HTTPException(404, { message: "receiving_cn_scan_task_not_found" });
  }
  const invoiceNos = (
    await queryGet<{ invoiceNos: string | null }>(
      db,
      sql`SELECT string_agg(DISTINCT invoice_no, ', ') AS "invoiceNos"
          FROM receiving_invoices_cn WHERE receiving_order_id = ${order.id}`
    )
  )?.invoiceNos ?? null;
  const items = await queryAll<CnScanItemRow>(
    db,
    sql`${CN_SCAN_ITEM_SELECT} WHERE ri.receiving_order_id = ${order.id}
        ORDER BY rii.po_no, rii.po_line, rii.id`
  );
  return {
    order: {
      id: order.id,
      batchNo: order.batchNo,
      status: order.status,
      deliveryDate: order.deliveryDate,
      invoiceNos,
      dateCode: order.dateCode,
    },
    items,
  };
}

// --- per-item mutations -----------------------------------------------------

/** Order must exist and be `scanning`; the item must belong to it. Returns
 *  both for the mutation body. */
async function loadScanningItem(
  tx: AppDb,
  orderId: string,
  itemId: string
): Promise<{ order: CnScanningOrder; item: { id: string; partNo: string; lineQty: number | null } }> {
  const order = await loadCnOrder(tx, orderId);
  if (!order) throw new HTTPException(404, { message: "receiving_cn_scan_task_not_found" });
  if (order.status !== "scanning") throw new HTTPException(409, { message: "order_not_scanning" });
  const item = await queryGet<{ id: string; partNo: string; lineQty: number | null }>(
    tx,
    sql`SELECT rii.id, rii.part_no AS "partNo", rii.line_qty AS "lineQty"
        FROM receiving_invoice_items_cn rii
        JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
        WHERE rii.id = ${itemId} AND ri.receiving_order_id = ${orderId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving_invoice_item_cn_not_found" });
  return { order, item };
}

async function itemAudit(
  tx: AppDb,
  item: { id: string; partNo: string },
  toState: string,
  actorId: string | null,
  metadata: Record<string, unknown>,
  at: Date
): Promise<void> {
  await tx.insert(transactionLogs).values({
    id: newId(),
    entityType: "receiving_invoice_item_cn",
    entityId: item.id,
    fromState: null,
    toState,
    actorId,
    metadata: { partNo: item.partNo, ...metadata },
    createdDate: at,
  });
}

async function emitItemUpdated(tx: AppDb, orderId: string, itemId: string): Promise<void> {
  await emitEvent(tx, {
    type: "receiving_cn_scan.item_updated",
    topics: ["/receiving-cn-scan-tasks", "/admin/receiving-cn"],
    data: { receivingOrderCnId: orderId, itemId },
  });
}

async function reloadItem(db: AppDb, itemId: string): Promise<CnScanItemRow> {
  const row = await queryGet<CnScanItemRow>(db, sql`${CN_SCAN_ITEM_SELECT} WHERE rii.id = ${itemId}`);
  return row!;
}

export interface CnScanInput {
  qty: number;
  dateCode?: string;
  lotCode?: string;
  coo?: string;
  cow?: string;
  raw?: string;
}

/** Record one physical scan: qty == line_qty → `ok`, otherwise `warning` +
 *  `qty_mismatch`. The scanned batch fields (date code / lot / COO / COW) are
 *  the physical truth put-away will consume — provided keys overwrite the
 *  item's columns, absent keys stay. One small tx + audit + SSE. */
export async function scanCnItem(
  db: AppDb,
  orderId: string,
  itemId: string,
  input: CnScanInput,
  actor: { id: string }
): Promise<CnScanItemRow> {
  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    throw new HTTPException(400, { message: "invalid_payload: qty must be a positive integer" });
  }
  await db.transaction(async (tx) => {
    const at = now();
    const { item } = await loadScanningItem(tx, orderId, itemId);
    const matched = input.qty === item.lineQty;
    const scanStatus = matched ? "ok" : "warning";
    const scanReason = matched ? null : "qty_mismatch";
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items_cn SET
            scan_status = ${scanStatus},
            scan_qty = ${input.qty},
            scan_reason = ${scanReason},
            scan_note = NULL,
            scanned_by = ${actor.id},
            scanned_at = ${at},
            reported_mismatch = 0,
            mismatch_reason = NULL,
            mismatch_qty = NULL,
            wrong_part_no = NULL,
            mismatch_note = NULL,
            ${sql.join(
              [
                ...(input.dateCode !== undefined ? [sql`date_code = ${input.dateCode}`] : []),
                ...(input.lotCode !== undefined ? [sql`lot_code = ${input.lotCode}`] : []),
                ...(input.coo !== undefined ? [sql`coo = ${input.coo}`] : []),
                ...(input.cow !== undefined ? [sql`cow = ${input.cow}`] : []),
              ],
              sql`, `
            )}
            ${input.dateCode !== undefined || input.lotCode !== undefined || input.coo !== undefined || input.cow !== undefined ? sql`,` : sql``}
            last_update_date = ${at}
          WHERE id = ${item.id}`
    );
    await itemAudit(tx, item, `scan_${scanStatus}`, actor.id, { qty: input.qty, scanReason, raw: input.raw ?? null }, at);
    await emitItemUpdated(tx, orderId, item.id);
  });
  return reloadItem(db, itemId);
}

const FLAG_REASONS = ["missing", "damaged", "wrong_part", "other"] as const;
export type CnFlagReason = (typeof FLAG_REASONS)[number];

/** Flag an item as a problem: scan_status `error` + the reason, mirrored into
 *  the dormant mismatch columns so the admin detail shows it through the
 *  existing mismatch display. */
export async function flagCnItem(
  db: AppDb,
  orderId: string,
  itemId: string,
  input: { reason: CnFlagReason; note?: string; wrongPartNo?: string },
  actor: { id: string }
): Promise<CnScanItemRow> {
  if (!FLAG_REASONS.includes(input.reason)) {
    throw new HTTPException(400, { message: `invalid_payload: reason must be one of ${FLAG_REASONS.join(", ")}` });
  }
  await db.transaction(async (tx) => {
    const at = now();
    const { item } = await loadScanningItem(tx, orderId, itemId);
    const note = input.note ?? null;
    const wrongPartNo = input.reason === "wrong_part" ? (input.wrongPartNo ?? null) : null;
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items_cn SET
            scan_status = 'error',
            scan_reason = ${input.reason},
            scan_note = ${note},
            scanned_by = ${actor.id},
            scanned_at = ${at},
            reported_mismatch = 1,
            mismatch_reason = ${input.reason},
            wrong_part_no = ${wrongPartNo},
            mismatch_note = ${note},
            last_update_date = ${at}
          WHERE id = ${item.id}`
    );
    await itemAudit(tx, item, "scan_error", actor.id, { reason: input.reason, note, wrongPartNo }, at);
    await emitItemUpdated(tx, orderId, item.id);
  });
  return reloadItem(db, itemId);
}

/** Clear one item's scan state (scan_* and the mirrored mismatch columns)
 *  back to unresolved. */
export async function resetCnItemScan(
  db: AppDb,
  orderId: string,
  itemId: string,
  actor: { id: string }
): Promise<CnScanItemRow> {
  await db.transaction(async (tx) => {
    const at = now();
    const { item } = await loadScanningItem(tx, orderId, itemId);
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items_cn SET
            scan_status = NULL,
            scan_qty = NULL,
            scan_reason = NULL,
            scan_note = NULL,
            scanned_by = NULL,
            scanned_at = NULL,
            reported_mismatch = 0,
            mismatch_reason = NULL,
            mismatch_qty = NULL,
            wrong_part_no = NULL,
            mismatch_note = NULL,
            last_update_date = ${at}
          WHERE id = ${item.id}`
    );
    await itemAudit(tx, item, "scan_reset", actor.id, {}, at);
    await emitItemUpdated(tx, orderId, item.id);
  });
  return reloadItem(db, itemId);
}

/** Finalize the scan task: unresolved items block with 409 unresolved_items
 *  unless unresolvedAs 'missing' flags them in the same tx. ok items →
 *  received_qty = scan_qty; warning/error items → received_qty = 0 (CN
 *  put-away excludes them). Order → in_hand + arrived; the CN put-away task
 *  is created only when at least one ok item exists (uniform item pair wins;
 *  else the order's org with NULL sub-inventory). Audit rows + SSE. */
export async function finalizeCnScanTask(
  db: AppDb,
  orderId: string,
  input: { unresolvedAs?: "missing" },
  actor: { id: string }
): Promise<{ id: string; batchNo: string; putAwayTaskId: string | null }> {
  const order = await loadCnOrder(db, orderId);
  if (!order) throw new HTTPException(404, { message: "receiving_cn_scan_task_not_found" });
  if (order.status !== "scanning") throw new HTTPException(409, { message: "order_not_scanning" });
  if (input.unresolvedAs !== undefined && input.unresolvedAs !== "missing") {
    throw new HTTPException(400, { message: "invalid_payload: unresolvedAs must be 'missing'" });
  }
  let taskId: string | null = null;
  await db.transaction(async (tx) => {
    const at = now();
    const unresolved = await queryAll<{ id: string; partNo: string; lineQty: number | null }>(
      tx,
      sql`SELECT rii.id, rii.part_no AS "partNo", rii.line_qty AS "lineQty"
          FROM receiving_invoice_items_cn rii
          JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
          WHERE ri.receiving_order_id = ${orderId} AND rii.scan_status IS NULL`
    );
    if (unresolved.length > 0 && input.unresolvedAs !== "missing") {
      throw new HTTPException(409, { message: `unresolved_items: ${unresolved.length}` });
    }
    for (const item of unresolved) {
      await queryRun(
        tx,
        sql`UPDATE receiving_invoice_items_cn SET
              scan_status = 'error',
              scan_reason = 'missing',
              scanned_by = ${actor.id},
              scanned_at = ${at},
              reported_mismatch = 1,
              mismatch_reason = 'missing',
              last_update_date = ${at}
            WHERE id = ${item.id}`
      );
      await itemAudit(tx, item, "scan_error", actor.id, { reason: "missing", auto: true }, at);
    }
    // ok → scanned qty; warning/error → held back at 0.
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items_cn rii
          SET received_qty = CASE WHEN rii.scan_status = 'ok' THEN COALESCE(rii.scan_qty, 0) ELSE 0 END,
              last_update_date = ${at}
          FROM receiving_invoices_cn ri
          WHERE rii.receiving_invoice_id = ri.id AND ri.receiving_order_id = ${orderId}`
    );
    await queryRun(
      tx,
      sql`UPDATE receiving_orders_cn
          SET status = 'in_hand', arrived_at = COALESCE(arrived_at, ${at}),
              arrived_by = COALESCE(${actor.id}, arrived_by), last_update_date = ${at}
          WHERE id = ${order.id}`
    );
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "receiving_order_cn",
      entityId: order.id,
      fromState: "scanning",
      toState: "in_hand",
      actorId: actor.id,
      metadata: { source: "scan_finalize" },
      createdDate: at,
    });
    const okCount = (
      await queryGet<{ n: number }>(
        tx,
        sql`SELECT COUNT(*)::int AS n FROM receiving_invoice_items_cn rii
            JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
            WHERE ri.receiving_order_id = ${orderId} AND rii.scan_status = 'ok'`
      )
    )!.n;
    if (okCount > 0) {
      const derived = await cnOrderPair(tx, order.id);
      const pair = { orgId: derived.orgId ?? order.orgId, subInventoryCode: derived.subInventoryCode };
      const task = await queryAll<{ id: string }>(
        tx,
        sql`INSERT INTO put_away_tasks_cn (id, receiving_order_cn_id, org_id, sub_inventory_code, status, created_date)
            VALUES (${newId()}, ${order.id}, ${pair.orgId}, ${pair.subInventoryCode}, 'pending', ${at})
            ON CONFLICT (receiving_order_cn_id) DO NOTHING
            RETURNING id`
      );
      if (task.length > 0) {
        taskId = task[0].id;
        await tx.insert(transactionLogs).values({
          id: newId(),
          entityType: "put_away_task_cn",
          entityId: taskId,
          fromState: null,
          toState: "pending",
          actorId: actor.id,
          metadata: { receivingOrderCnId: order.id },
          createdDate: at,
        });
      }
    }
    await emitEvent(tx, {
      type: "receiving_cn.completed",
      topics: ["/admin/receiving-cn", "/put-away-tasks", "/receiving-cn-scan-tasks"],
      data: { receivingOrderCnId: order.id, batchNo: order.batchNo, putAwayTaskCreated: taskId !== null },
    });
  });
  return { id: order.id, batchNo: order.batchNo, putAwayTaskId: taskId };
}
