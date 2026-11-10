import { newId } from "./id.js";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import { inventoryTransactions } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";
import { pickingShelfScan, dateCodeFormat } from "../config.js";
import { toCanonicalDateCode } from "./dateCode.js";
import { logTransition, recomputeLot } from "./picking.js";
import { workLockExpiry, allocateForPickingOrder } from "./allocate.js";
import { recomputeTransferItem } from "./internalTransferAllocate.js";

// ---------------------------------------------------------------------------
// Internal transfer PDA flow (spec
// docs/superpowers/specs/2026-11-10-internal-transfer-pda-picking-design.md):
// queue → work-locked pick scans (allocation-capped, picking.ts mechanics
// mirrored onto internal_transfer_allocations / _packages) → finish branches
// (materialize unshelved lots at to_ + awaited delegated re-allocate, or a
// put_away_task consumed by the native shelve endpoint).
//
// Deliberate divergences from picking: `issue` is informational (picking
// continues; a recorded shortage satisfies the finish guard), no
// boxes/verify/shipping (transfers never ship), no scan-into-box.
// ---------------------------------------------------------------------------

async function assertActor(tx: DbOrTx, actorId: string): Promise<void> {
  const actor = await queryGet<{ id: string }>(tx, sql`SELECT id FROM users WHERE id = ${actorId}`);
  if (!actor) throw new HTTPException(400, { message: "actor_not_found" });
}

function lockHeldResponse(holderId: string, holderName: string | null): HTTPException {
  return new HTTPException(409, {
    message: "lock_held",
    res: new Response(
      JSON.stringify({ error: "lock_held", holderId, holderName }),
      { status: 409, headers: { "content-type": "application/json" } }
    ),
  });
}

interface TransferOrderState {
  id: string;
  status: string;
  fromOrgId: number | null;
  fromSubInventoryCode: string | null;
  toOrgId: number | null;
  toSubInventoryCode: string | null;
  pickingOrderId: string | null;
  issueReason: string | null;
}

async function loadTransferForWrite(tx: DbOrTx, transferOrderId: string): Promise<TransferOrderState> {
  const order = await queryGet<TransferOrderState>(
    tx,
    sql`SELECT ito.id, ito.status,
               ito.from_org_id AS "fromOrgId", ito.from_sub_inventory_code AS "fromSubInventoryCode",
               ito.to_org_id AS "toOrgId", ito.to_sub_inventory_code AS "toSubInventoryCode",
               ito.picking_order_id AS "pickingOrderId", ito.issue_reason AS "issueReason"
        FROM internal_transfer_orders ito WHERE ito.id = ${transferOrderId}`
  );
  if (!order) throw new HTTPException(404, { message: "transfer_order_not_found" });
  return order;
}

function assertTransferWritable(order: TransferOrderState): void {
  if (order.status === "pending") throw new HTTPException(409, { message: "transfer_not_confirmed" });
  if (order.status === "finished") throw new HTTPException(409, { message: "transfer_already_finished" });
}

// --- queue + detail ---------------------------------------------------------

export interface InternalTransferQueueRow {
  id: string;
  orderNo: string;
  status: string;
  allocationStatus: string;
  pickingOrderId: string | null;
  fromOrgId: number | null;
  fromSubInventoryCode: string | null;
  toOrgId: number | null;
  toSubInventoryCode: string | null;
  issueReason: string | null;
  itemCount: number;
  totalQty: number;
  pickedQty: number;
  /** Finished + unlinked: packages still waiting for a shelf scan. */
  unshelvedQty: number;
  workingBy: string | null;
  workingByName: string | null;
}

/** PDA queue: pickable orders (allocated/picking/issue) plus finished
 *  unlinked orders with unshelved packages (put-away pending — the detail
 *  page switches to put-away mode for those). */
export async function listInternalTransferQueue(db: AppDb): Promise<InternalTransferQueueRow[]> {
  return queryAll<InternalTransferQueueRow>(
    db,
    sql`SELECT ito.id, ito.order_no AS "orderNo", ito.status, ito.allocation_status AS "allocationStatus",
               ito.picking_order_id AS "pickingOrderId",
               ito.from_org_id AS "fromOrgId", ito.from_sub_inventory_code AS "fromSubInventoryCode",
               ito.to_org_id AS "toOrgId", ito.to_sub_inventory_code AS "toSubInventoryCode",
               ito.issue_reason AS "issueReason",
               (SELECT COUNT(*)::int FROM internal_transfer_items iti WHERE iti.transfer_order_id = ito.id) AS "itemCount",
               (SELECT COALESCE(SUM(iti.qty), 0)::int FROM internal_transfer_items iti WHERE iti.transfer_order_id = ito.id) AS "totalQty",
               (SELECT COALESCE(SUM(iti.picked_qty), 0)::int FROM internal_transfer_items iti WHERE iti.transfer_order_id = ito.id) AS "pickedQty",
               (SELECT COALESCE(SUM(itp.qty), 0)::int FROM internal_transfer_packages itp
                WHERE itp.transfer_order_id = ito.id AND itp.shelf_code IS NULL) AS "unshelvedQty",
               ito.working_by AS "workingBy", u.display_name AS "workingByName"
        FROM internal_transfer_orders ito
        LEFT JOIN users u ON u.id = ito.working_by
        WHERE ito.status IN ('allocated', 'picking', 'issue')
           OR (ito.status = 'finished' AND ito.picking_order_id IS NULL
               AND EXISTS (SELECT 1 FROM internal_transfer_packages itp
                           WHERE itp.transfer_order_id = ito.id AND itp.shelf_code IS NULL))
        ORDER BY ito.priority_seq, ito.created_date DESC, ito.order_no`
  );
}

/** PDA detail: order + items (their allocation rows as pick guidance) +
 *  packages. 404 unknown. */
export async function getInternalTransferPickingDetail(
  db: AppDb,
  transferOrderId: string
): Promise<{ order: Record<string, unknown>; items: unknown[]; packages: unknown[] } | null> {
  const order = await queryGet<Record<string, unknown>>(
    db,
    sql`SELECT ito.id, ito.order_no AS "orderNo", ito.status, ito.allocation_status AS "allocationStatus",
               ito.picking_order_id AS "pickingOrderId",
               ito.from_org_id AS "fromOrgId", ito.from_sub_inventory_code AS "fromSubInventoryCode",
               ito.to_org_id AS "toOrgId", ito.to_sub_inventory_code AS "toSubInventoryCode",
               ito.issue_reason AS "issueReason", ito.issue_qty AS "issueQty", ito.issue_note AS "issueNote",
               ito.working_by AS "workingBy", u.display_name AS "workingByName",
               ito.created_date AS "createdDate"
        FROM internal_transfer_orders ito
        LEFT JOIN users u ON u.id = ito.working_by
        WHERE ito.id = ${transferOrderId}`
  );
  if (!order) return null;
  const items = await queryAll<Record<string, unknown>>(
    db,
    sql`SELECT iti.id, iti.part_no AS "partNo", iti.wcl_item_no AS "wclItemNo",
               iti.qty, iti.picked_qty AS "pickedQty", iti.allocated_qty AS "allocatedQty",
               iti.status, iti.line_number AS "lineNumber", iti.po_no AS "poNo"
        FROM internal_transfer_items iti
        WHERE iti.transfer_order_id = ${transferOrderId}
        ORDER BY iti.line_number NULLS LAST, iti.part_no`
  );
  const allocations = await queryAll<Record<string, unknown>>(
    db,
    sql`SELECT ita.id, ita.transfer_item_id AS "transferItemId", ita.qty,
               CASE WHEN ita.inventory_lot_id IS NOT NULL THEN 'lot'
                    WHEN ita.receiving_invoice_item_id IS NOT NULL THEN 'receiving-item'
                    ELSE 'receiving-order' END AS "sourceType",
               ita.inventory_lot_id AS "inventoryLotId",
               il.shelf_code AS "shelfCode", il.box_id AS "boxId",
               il.date_code AS "dateCode", il.lot_code AS "lotCode",
               ita.receiving_invoice_item_id AS "receivingInvoiceItemId",
               rii.ctn_no AS "ctnNo", ro.batch_no AS "receivingBatchNo"
        FROM internal_transfer_allocations ita
        JOIN internal_transfer_items iti ON iti.id = ita.transfer_item_id
        LEFT JOIN inventory_lots il ON il.id = ita.inventory_lot_id
        LEFT JOIN receiving_invoice_items rii ON rii.id = ita.receiving_invoice_item_id
        LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        LEFT JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        WHERE iti.transfer_order_id = ${transferOrderId}
          AND ita.qty > 0
        ORDER BY ita.created_date, ita.id`
  );
  const byItem = new Map<string, Record<string, unknown>[]>();
  for (const a of allocations) {
    const list = byItem.get(a.transferItemId as string) ?? [];
    list.push(a);
    byItem.set(a.transferItemId as string, list);
  }
  for (const item of items) item.allocations = byItem.get(item.id as string) ?? [];
  const packages = await queryAll<Record<string, unknown>>(
    db,
    sql`SELECT itp.id, itp.transfer_item_id AS "transferItemId", iti.part_no AS "partNo",
               itp.qty, itp.date_code AS "dateCode", itp.lot_code AS "lotCode",
               itp.coo, itp.cow, itp.shelf_code AS "shelfCode",
               itp.source_type AS "sourceType", itp.created_date AS "createdDate"
        FROM internal_transfer_packages itp
        JOIN internal_transfer_items iti ON iti.id = itp.transfer_item_id
        WHERE itp.transfer_order_id = ${transferOrderId}
        ORDER BY itp.created_date, itp.id`
  );
  return { order, items, packages };
}

// --- work lock (conditional-claim mirror of picking.ts acquireWorkLock) -----

export async function acquireInternalTransferWorkLock(
  db: AppDb,
  input: { orderId: string; actorId: string }
): Promise<{ orderId: string; workingBy: string }> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string; status: string; workingBy: string | null; workingAt: Date | null }>(
      tx,
      sql`SELECT ito.id, ito.status, ito.working_by AS "workingBy", ito.working_at AS "workingAt"
          FROM internal_transfer_orders ito WHERE ito.id = ${input.orderId}`
    );
    if (!order) throw new HTTPException(404, { message: "transfer_order_not_found" });
    if (order.status !== "allocated" && order.status !== "picking" && order.status !== "issue") {
      throw new HTTPException(409, { message: "transfer_order_not_open" });
    }
    const expiry = workLockExpiry();
    const expired = !order.workingBy || !order.workingAt || order.workingAt < expiry;
    if (order.workingBy && order.workingBy !== input.actorId && !expired) {
      const holder = await queryGet<{ name: string }>(
        tx,
        sql`SELECT display_name AS name FROM users WHERE id = ${order.workingBy}`
      );
      throw lockHeldResponse(order.workingBy, holder?.name ?? null);
    }
    const claim = await queryRun(
      tx,
      sql`UPDATE internal_transfer_orders SET working_by = ${input.actorId}, working_at = ${now()}, last_update_date = ${now()}
          WHERE id = ${order.id}
            AND (working_by IS NULL OR working_by = ${input.actorId}
                 OR working_at IS NULL OR working_at < ${expiry})`
    );
    if (claim.changes === 0) {
      const loser = await queryGet<{ by: string; name: string | null }>(
        tx,
        sql`SELECT ito.working_by AS by, u.display_name AS name
            FROM internal_transfer_orders ito LEFT JOIN users u ON u.id = ito.working_by
            WHERE ito.id = ${order.id}`
      );
      throw lockHeldResponse(loser?.by ?? "unknown", loser?.name ?? null);
    }
    return { orderId: order.id, workingBy: input.actorId };
  });
}

/** Best-effort release on page leave; only the holder can release. */
export async function releaseInternalTransferWorkLock(
  db: AppDb,
  input: { orderId: string; actorId: string }
): Promise<void> {
  await queryRun(
    db,
    sql`UPDATE internal_transfer_orders SET working_by = NULL, working_at = NULL, last_update_date = ${now()}
        WHERE id = ${input.orderId} AND working_by = ${input.actorId}`
  );
}

// --- pick scan ---------------------------------------------------------------

interface ScanPortion {
  sourceType: "inventory_lot" | "receiving_invoice_item" | "receiving_order";
  sourceId: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  inventoryLotId: string | null;
  shelfCode: string | null;
  boxId: string | null;
  receivingInvoiceItemId: string | null;
}

export interface ScanInternalTransferInput {
  actorId: string;
  allocationId: string;
  qty?: number;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
  shelfCode?: string | null;
  boxId?: string | null;
}

interface LotSourceRow {
  id: string;
  totalQty: number;
  shelfCode: string | null;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

function scannedLocationMatches(input: { shelfCode?: string | null; boxId?: string | null }, lot: { shelfCode: string | null; boxId: string | null }): boolean {
  if (input.boxId) return lot.boxId === input.boxId;
  if (input.shelfCode) return lot.shelfCode === input.shelfCode;
  return false;
}

interface ScanAllocRow {
  id: string;
  transferItemId: string;
  qty: number;
  inventoryLotId: string | null;
  receivingInvoiceItemId: string | null;
  receivingOrderId: string | null;
}

async function loadScanItem(
  tx: DbOrTx,
  transferItemId: string
): Promise<{ id: string; transferOrderId: string; partNo: string; wclItemNo: string | null; qty: number; packagedQty: number }> {
  const item = await queryGet<{
    id: string;
    transferOrderId: string;
    partNo: string;
    wclItemNo: string | null;
    qty: number;
    packagedQty: number;
  }>(
    tx,
    sql`SELECT iti.id, iti.transfer_order_id AS "transferOrderId", iti.part_no AS "partNo",
               iti.wcl_item_no AS "wclItemNo", iti.qty,
               COALESCE((SELECT SUM(itp.qty)::int FROM internal_transfer_packages itp
                         WHERE itp.transfer_item_id = iti.id), 0) AS "packagedQty"
        FROM internal_transfer_items iti WHERE iti.id = ${transferItemId}`
  );
  if (!item) throw new HTTPException(404, { message: "transfer_item_not_found" });
  return item;
}

/** Consume `take` qty from ONE allocation row's source (lot / invoice item /
 *  order-level dock FIFO) into scan portions. Shared by the guidance-row
 *  scan and the label scan. */
async function consumeAllocationRowSource(
  tx: DbOrTx,
  item: { partNo: string },
  order: TransferOrderState,
  alloc: Pick<ScanAllocRow, "inventoryLotId" | "receivingInvoiceItemId" | "receivingOrderId">,
  take: number,
  input: { shelfCode?: string | null; boxId?: string | null }
): Promise<ScanPortion[]> {
  const shelfScanMode = pickingShelfScan();
  const portions: ScanPortion[] = [];
  if (alloc.inventoryLotId) {
    let lot = await queryGet<LotSourceRow>(
      tx,
      sql`SELECT id, total_qty AS "totalQty", shelf_code AS "shelfCode", box_id AS "boxId",
                 date_code AS "dateCode", lot_code AS "lotCode", coo, cow
          FROM inventory_lots WHERE id = ${alloc.inventoryLotId}`
    );
    if (!lot) throw new HTTPException(404, { message: "inventory_lot_not_found" });
    if (shelfScanMode !== "off" && !input.shelfCode && !input.boxId) {
      throw new HTTPException(409, { message: "shelf_scan_required" });
    }
    if (shelfScanMode !== "off" && !scannedLocationMatches(input, lot)) {
      // Physical truth wins: the operator scanned a different shelf —
      // resolve the part's lot there (org/sub from the transfer's from_
      // pair, the source partition).
      lot = await queryGet<LotSourceRow>(
        tx,
        sql`SELECT il.id, il.total_qty AS "totalQty", il.shelf_code AS "shelfCode", il.box_id AS "boxId",
                   il.date_code AS "dateCode", il.lot_code AS "lotCode", il.coo, il.cow
            FROM inventory_lots il
            WHERE (il.part_no = ${item.partNo} OR il.wcl_item_no = ${item.partNo})
              AND il.shelf_code = ${input.shelfCode ?? null}
              ${input.boxId ? sql`AND il.box_id = ${input.boxId}` : sql``}
              AND (${order.fromOrgId}::int IS NULL OR il.org_id = ${order.fromOrgId})
              AND il.total_qty - il.allocated_qty >= ${take}
            ORDER BY il.date_code ASC NULLS LAST, il.id
            LIMIT 1`
      );
      if (!lot) throw new HTTPException(409, { message: "no_stock_at_scanned_shelf" });
    }
    if (lot.totalQty < take) throw new HTTPException(409, { message: "insufficient_lot_qty" });
    // Conditional decrement (audit 2026-11-03 #2): 0 rows = a concurrent
    // scan drained the lot between the read and this UPDATE.
    const lotUpd = await queryRun(
      tx,
      sql`UPDATE inventory_lots SET total_qty = total_qty - ${take}
          WHERE id = ${lot.id} AND total_qty >= ${take}`
    );
    if (lotUpd.changes === 0) throw new HTTPException(409, { message: "insufficient_lot_qty" });
    portions.push({
      sourceType: "inventory_lot",
      sourceId: lot.id,
      qty: take,
      dateCode: lot.dateCode ?? null,
      lotCode: lot.lotCode ?? null,
      coo: lot.coo ?? null,
      cow: lot.cow ?? null,
      inventoryLotId: lot.id,
      shelfCode: lot.shelfCode ?? null,
      boxId: lot.boxId ?? null,
      receivingInvoiceItemId: null,
    });
  } else if (alloc.receivingInvoiceItemId) {
    const rii = await queryGet<{ id: string; boxId: string | null; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }>(
      tx,
      sql`SELECT id, ctn_no AS "boxId", date_code AS "dateCode", lot_code AS "lotCode", coo, cow
          FROM receiving_invoice_items WHERE id = ${alloc.receivingInvoiceItemId}`
    );
    if (!rii) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty + ${take} WHERE id = ${rii.id}`
    );
    portions.push({
      sourceType: "receiving_invoice_item",
      sourceId: rii.id,
      qty: take,
      dateCode: rii.dateCode ?? null,
      lotCode: rii.lotCode ?? null,
      coo: rii.coo ?? null,
      cow: rii.cow ?? null,
      inventoryLotId: null,
      shelfCode: null,
      boxId: rii.boxId ?? null,
      receivingInvoiceItemId: rii.id,
    });
  } else if (alloc.receivingOrderId) {
    // Order-level dock source: distribute FIFO across the receiving
    // order's lines for the part (mirror of scanPickingItem).
    const lines = await queryAll<{ id: string; boxId: string | null; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null; remaining: number }>(
      tx,
      sql`SELECT rii.id, rii.ctn_no AS "boxId", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
                 rii.coo, rii.cow,
                 (rii.received_qty - rii.picked_qty - rii.put_away_qty)::int AS "remaining"
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE ri.receiving_order_id = ${alloc.receivingOrderId}
            AND (rii.part_no = ${item.partNo} OR rii.wcl_item_no = ${item.partNo})
            AND (rii.received_qty - rii.picked_qty - rii.put_away_qty) > 0
          ORDER BY rii.date_code ASC NULLS LAST, rii.id`
    );
    let left = take;
    for (const line of lines) {
      if (left <= 0) break;
      const lineTake = Math.min(line.remaining, left);
      await queryRun(
        tx,
        sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty + ${lineTake} WHERE id = ${line.id}`
      );
      portions.push({
        sourceType: "receiving_order",
        sourceId: alloc.receivingOrderId,
        qty: lineTake,
        dateCode: line.dateCode ?? null,
        lotCode: line.lotCode ?? null,
        coo: line.coo ?? null,
        cow: line.cow ?? null,
        inventoryLotId: null,
        shelfCode: null,
        boxId: line.boxId ?? null,
        receivingInvoiceItemId: line.id,
      });
      left -= lineTake;
    }
    if (left > 0) throw new HTTPException(409, { message: "receiving_source_qty_not_available" });
  } else {
    throw new HTTPException(409, { message: "allocation_has_no_source" });
  }
  return portions;
}

/** Packages + PICK ledger pair + status transition + audit + recomputes —
 *  the shared tail of both scan entry points. */
async function commitTransferScan(
  tx: DbOrTx,
  item: { id: string; transferOrderId: string; partNo: string },
  order: TransferOrderState,
  portions: ScanPortion[],
  input: { actorId: string; dateCode?: string | null; lotCode?: string | null; coo?: string | null; cow?: string | null },
  allocationIds: string[],
  scanQty: number
): Promise<{ packageIds: string[] }> {
  const at = now();
  const packageIds: string[] = [];
  const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
  for (const p of portions) {
    const pid = newId();
    const dateCode = p.dateCode ?? (input.dateCode ? toCanonicalDateCode(input.dateCode, dateCodeFormat()) : null);
    const lotCode = p.lotCode ?? input.lotCode ?? null;
    const coo = p.coo ?? input.coo ?? null;
    const cow = p.cow ?? input.cow ?? null;
    await queryRun(
      tx,
      sql`INSERT INTO internal_transfer_packages (id, transfer_item_id, transfer_order_id, source_type, source_id, qty,
                                                  date_code, lot_code, coo, cow, created_date, last_update_date)
          VALUES (${pid}, ${item.id}, ${item.transferOrderId}, ${p.sourceType}, ${p.sourceId}, ${p.qty},
                  ${dateCode}, ${lotCode}, ${coo}, ${cow}, ${at}, ${at})`
    );
    packageIds.push(pid);
    const base = {
      inventoryLotId: p.inventoryLotId,
      partNo: item.partNo,
      shelfCode: p.shelfCode,
      boxId: p.boxId,
      txnType: "PICK",
      dateCode,
      lotCode,
      coo,
      cow,
      referenceType: "internal_transfer_item",
      referenceId: item.id,
      receivingInvoiceItemId: p.receivingInvoiceItemId,
      actorId: input.actorId,
      txnReason: "internal transfer: pick",
      txnAt: at,
    };
    txnRows.push(
      { ...base, id: newId(), qtyType: "reserved", qtyDelta: -p.qty },
      { ...base, id: newId(), qtyType: "on_hand", qtyDelta: -p.qty }
    );
  }
  await tx.insert(inventoryTransactions).values(txnRows);

  if (order.status === "allocated" || order.status === "issue") {
    await queryRun(
      tx,
      sql`UPDATE internal_transfer_orders SET status = 'picking', last_update_date = ${at} WHERE id = ${order.id}`
    );
    await logTransition(tx, {
      entityType: "internal_transfer_order",
      entityId: order.id,
      fromState: order.status,
      toState: "picking",
      actorId: input.actorId,
    });
  }
  await logTransition(tx, {
    entityType: "internal_transfer_item",
    entityId: item.id,
    fromState: "picking",
    toState: "scanned",
    actorId: input.actorId,
    metadata: { qty: scanQty, allocations: allocationIds, partNo: item.partNo },
  });
  await recomputeTransferItem(tx, item.id);
  return { packageIds };
}

/** Guidance-row scan (the tap/prompt path, mirror of scanPickingItem minus
 *  box/verify): consume exactly `qty` from ONE named allocation row into
 *  internal_transfer_packages + a PICK ledger pair, shrink the row in the
 *  same tx — no recompute. Caps: qty ≤ allocation.qty (409
 *  scanned_qty_exceeds_allocation), Σ packages ≤ item qty (409
 *  scan_qty_exceeds_required). */
export async function scanInternalTransferItem(
  db: AppDb,
  transferItemId: string,
  input: ScanInternalTransferInput
): Promise<{ packageIds: string[] }> {
  return db.transaction(async (tx) => {
    const item = await loadScanItem(tx, transferItemId);
    await assertActor(tx, input.actorId);
    const alloc = await queryGet<ScanAllocRow>(
      tx,
      sql`SELECT ita.id, ita.transfer_item_id AS "transferItemId", ita.qty,
                 ita.inventory_lot_id AS "inventoryLotId",
                 ita.receiving_invoice_item_id AS "receivingInvoiceItemId",
                 ita.receiving_order_id AS "receivingOrderId"
          FROM internal_transfer_allocations ita WHERE ita.id = ${input.allocationId}`
    );
    if (!alloc || alloc.transferItemId !== item.id) {
      throw new HTTPException(404, { message: "allocation_not_found" });
    }
    if (!Number.isInteger(input.qty) || (input.qty ?? 0) <= 0) {
      throw new HTTPException(400, { message: "qty_must_be_positive_integer" });
    }
    const order = await loadTransferForWrite(tx, item.transferOrderId);
    assertTransferWritable(order);
    if (input.qty! > alloc.qty) throw new HTTPException(409, { message: "scanned_qty_exceeds_allocation" });
    if (item.packagedQty + input.qty! > item.qty) {
      throw new HTTPException(409, { message: "scan_qty_exceeds_required" });
    }

    const portions = await consumeAllocationRowSource(tx, item, order, alloc, input.qty!, input);

    // Shrink the allocation (conditional — same audit #2 rationale).
    const shrink = await queryRun(
      tx,
      sql`UPDATE internal_transfer_allocations SET qty = qty - ${input.qty!}, last_update_date = ${now()}
          WHERE id = ${alloc.id} AND qty >= ${input.qty!}`
    );
    if (shrink.changes === 0) throw new HTTPException(409, { message: "scanned_qty_exceeds_allocation" });
    // The lot's allocated_qty counter counts BOTH engines' rows (union
    // recompute) — refresh it for the shrunk reservation.
    if (alloc.inventoryLotId) await recomputeLot(tx, alloc.inventoryLotId);

    return commitTransferScan(tx, item, order, portions, input, [alloc.id], input.qty!);
  });
}

export interface ScanInternalTransferLabelInput {
  actorId: string;
  qty: number;
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
  shelfCode?: string | null;
  boxId?: string | null;
}

/**
 * Item-QR-label scan — the label's qty IS the pick qty (no prompt): consume
 * the item's remaining allocation rows FIFO, SPANNING rows when one label
 * crosses two lots (e.g. 50000 across 30000 + 20000 reservations, picked as
 * two 25000 labels). One package per source portion. Caps: Σ remaining
 * reservations < qty → 409 scanned_qty_exceeds_allocation; Σ packages +
 * qty > item qty → 409 scan_qty_exceeds_required.
 */
export async function scanInternalTransferLabel(
  db: AppDb,
  transferItemId: string,
  input: ScanInternalTransferLabelInput
): Promise<{ packageIds: string[] }> {
  return db.transaction(async (tx) => {
    const item = await loadScanItem(tx, transferItemId);
    await assertActor(tx, input.actorId);
    if (!Number.isInteger(input.qty) || input.qty <= 0) {
      throw new HTTPException(400, { message: "qty_must_be_positive_integer" });
    }
    const order = await loadTransferForWrite(tx, item.transferOrderId);
    assertTransferWritable(order);
    if (item.packagedQty + input.qty > item.qty) {
      throw new HTTPException(409, { message: "scan_qty_exceeds_required" });
    }
    const rows = await queryAll<ScanAllocRow>(
      tx,
      sql`SELECT ita.id, ita.transfer_item_id AS "transferItemId", ita.qty,
                 ita.inventory_lot_id AS "inventoryLotId",
                 ita.receiving_invoice_item_id AS "receivingInvoiceItemId",
                 ita.receiving_order_id AS "receivingOrderId"
          FROM internal_transfer_allocations ita
          WHERE ita.transfer_item_id = ${item.id} AND ita.qty > 0
          ORDER BY ita.created_date, ita.id`
    );
    const reserved = rows.reduce((s, r) => s + r.qty, 0);
    if (reserved < input.qty) throw new HTTPException(409, { message: "scanned_qty_exceeds_allocation" });

    const portions: ScanPortion[] = [];
    const allocationIds: string[] = [];
    const lotIds = new Set<string>();
    let left = input.qty;
    for (const row of rows) {
      if (left <= 0) break;
      const take = Math.min(row.qty, left);
      portions.push(...(await consumeAllocationRowSource(tx, item, order, row, take, input)));
      const shrink = await queryRun(
        tx,
        sql`UPDATE internal_transfer_allocations SET qty = qty - ${take}, last_update_date = ${now()}
            WHERE id = ${row.id} AND qty >= ${take}`
      );
      if (shrink.changes === 0) throw new HTTPException(409, { message: "scanned_qty_exceeds_allocation" });
      allocationIds.push(row.id);
      if (row.inventoryLotId) lotIds.add(row.inventoryLotId);
      left -= take;
    }
    for (const lotId of lotIds) await recomputeLot(tx, lotId);

    return commitTransferScan(tx, item, order, portions, input, allocationIds, input.qty);
  });
}

// --- package removal (reversal mirror of reverseScannedPackageTx) -----------

async function bumpTransferAllocation(
  tx: DbOrTx,
  input: { transferItemId: string; qty: number; inventoryLotId?: string | null; receivingInvoiceItemId?: string | null; receivingOrderId?: string | null }
): Promise<void> {
  // Find-or-create the allocation row for (item, source) and add qty back.
  const existing = await queryGet<{ id: string }>(
    tx,
    sql`SELECT id FROM internal_transfer_allocations
        WHERE transfer_item_id = ${input.transferItemId}
          AND inventory_lot_id IS NOT DISTINCT FROM ${input.inventoryLotId ?? null}
          AND receiving_invoice_item_id IS NOT DISTINCT FROM ${input.receivingInvoiceItemId ?? null}
          AND receiving_order_id IS NOT DISTINCT FROM ${input.receivingOrderId ?? null}
        LIMIT 1`
  );
  if (existing) {
    await queryRun(
      tx,
      sql`UPDATE internal_transfer_allocations SET qty = qty + ${input.qty}, last_update_date = ${now()} WHERE id = ${existing.id}`
    );
  } else {
    await queryRun(
      tx,
      sql`INSERT INTO internal_transfer_allocations (id, transfer_item_id, inventory_lot_id, receiving_invoice_item_id, receiving_order_id, qty, manual, created_date, last_update_date)
          VALUES (${newId()}, ${input.transferItemId}, ${input.inventoryLotId ?? null}, ${input.receivingInvoiceItemId ?? null}, ${input.receivingOrderId ?? null}, ${input.qty}, true, ${now()}, ${now()})`
    );
  }
  await recomputeTransferItem(tx, input.transferItemId);
  if (input.inventoryLotId) await recomputeLot(tx, input.inventoryLotId);
}

/** Un-pick one package: restores the source (lot / receiving line), bumps the
 *  allocation back (as a manual pin — it must survive the next wipe), PICK
 *  reversal ledger pair, deletes the package, recomputes. */
export async function removeInternalTransferPackage(
  db: AppDb,
  input: { packageId: string; actorId: string }
): Promise<void> {
  return db.transaction(async (tx) => {
    const pkg = await queryGet<{
      id: string;
      transferItemId: string;
      transferOrderId: string;
      partNo: string;
      sourceType: string;
      sourceId: string;
      qty: number;
      shelfCode: string | null;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
    }>(
      tx,
      sql`SELECT itp.id, itp.transfer_item_id AS "transferItemId", itp.transfer_order_id AS "transferOrderId",
                 iti.part_no AS "partNo",
                 itp.source_type AS "sourceType", itp.source_id AS "sourceId", itp.qty,
                 itp.shelf_code AS "shelfCode", itp.date_code AS "dateCode", itp.lot_code AS "lotCode",
                 itp.coo, itp.cow
          FROM internal_transfer_packages itp
          JOIN internal_transfer_items iti ON iti.id = itp.transfer_item_id
          WHERE itp.id = ${input.packageId}`
    );
    if (!pkg) throw new HTTPException(404, { message: "package_not_found" });
    if (pkg.shelfCode !== null) throw new HTTPException(409, { message: "package_already_shelved" });
    await assertActor(tx, input.actorId);
    const order = await loadTransferForWrite(tx, pkg.transferOrderId);
    assertTransferWritable(order);

    const at = now();
    const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
    const base = {
      partNo: pkg.partNo,
      txnType: "PICK",
      dateCode: pkg.dateCode,
      lotCode: pkg.lotCode,
      coo: pkg.coo,
      cow: pkg.cow,
      referenceType: "internal_transfer_item",
      referenceId: pkg.transferItemId,
      actorId: input.actorId,
      txnReason: "remove package",
      txnAt: at,
    };
    if (pkg.sourceType === "inventory_lot") {
      const lot = await queryGet<{ id: string; shelfCode: string | null; boxId: string | null }>(
        tx,
        sql`SELECT id, shelf_code AS "shelfCode", box_id AS "boxId" FROM inventory_lots WHERE id = ${pkg.sourceId}`
      );
      if (!lot) throw new HTTPException(404, { message: "inventory_lot_not_found" });
      await queryRun(tx, sql`UPDATE inventory_lots SET total_qty = total_qty + ${pkg.qty} WHERE id = ${lot.id}`);
      await bumpTransferAllocation(tx, { transferItemId: pkg.transferItemId, qty: pkg.qty, inventoryLotId: lot.id });
      txnRows.push(
        { ...base, id: newId(), inventoryLotId: lot.id, shelfCode: lot.shelfCode, boxId: lot.boxId, receivingInvoiceItemId: null, qtyType: "reserved", qtyDelta: pkg.qty },
        { ...base, id: newId(), inventoryLotId: lot.id, shelfCode: lot.shelfCode, boxId: lot.boxId, receivingInvoiceItemId: null, qtyType: "on_hand", qtyDelta: pkg.qty }
      );
    } else if (pkg.sourceType === "receiving_invoice_item") {
      const rii = await queryGet<{ id: string; boxId: string | null }>(
        tx,
        sql`SELECT id, ctn_no AS "boxId" FROM receiving_invoice_items WHERE id = ${pkg.sourceId}`
      );
      if (!rii) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
      await queryRun(
        tx,
        sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty - ${pkg.qty} WHERE id = ${rii.id}`
      );
      await bumpTransferAllocation(tx, { transferItemId: pkg.transferItemId, qty: pkg.qty, receivingInvoiceItemId: rii.id });
      txnRows.push(
        { ...base, id: newId(), inventoryLotId: null, shelfCode: null, boxId: rii.boxId, receivingInvoiceItemId: rii.id, qtyType: "reserved", qtyDelta: pkg.qty },
        { ...base, id: newId(), inventoryLotId: null, shelfCode: null, boxId: rii.boxId, receivingInvoiceItemId: rii.id, qtyType: "on_hand", qtyDelta: pkg.qty }
      );
    } else if (pkg.sourceType === "receiving_order") {
      const lines = await queryAll<{ id: string; pickedQty: number; boxId: string | null }>(
        tx,
        sql`SELECT rii.id, rii.picked_qty AS "pickedQty", rii.ctn_no AS "boxId"
            FROM receiving_invoice_items rii
            JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
            WHERE ri.receiving_order_id = ${pkg.sourceId}
              AND (rii.part_no = ${pkg.partNo} OR rii.wcl_item_no = ${pkg.partNo})
              AND rii.picked_qty > 0
            ORDER BY rii.date_code DESC NULLS FIRST, rii.id DESC`
      );
      let left = pkg.qty;
      for (const line of lines) {
        if (left <= 0) break;
        const give = Math.min(line.pickedQty, left);
        await queryRun(tx, sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty - ${give} WHERE id = ${line.id}`);
        txnRows.push(
          { ...base, id: newId(), inventoryLotId: null, shelfCode: null, boxId: line.boxId, receivingInvoiceItemId: line.id, qtyType: "reserved", qtyDelta: give },
          { ...base, id: newId(), inventoryLotId: null, shelfCode: null, boxId: line.boxId, receivingInvoiceItemId: line.id, qtyType: "on_hand", qtyDelta: give }
        );
        left -= give;
      }
      if (left > 0) throw new HTTPException(409, { message: "receiving_source_qty_not_available" });
      await bumpTransferAllocation(tx, { transferItemId: pkg.transferItemId, qty: pkg.qty, receivingOrderId: pkg.sourceId });
    } else {
      throw new HTTPException(409, { message: "unknown_package_source_type" });
    }

    await queryRun(tx, sql`DELETE FROM internal_transfer_packages WHERE id = ${pkg.id}`);
    if (txnRows.length > 0) await tx.insert(inventoryTransactions).values(txnRows);
    await recomputeTransferItem(tx, pkg.transferItemId);
    await logTransition(tx, {
      entityType: "internal_transfer_item",
      entityId: pkg.transferItemId,
      fromState: "scanned",
      toState: "removed",
      actorId: input.actorId,
      metadata: { qty: pkg.qty, package: pkg.id, partNo: pkg.partNo },
    });
  });
}

// --- issue reporting ----------------------------------------------------------

/** Record a shortage on the transfer (issue_* columns, status → issue).
 *  Unlike picking, `issue` is informational: picking continues, and a
 *  recorded issue satisfies the finish guard (the transfer moves what it
 *  can; the shortage stays visible upstream). */
export async function reportInternalTransferIssue(
  db: AppDb,
  transferOrderId: string,
  input: { actorId: string; reason: string; qty?: number; note?: string | null }
): Promise<void> {
  const REASONS = ["insufficient_stock", "cannot_divide", "other"];
  return db.transaction(async (tx) => {
    if (!REASONS.includes(input.reason)) throw new HTTPException(400, { message: "unhandled_issue_reason" });
    const order = await loadTransferForWrite(tx, transferOrderId);
    assertTransferWritable(order);
    if (input.reason === "insufficient_stock" && (input.qty == null || !Number.isInteger(input.qty) || input.qty < 0)) {
      throw new HTTPException(400, { message: "actual_quantity_required" });
    }
    await assertActor(tx, input.actorId);
    const at = now();
    await queryRun(
      tx,
      sql`UPDATE internal_transfer_orders
          SET status = 'issue', issue_reason = ${input.reason}, issue_qty = ${input.qty ?? null},
              issue_note = ${input.note?.trim() || null}, issue_reported_at = ${at}, issue_reported_by = ${input.actorId},
              last_update_date = ${at}
          WHERE id = ${order.id}`
    );
    await logTransition(tx, {
      entityType: "internal_transfer_order",
      entityId: order.id,
      fromState: order.status,
      toState: "issue",
      actorId: input.actorId,
      metadata: { reason: input.reason, qty: input.qty ?? null },
    });
    await emitEvent(tx, {
      type: "internal-transfer.updated",
      topics: ["/internal-transfer-orders"],
      data: { transferOrderId: order.id, status: "issue" },
    });
  });
}

// --- finish + branches --------------------------------------------------------

export interface FinishInternalTransferResult {
  id: string;
  status: string;
  /** Linked branch: the awaited delegated re-allocation (null when the
   *  scoped run failed — its demand stays stale until the next Re-allocate,
   *  confirm-arrival semantics). */
  allocation: Awaited<ReturnType<typeof allocateForPickingOrder>> | null;
}

/**
 * Explicit PDA finish. Guard: status in allocated/picking/issue and every
 * item fully picked OR a recorded issue (409 not_all_items_picked). Linked
 * branch: packages materialize as unshelved lots at the `to_` pair (natural
 * lot-key merge, ADJUST on_hand ledger) and the delegated picking order's
 * allocation re-runs awaited, outside the tx. Unlinked: one put_away_tasks
 * row (pending) for the native shelve flow.
 */
export async function finishInternalTransferOrder(
  db: AppDb,
  transferOrderId: string,
  actorId: string
): Promise<FinishInternalTransferResult> {
  const orderState = await db.transaction(async (tx) => {
    const order = await loadTransferForWrite(tx, transferOrderId);
    if (order.status !== "allocated" && order.status !== "picking" && order.status !== "issue") {
      throw new HTTPException(409, { message: "transfer_order_could_not_be_finished" });
    }
    await assertActor(tx, actorId);
    const items = await queryAll<{ qty: number; pickedQty: number }>(
      tx,
      sql`SELECT iti.qty, iti.picked_qty AS "pickedQty" FROM internal_transfer_items iti
          WHERE iti.transfer_order_id = ${order.id}`
    );
    if (items.length === 0) throw new HTTPException(409, { message: "no_items_to_pick" });
    if (!items.every((i) => i.pickedQty >= i.qty) && order.issueReason === null) {
      throw new HTTPException(409, { message: "not_all_items_picked" });
    }
    if (order.pickingOrderId && order.toOrgId === null) {
      // Linked finish materializes stock at the to_ partition — impossible
      // without a destination org (never in practice; upstream always sets it).
      throw new HTTPException(409, { message: "transfer_has_no_destination_org" });
    }

    const at = now();
    await queryRun(
      tx,
      sql`UPDATE internal_transfer_orders SET status = 'finished', working_by = NULL, working_at = NULL, last_update_date = ${at}
          WHERE id = ${order.id}`
    );
    await logTransition(tx, {
      entityType: "internal_transfer_order",
      entityId: order.id,
      fromState: order.status,
      toState: "finished",
      actorId,
    });

    if (order.pickingOrderId) {
      // Linked: materialize every package as unshelved stock at the
      // DELEGATED ORDER's own (org, sub) pair — org already equals to_org
      // (the link rule), and the pair (not the transfer's mostly-NULL to_sub,
      // 99.7% of upstream rows) is what the delegated demand matches on, so
      // the re-run below can actually reserve it. Merged by the natural lot
      // key so repeat picks of the same material accumulate on one lot.
      const delegated = await queryGet<{ orgId: number | null; subInventoryCode: string | null }>(
        tx,
        sql`SELECT po.org_id AS "orgId", po.sub_inventory_code AS "subInventoryCode"
            FROM picking_orders po WHERE po.id = ${order.pickingOrderId}`
      );
      const destOrg = delegated?.orgId ?? order.toOrgId;
      const destSub = delegated?.subInventoryCode ?? order.toSubInventoryCode;
      const packages = await queryAll<{
        id: string;
        partNo: string;
        wclItemNo: string | null;
        qty: number;
        dateCode: string | null;
        lotCode: string | null;
        coo: string | null;
        cow: string | null;
      }>(
        tx,
        sql`SELECT itp.id, iti.part_no AS "partNo", iti.wcl_item_no AS "wclItemNo", itp.qty,
                   itp.date_code AS "dateCode", itp.lot_code AS "lotCode", itp.coo, itp.cow
            FROM internal_transfer_packages itp
            JOIN internal_transfer_items iti ON iti.id = itp.transfer_item_id
            WHERE itp.transfer_order_id = ${order.id}`
      );
      const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
      for (const p of packages) {
        const lot = await queryGet<{ id: string }>(
          tx,
          sql`SELECT id FROM inventory_lots
              WHERE part_no = ${p.partNo}
                AND org_id = ${destOrg}
                AND sub_inventory_code IS NOT DISTINCT FROM ${destSub}
                AND shelf_code IS NULL
                AND date_code IS NOT DISTINCT FROM ${p.dateCode}
                AND lot_code IS NOT DISTINCT FROM ${p.lotCode}
                AND coo IS NOT DISTINCT FROM ${p.coo}
                AND cow IS NOT DISTINCT FROM ${p.cow}
              LIMIT 1`
        );
        let lotId = lot?.id;
        if (!lotId) {
          lotId = newId();
          await queryRun(
            tx,
            sql`INSERT INTO inventory_lots (id, part_no, wcl_item_no, org_id, sub_inventory_code, shelf_code, box_id,
                                            date_code, lot_code, coo, cow, total_qty, allocated_qty, created_date, last_update_date)
                VALUES (${lotId}, ${p.partNo}, ${p.wclItemNo}, ${destOrg}, ${destSub}, NULL, NULL,
                        ${p.dateCode}, ${p.lotCode}, ${p.coo}, ${p.cow}, ${p.qty}, 0, ${at}, ${at})`
          );
        } else {
          await queryRun(
            tx,
            sql`UPDATE inventory_lots SET total_qty = total_qty + ${p.qty}, last_update_date = ${at} WHERE id = ${lotId}`
          );
        }
        txnRows.push({
          id: newId(),
          inventoryLotId: lotId,
          partNo: p.partNo,
          txnType: "ADJUST",
          qtyType: "on_hand",
          qtyDelta: p.qty,
          dateCode: p.dateCode,
          lotCode: p.lotCode,
          coo: p.coo,
          cow: p.cow,
          referenceType: "internal_transfer_order",
          referenceId: order.id,
          actorId,
          txnReason: "internal transfer: arrive",
          txnAt: at,
        });
      }
      if (txnRows.length > 0) await tx.insert(inventoryTransactions).values(txnRows);
    } else {
      // Unlinked: one put-away task for the native shelve flow (unique index
      // guards duplicates; the status window makes a double finish impossible).
      await queryRun(
        tx,
        sql`INSERT INTO put_away_tasks (id, internal_transfer_order_id, org_id, sub_inventory_code, status, created_date, last_update_date)
            VALUES (${newId()}, ${order.id}, ${order.toOrgId}, ${order.toSubInventoryCode}, 'pending', ${at}, ${at})`
      );
    }

    await emitEvent(tx, {
      type: "internal-transfer.updated",
      topics: ["/internal-transfer-orders"],
      data: { transferOrderId: order.id, status: "finished" },
    });
    return order;
  });

  // Linked branch: re-run the delegated order's allocation AFTER the finish
  // tx commits (confirm-arrival sequencing — the scoped core opens its own
  // tx). A failure leaves the picking demand stale until the next
  // Re-allocate; the finish itself stands.
  if (orderState.pickingOrderId) {
    try {
      const allocation = await allocateForPickingOrder(db, orderState.pickingOrderId);
      return { id: orderState.id, status: "finished", allocation };
    } catch {
      return { id: orderState.id, status: "finished", allocation: null };
    }
  }
  return { id: orderState.id, status: "finished", allocation: null };
}

// --- native shelving (unlinked put-away branch) -------------------------------

/**
 * Shelve unshelved packages of a finished, unlinked transfer onto a scanned
 * shelf: consumes matching packages FIFO (part + optional date code, capped
 * by qty), merges/creates the lot at (to_org, to_sub, shelfCode) with each
 * package's snapshot, PUT_AWAY on_hand ledger rows, stamps the packages'
 * shelf_code. The put-away task flips to completed at the last package.
 */
export async function shelveInternalTransferPackages(
  db: AppDb,
  transferOrderId: string,
  input: { actorId: string; partNo: string; qty?: number; dateCode?: string | null; shelfCode: string }
): Promise<{ shelved: number; taskCompleted: boolean }> {
  return db.transaction(async (tx) => {
    const order = await loadTransferForWrite(tx, transferOrderId);
    if (order.status !== "finished") throw new HTTPException(409, { message: "transfer_not_finished" });
    if (order.pickingOrderId) throw new HTTPException(409, { message: "transfer_is_linked" });
    await assertActor(tx, input.actorId);
    const shelf = await queryGet<{ code: string }>(
      tx,
      sql`SELECT code FROM shelves WHERE code = ${input.shelfCode}`
    );
    if (!shelf) throw new HTTPException(404, { message: "shelf_not_found" });

    const candidates = await queryAll<{
      id: string;
      partNo: string;
      wclItemNo: string | null;
      qty: number;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
    }>(
      tx,
      sql`SELECT itp.id, iti.part_no AS "partNo", iti.wcl_item_no AS "wclItemNo", itp.qty,
                 itp.date_code AS "dateCode", itp.lot_code AS "lotCode", itp.coo, itp.cow
          FROM internal_transfer_packages itp
          JOIN internal_transfer_items iti ON iti.id = itp.transfer_item_id
          WHERE itp.transfer_order_id = ${order.id}
            AND itp.shelf_code IS NULL
            AND (iti.part_no = ${input.partNo} OR iti.wcl_item_no = ${input.partNo})
            ${input.dateCode
              ? // Exact match: the caller passes the detail payload's stored
                // date_code (already canonical) — re-canonicalizing here
                // double-converts and matches nothing (the
                // no_unshelved_packages_for_part bug).
                sql`AND itp.date_code = ${input.dateCode}`
              : sql``}
          ORDER BY itp.created_date, itp.id`
    );
    if (candidates.length === 0) throw new HTTPException(409, { message: "no_unshelved_packages_for_part" });
    let remaining = input.qty ?? Number.POSITIVE_INFINITY;
    if (input.qty !== undefined && (!Number.isInteger(input.qty) || input.qty <= 0)) {
      throw new HTTPException(400, { message: "qty_must_be_positive_integer" });
    }

    const at = now();
    const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
    let shelved = 0;
    for (const p of candidates) {
      if (remaining <= 0) break;
      // A package shelves whole or not at all — partial shelving of one
      // package would need a split row (never requested).
      if (p.qty > remaining) continue;
      const lot = await queryGet<{ id: string }>(
        tx,
        sql`SELECT id FROM inventory_lots
            WHERE part_no = ${p.partNo}
              AND org_id = ${order.toOrgId}
              AND sub_inventory_code IS NOT DISTINCT FROM ${order.toSubInventoryCode}
              AND shelf_code = ${input.shelfCode}
              AND date_code IS NOT DISTINCT FROM ${p.dateCode}
              AND lot_code IS NOT DISTINCT FROM ${p.lotCode}
              AND coo IS NOT DISTINCT FROM ${p.coo}
              AND cow IS NOT DISTINCT FROM ${p.cow}
            LIMIT 1`
      );
      let lotId = lot?.id;
      if (!lotId) {
        lotId = newId();
        await queryRun(
          tx,
          sql`INSERT INTO inventory_lots (id, part_no, wcl_item_no, org_id, sub_inventory_code, shelf_code, box_id,
                                          date_code, lot_code, coo, cow, total_qty, allocated_qty, created_date, last_update_date)
              VALUES (${lotId}, ${p.partNo}, ${p.wclItemNo}, ${order.toOrgId}, ${order.toSubInventoryCode}, ${input.shelfCode}, NULL,
                      ${p.dateCode}, ${p.lotCode}, ${p.coo}, ${p.cow}, ${p.qty}, 0, ${at}, ${at})`
        );
      } else {
        await queryRun(
          tx,
          sql`UPDATE inventory_lots SET total_qty = total_qty + ${p.qty}, last_update_date = ${at} WHERE id = ${lotId}`
        );
      }
      await queryRun(
        tx,
        sql`UPDATE internal_transfer_packages SET shelf_code = ${input.shelfCode}, last_update_date = ${at} WHERE id = ${p.id}`
      );
      txnRows.push({
        id: newId(),
        inventoryLotId: lotId,
        partNo: p.partNo,
        shelfCode: input.shelfCode,
        txnType: "PUT_AWAY",
        qtyType: "on_hand",
        qtyDelta: p.qty,
        dateCode: p.dateCode,
        lotCode: p.lotCode,
        coo: p.coo,
        cow: p.cow,
        referenceType: "internal_transfer_order",
        referenceId: order.id,
        actorId: input.actorId,
        txnReason: "internal transfer: shelve",
        txnAt: at,
      });
      shelved += p.qty;
      remaining -= p.qty;
    }
    if (shelved === 0) throw new HTTPException(409, { message: "no_package_fits_qty" });
    if (txnRows.length > 0) await tx.insert(inventoryTransactions).values(txnRows);

    const unshelved = await queryGet<{ n: number }>(
      tx,
      sql`SELECT COUNT(*)::int AS n FROM internal_transfer_packages
          WHERE transfer_order_id = ${order.id} AND shelf_code IS NULL`
    );
    const taskCompleted = (unshelved?.n ?? 0) === 0;
    if (taskCompleted) {
      await queryRun(
        tx,
        sql`UPDATE put_away_tasks SET status = 'completed', last_update_date = ${at}
            WHERE internal_transfer_order_id = ${order.id} AND status = 'pending'`
      );
    }
    await logTransition(tx, {
      entityType: "internal_transfer_order",
      entityId: order.id,
      fromState: "finished",
      toState: "finished",
      actorId: input.actorId,
      metadata: { action: "shelve", qty: shelved, shelfCode: input.shelfCode, partNo: input.partNo, taskCompleted },
    });
    await emitEvent(tx, {
      type: "internal-transfer.updated",
      topics: ["/internal-transfer-orders"],
      data: { transferOrderId: order.id, action: "shelve", shelved, taskCompleted },
    });
    return { shelved, taskCompleted };
  });
}

// --- admin confirm / unconfirm -------------------------------------------------

/** Admin status override, deliberately narrow (spec §lifecycle): `pending ↔
 *  allocated` (Confirm / Unconfirm) with work-lock steal on confirm.
 *  `finished` is a physical-world fact recorded by the PDA finish, never an
 *  admin keystroke. No recompute (manual-only rule). */
export async function overrideInternalTransferStatus(
  db: AppDb,
  input: { transferOrderId: string; status: "pending" | "allocated"; actorId: string }
): Promise<{ id: string; status: string }> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string; status: string }>(
      tx,
      sql`SELECT ito.id, ito.status FROM internal_transfer_orders ito WHERE ito.id = ${input.transferOrderId} FOR UPDATE OF ito`
    );
    if (!order) throw new HTTPException(404, { message: "transfer_order_not_found" });
    if (input.status === order.status) return { id: order.id, status: order.status };
    if (input.status === "allocated" && order.status !== "pending") {
      throw new HTTPException(409, { message: "transfer_not_pending" });
    }
    if (input.status === "pending" && order.status !== "allocated") {
      throw new HTTPException(409, { message: "transfer_not_allocated" });
    }
    await assertActor(tx, input.actorId);
    const at = now();
    await queryRun(
      tx,
      sql`UPDATE internal_transfer_orders
          SET status = ${input.status},
              working_by = CASE WHEN ${input.status} = 'allocated' THEN NULL ELSE working_by END,
              working_at = CASE WHEN ${input.status} = 'allocated' THEN NULL ELSE working_at END,
              last_update_date = ${at}
          WHERE id = ${order.id}`
    );
    await logTransition(tx, {
      entityType: "internal_transfer_order",
      entityId: order.id,
      fromState: order.status,
      toState: input.status,
      actorId: input.actorId,
    });
    await emitEvent(tx, {
      type: "internal-transfer.updated",
      topics: ["/internal-transfer-orders"],
      data: { transferOrderId: order.id, status: input.status },
    });
    return { id: order.id, status: input.status };
  });
}
