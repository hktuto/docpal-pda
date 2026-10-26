import { sql, type SQL } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { awaitAllocationTask, refreshAllocationStatus, workLockExpiry } from "./allocate.js";
import { emitEvent } from "./events.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { logTransition } from "./picking.js";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import {
  allocationSnapshotBatches,
  allocationSnapshotRows,
  allocations,
  inventoryTransactions,
} from "./schema/index.js";

export interface AllocationSnapshotSummary {
  batchId: string;
  snapshotDate: string;
  capturedAt: string;
  allocations: number;
}

export interface AllocationRestoreRowReport {
  allocationId: string;
  pickingOrderId: string;
  pickingItemId: string;
  sourceType: string;
  qty: number;
  outcome: "restored" | "existing" | "skipped";
  reason?: string;
  releasedRows?: number;
  releasedQty?: number;
}

export interface AllocationRestoreSummary {
  batchId: string;
  snapshotDate: string;
  restoredAt: string;
  total: number;
  restored: number;
  existing: number;
  skipped: number;
  releasedRows: number;
  releasedQty: number;
  manualConflicts: number;
  rows: AllocationRestoreRowReport[];
}

type SnapshotRow = typeof allocationSnapshotRows.$inferSelect;
type SnapshotInsert = typeof allocationSnapshotRows.$inferInsert;

function localDate(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export async function captureAllocationSnapshot(
  db: AppDb,
  actorId: string | null = null,
  at: Date = new Date()
): Promise<AllocationSnapshotSummary> {
  return db.transaction(async (tx) => {
    const snapshotDate = localDate(at);
    const previous = await queryGet<{ id: string }>(
      tx,
      sql`SELECT id FROM allocation_snapshot_batches WHERE snapshot_date = ${snapshotDate}`
    );
    if (previous) {
      await tx.delete(allocationSnapshotBatches).where(sql`${allocationSnapshotBatches.id} = ${previous.id}`);
    }

    const batchId = newId();
    await tx.insert(allocationSnapshotBatches).values({ id: batchId, snapshotDate, capturedAt: at });
    const captured = await queryAll<Omit<SnapshotInsert, "id" | "batchId">>(
      tx,
      sql`SELECT a.id AS "allocationId", a.picking_item_id AS "pickingItemId",
                 po.id AS "pickingOrderId", po.order_no AS "pickingOrderNo", pi.part_no AS "pickingPartNo",
                 pi.line_id AS "pickingLineId", pi.line_number AS "pickingLineNumber",
                 CASE WHEN a.inventory_lot_id IS NOT NULL THEN 'inventory_lot'
                      WHEN a.receiving_invoice_item_id IS NOT NULL THEN 'receiving_invoice_item'
                      ELSE 'receiving_order' END AS "sourceType",
                 a.qty, a.manual,
                 il.id AS "inventoryLotId", COALESCE(il.part_no, rii.part_no, pi.part_no) AS "sourcePartNo",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode", COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS coo, COALESCE(il.cow, rii.cow) AS cow,
                 il.shelf_code AS "shelfCode", il.box_id AS "boxId",
                 il.org_id AS "orgId", il.sub_inventory_code AS "subInventoryCode",
                 rii.id AS "receivingInvoiceItemId", COALESCE(rii_ro.id, ro_source.id) AS "receivingOrderId",
                 COALESCE(rii_ro.batch_no, ro_source.batch_no) AS "receivingBatchNo",
                 ri.invoice_no AS "invoiceNo", rii.po_no AS "poNo", rii.po_line AS "poLine", rii.ctn_no AS "ctnNo"
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          LEFT JOIN receiving_orders rii_ro ON rii_ro.id = ri.receiving_order_id
          LEFT JOIN receiving_orders ro_source ON ro_source.id = a.receiving_order_id
          ORDER BY a.created_date, a.id`
    );
    if (captured.length > 0) {
      await tx.insert(allocationSnapshotRows).values(
        captured.map((row) => {
          if (row.sourceType !== "inventory_lot") {
            row.sourcePartNo = row.sourcePartNo ?? row.pickingPartNo;
          }
          return { ...row, id: newId(), batchId };
        })
      );
    }
    await logTransition(tx, {
      entityType: "allocation_snapshot",
      entityId: batchId,
      fromState: null,
      toState: "captured",
      actorId,
      metadata: { action: "capture_allocation_snapshot", snapshotDate, allocations: captured.length },
    });
    return { batchId, snapshotDate, capturedAt: at.toISOString(), allocations: captured.length };
  });
}

async function resolvePickingItem(
  tx: DbOrTx,
  row: SnapshotRow
): Promise<{ itemId: string; orderId: string; reason?: string }> {
  let orders = await queryAll<{ id: string }>(
    tx,
    sql`SELECT id FROM picking_orders WHERE id = ${row.pickingOrderId} OR order_no = ${row.pickingOrderNo}
        ORDER BY (id = ${row.pickingOrderId}) DESC, id`
  );
  const exactOrder = orders.find((order) => order.id === row.pickingOrderId);
  if (exactOrder) orders = [exactOrder];
  if (orders.length === 0) return { itemId: row.pickingItemId, orderId: row.pickingOrderId, reason: "picking_order_not_found" };
  if (orders.length > 1) return { itemId: row.pickingItemId, orderId: row.pickingOrderId, reason: "ambiguous_picking_order" };
  const orderId = orders[0].id;

  const exact = await queryGet<{ id: string }>(
    tx,
    sql`SELECT id FROM picking_items WHERE id = ${row.pickingItemId} AND picking_order_id = ${orderId}`
  );
  if (exact) return { itemId: exact.id, orderId };

  const match = async (condition: SQL): Promise<{ itemId: string; orderId: string; reason?: string }> => {
    const items = await queryAll<{ id: string }>(
      tx,
      sql`SELECT id FROM picking_items WHERE picking_order_id = ${orderId} AND ${condition} ORDER BY id`
    );
    if (items.length === 1) return { itemId: items[0].id, orderId };
    return {
      itemId: row.pickingItemId,
      orderId,
      reason: items.length === 0 ? "picking_item_not_found" : "ambiguous_picking_item",
    };
  };
  if (row.pickingLineId !== null) return match(sql`line_id = ${row.pickingLineId}`);
  if (row.pickingLineNumber !== null) {
    const byLine = await match(sql`line_number = ${row.pickingLineNumber} AND part_no = ${row.pickingPartNo}`);
    if (!byLine.reason || byLine.reason === "ambiguous_picking_item") return byLine;
  }
  return match(sql`part_no = ${row.pickingPartNo}`);
}

interface ResolvedSource {
  id: string;
  orderId: string | null;
  shelfCode?: string | null;
  shelfKnown?: boolean;
}

async function resolveSource(tx: DbOrTx, row: SnapshotRow): Promise<ResolvedSource | { reason: string }> {
  if (row.sourceType === "inventory_lot") {
    const byId = await queryGet<{ id: string; shelfCode: string | null; shelfKnown: boolean }>(
      tx,
      sql`SELECT id, shelf_code AS "shelfCode",
                 (shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = shelf_code)) AS "shelfKnown"
          FROM inventory_lots WHERE id = ${row.inventoryLotId ?? ""}`
    );
    if (byId) return { ...byId, orderId: null };
    const lots = await queryAll<{ id: string; shelfCode: string | null; shelfKnown: boolean }>(
      tx,
      sql`SELECT id, shelf_code AS "shelfCode",
                 (shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = shelf_code)) AS "shelfKnown"
          FROM inventory_lots
          WHERE part_no = ${row.sourcePartNo ?? ""}
            AND date_code IS NOT DISTINCT FROM ${row.dateCode}
            AND lot_code IS NOT DISTINCT FROM ${row.lotCode}
            AND coo IS NOT DISTINCT FROM ${row.coo}
            AND cow IS NOT DISTINCT FROM ${row.cow}
            AND shelf_code IS NOT DISTINCT FROM ${row.shelfCode}
            AND box_id IS NOT DISTINCT FROM ${row.boxId}
            AND org_id IS NOT DISTINCT FROM ${row.orgId}
            AND sub_inventory_code IS NOT DISTINCT FROM ${row.subInventoryCode}
          ORDER BY id`
    );
    return lots.length === 1
      ? { ...lots[0], orderId: null }
      : { reason: lots.length === 0 ? "inventory_lot_not_found" : "ambiguous_inventory_lot" };
  }

  if (row.sourceType === "receiving_invoice_item") {
    const byId = await queryGet<{ id: string; orderId: string }>(
      tx,
      sql`SELECT rii.id, ri.receiving_order_id AS "orderId"
          FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE rii.id = ${row.receivingInvoiceItemId ?? ""}`
    );
    if (byId) return byId;
    const items = await queryAll<{ id: string; orderId: string }>(
      tx,
      sql`SELECT rii.id, ro.id AS "orderId"
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
          WHERE ro.batch_no = ${row.receivingBatchNo ?? ""}
            AND ri.invoice_no = ${row.invoiceNo ?? ""}
            AND rii.part_no = ${row.sourcePartNo ?? ""}
            AND rii.po_no IS NOT DISTINCT FROM ${row.poNo}
            AND rii.po_line IS NOT DISTINCT FROM ${row.poLine}
            AND rii.ctn_no IS NOT DISTINCT FROM ${row.ctnNo}
          ORDER BY rii.id`
    );
    return items.length === 1
      ? items[0]
      : { reason: items.length === 0 ? "receiving_item_not_found" : "ambiguous_receiving_item" };
  }

  const byId = await queryGet<{ id: string }>(
    tx,
    sql`SELECT id FROM receiving_orders WHERE id = ${row.receivingOrderId ?? ""}`
  );
  if (byId) return { id: byId.id, orderId: byId.id };
  const orders = await queryAll<{ id: string }>(
    tx,
    sql`SELECT id FROM receiving_orders WHERE batch_no = ${row.receivingBatchNo ?? ""} ORDER BY id`
  );
  return orders.length === 1
    ? { id: orders[0].id, orderId: orders[0].id }
    : { reason: orders.length === 0 ? "receiving_order_not_found" : "ambiguous_receiving_order" };
}

async function sourceAvailability(
  tx: DbOrTx,
  row: SnapshotRow,
  source: ResolvedSource
): Promise<{ available: number; reason?: string }> {
  if (row.sourceType === "inventory_lot") {
    const result = await queryGet<{ available: number }>(
      tx,
      sql`SELECT il.total_qty - COALESCE((SELECT SUM(a.qty) FROM allocations a
                                           WHERE a.inventory_lot_id = il.id
                                             AND a.id NOT IN (SELECT allocation_id FROM allocation_snapshot_rows WHERE batch_id = ${row.batchId})), 0) AS available
          FROM inventory_lots il WHERE il.id = ${source.id}`
    );
    return { available: result?.available ?? 0 };
  }
  if (row.sourceType === "receiving_invoice_item") {
    const result = await queryGet<{ available: number; status: string }>(
      tx,
      sql`SELECT rii.received_qty - rii.picked_qty
                 - COALESCE((SELECT SUM(a.qty) FROM allocations a JOIN picking_items pi ON pi.id = a.picking_item_id
                             WHERE (a.receiving_invoice_item_id = rii.id
                                OR (a.receiving_order_id = ro.id AND pi.part_no = ${row.pickingPartNo}))
                               AND a.id NOT IN (SELECT allocation_id FROM allocation_snapshot_rows WHERE batch_id = ${row.batchId})), 0) AS available,
                 ro.status
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
          WHERE rii.id = ${source.id}`
    );
    if (!result || (result.status !== "in_hand" && result.status !== "provisional_received")) {
      return { available: 0, reason: "source_unavailable" };
    }
    return { available: result.available };
  }
  const result = await queryGet<{ available: number; status: string }>(
    tx,
    sql`SELECT ro.status,
               COALESCE((SELECT SUM(GREATEST(rii.received_qty - rii.picked_qty, 0))
                         FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
                         WHERE ri.receiving_order_id = ro.id
                           AND (rii.part_no = ${row.pickingPartNo} OR rii.wcl_item_no = ${row.pickingPartNo})), 0)
               - COALESCE((SELECT SUM(a.qty) FROM allocations a JOIN picking_items pi ON pi.id = a.picking_item_id
                           WHERE pi.part_no = ${row.pickingPartNo}
                             AND (a.receiving_order_id = ro.id OR a.receiving_invoice_item_id IN (
                               SELECT rii2.id FROM receiving_invoice_items rii2
                               JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
                               WHERE ri2.receiving_order_id = ro.id))
                             AND a.id NOT IN (SELECT allocation_id FROM allocation_snapshot_rows WHERE batch_id = ${row.batchId})), 0) AS available
        FROM receiving_orders ro WHERE ro.id = ${source.id}`
  );
  if (!result || (result.status !== "in_hand" && result.status !== "provisional_received")) {
    return { available: 0, reason: "source_unavailable" };
  }
  return { available: result.available };
}

interface ReleaseResult {
  sufficient: boolean;
  manualConflict: boolean;
  rows: number;
  qty: number;
}

async function releaseAutomatic(
  tx: DbOrTx,
  row: SnapshotRow,
  source: ResolvedSource,
  scope: "item" | "source",
  itemId: string,
  needed: number,
  actorId: string | null
): Promise<ReleaseResult> {
  if (needed <= 0) return { sufficient: true, manualConflict: false, rows: 0, qty: 0 };
  let condition: SQL;
  if (scope === "item") {
    condition = sql`a.picking_item_id = ${itemId} AND a.id <> ${row.allocationId}`;
  } else if (row.sourceType === "inventory_lot") {
    condition = sql`a.inventory_lot_id = ${source.id}`;
  } else if (row.sourceType === "receiving_invoice_item") {
    condition = sql`(a.receiving_invoice_item_id = ${source.id}
                     OR (a.receiving_order_id = ${source.orderId} AND pi.part_no = ${row.pickingPartNo}))`;
  } else {
    condition = sql`pi.part_no = ${row.pickingPartNo}
                    AND (a.receiving_order_id = ${source.id} OR a.receiving_invoice_item_id IN (
                      SELECT rii.id FROM receiving_invoice_items rii
                      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
                      WHERE ri.receiving_order_id = ${source.id}))`;
  }
  const victims = await queryAll<{
    id: string;
    pickingItemId: string;
    pickingOrderId: string;
    orderStatus: string;
    qty: number;
    manual: boolean;
    locked: boolean;
    inventoryLotId: string | null;
    receivingInvoiceItemId: string | null;
    partNo: string;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    shelfCode: string | null;
    shelfKnown: boolean;
    boxId: string | null;
  }>(
    tx,
    sql`SELECT a.id, a.picking_item_id AS "pickingItemId", po.id AS "pickingOrderId", po.status AS "orderStatus",
               a.qty, a.manual,
               (po.working_by IS NOT NULL AND po.working_at >= ${workLockExpiry()}) AS locked,
               a.inventory_lot_id AS "inventoryLotId", a.receiving_invoice_item_id AS "receivingInvoiceItemId",
               COALESCE(il.part_no, rii.part_no, pi.part_no) AS "partNo",
               COALESCE(il.date_code, rii.date_code) AS "dateCode", COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
               COALESCE(il.coo, rii.coo) AS "coo", COALESCE(il.cow, rii.cow) AS "cow",
               il.shelf_code AS "shelfCode",
               (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code)) AS "shelfKnown",
               COALESCE(il.box_id, rii.ctn_no) AS "boxId"
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
        LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
        WHERE ${condition}
          AND a.id NOT IN (SELECT allocation_id FROM allocation_snapshot_rows WHERE batch_id = ${row.batchId})
        ORDER BY a.created_date, a.id`
  );
  const releasable = victims.filter((victim) => !victim.manual && !victim.locked);
  const sufficient = releasable.reduce((sum, victim) => sum + victim.qty, 0) >= needed;
  const manualConflict = victims.some((victim) => victim.manual);
  if (!sufficient) return { sufficient, manualConflict, rows: 0, qty: 0 };

  let remaining = needed;
  let releasedRows = 0;
  for (const victim of releasable) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, victim.qty);
    if (take === victim.qty) await tx.execute(sql`DELETE FROM allocations WHERE id = ${victim.id}`);
    else await tx.execute(sql`UPDATE allocations SET qty = qty - ${take}, last_update_date = ${now()} WHERE id = ${victim.id}`);
    await tx.insert(inventoryTransactions).values({
      id: newId(),
      inventoryLotId: victim.inventoryLotId,
      partNo: victim.partNo,
      shelfCode: victim.shelfKnown ? victim.shelfCode : null,
      boxId: victim.boxId,
      txnType: "RESERVE",
      qtyType: "reserved",
      qtyDelta: -take,
      dateCode: victim.dateCode,
      lotCode: victim.lotCode,
      coo: victim.coo,
      cow: victim.cow,
      referenceType: "allocation",
      referenceId: victim.id,
      receivingInvoiceItemId: victim.receivingInvoiceItemId,
      actorId,
      txnReason: "snapshot restore: release",
      txnAt: now(),
    });
    await logTransition(tx, {
      entityType: "picking_order",
      entityId: victim.pickingOrderId,
      fromState: victim.orderStatus,
      toState: victim.orderStatus,
      actorId,
      metadata: {
        action: "allocation_snapshot_release",
        allocationId: victim.id,
        restoreAllocationId: row.allocationId,
        itemId: victim.pickingItemId,
        qty: take,
      },
    });
    remaining -= take;
    releasedRows += 1;
  }
  return { sufficient: true, manualConflict, rows: releasedRows, qty: needed };
}

async function restoreLatest(db: AppDb, actorId: string | null): Promise<AllocationRestoreSummary> {
  return db.transaction(async (tx) => {
    const batch = await queryGet<{ id: string; snapshotDate: string }>(
      tx,
      sql`SELECT id, snapshot_date AS "snapshotDate" FROM allocation_snapshot_batches
          ORDER BY captured_at DESC, id DESC LIMIT 1`
    );
    if (!batch) throw new HTTPException(404, { message: "allocation_snapshot_not_found" });
    const snapshotRows = await tx
      .select()
      .from(allocationSnapshotRows)
      .where(sql`${allocationSnapshotRows.batchId} = ${batch.id}`)
      .orderBy(allocationSnapshotRows.createdDate, allocationSnapshotRows.id);
    const rows: AllocationRestoreRowReport[] = [];
    let releasedRows = 0;
    let releasedQty = 0;
    const restoredByOrder = new Map<string, { status: string; rows: number; qty: number }>();

    for (const row of snapshotRows) {
      const report: AllocationRestoreRowReport = {
        allocationId: row.allocationId,
        pickingOrderId: row.pickingOrderId,
        pickingItemId: row.pickingItemId,
        sourceType: row.sourceType,
        qty: row.qty,
        outcome: "skipped",
      };
      rows.push(report);
      const existing = await queryGet<{ id: string }>(tx, sql`SELECT id FROM allocations WHERE id = ${row.allocationId}`);
      if (existing) {
        report.outcome = "existing";
        continue;
      }

      const item = await resolvePickingItem(tx, row);
      report.pickingOrderId = item.orderId;
      report.pickingItemId = item.itemId;
      if (item.reason) {
        report.reason = item.reason;
        continue;
      }
      const source = await resolveSource(tx, row);
      if ("reason" in source) {
        report.reason = source.reason;
        continue;
      }
      const state = await queryGet<{
        status: string;
        locked: boolean;
        openQty: number;
        allocatedQty: number;
      }>(
        tx,
        sql`SELECT po.status,
                   (po.working_by IS NOT NULL AND po.working_at >= ${workLockExpiry()}) AS locked,
                   (pi.qty - COALESCE((SELECT SUM(pkg.qty) FROM picking_packages pkg WHERE pkg.picking_item_id = pi.id), 0))::int AS "openQty",
                   COALESCE((SELECT SUM(a.qty) FROM allocations a WHERE a.picking_item_id = pi.id), 0)::int AS "allocatedQty"
            FROM picking_items pi JOIN picking_orders po ON po.id = pi.picking_order_id WHERE pi.id = ${item.itemId}`
      );
      if (!state || (state.status !== "pending" && state.status !== "picking" && state.status !== "allocated")) {
        report.reason = "order_not_open";
        continue;
      }
      if (state.locked) {
        report.reason = "lock_held";
        continue;
      }
      const availability = await sourceAvailability(tx, row, source);
      if (availability.reason) {
        report.reason = availability.reason;
        continue;
      }

      await tx.execute(sql`SAVEPOINT allocation_snapshot_row`);
      const itemRelease = await releaseAutomatic(
        tx,
        row,
        source,
        "item",
        item.itemId,
        state.allocatedQty + row.qty - state.openQty,
        actorId
      );
      const remainingAvailability = itemRelease.sufficient
        ? await sourceAvailability(tx, row, source)
        : availability;
      const sourceRelease = itemRelease.sufficient
        ? await releaseAutomatic(tx, row, source, "source", item.itemId, row.qty - remainingAvailability.available, actorId)
        : { sufficient: false, manualConflict: false, rows: 0, qty: 0 };
      if (!itemRelease.sufficient || !sourceRelease.sufficient) {
        await tx.execute(sql`ROLLBACK TO SAVEPOINT allocation_snapshot_row`);
        await tx.execute(sql`RELEASE SAVEPOINT allocation_snapshot_row`);
        const manualConflict = itemRelease.manualConflict || sourceRelease.manualConflict;
        report.reason = manualConflict
          ? "manual_conflict"
          : !itemRelease.sufficient
            ? "open_qty_exceeded"
            : "insufficient_source_availability";
        continue;
      }

      await tx.insert(allocations).values({
        id: row.allocationId,
        pickingItemId: item.itemId,
        inventoryLotId: row.sourceType === "inventory_lot" ? source.id : null,
        receivingInvoiceItemId: row.sourceType === "receiving_invoice_item" ? source.id : null,
        receivingOrderId: row.sourceType === "receiving_order" ? source.id : null,
        qty: row.qty,
        manual: row.manual,
      });
      await tx.insert(inventoryTransactions).values({
        id: newId(),
        inventoryLotId: row.sourceType === "inventory_lot" ? source.id : null,
        partNo: row.pickingPartNo,
        shelfCode: row.sourceType === "inventory_lot" && source.shelfKnown ? source.shelfCode : null,
        boxId: row.boxId ?? row.ctnNo,
        txnType: "RESERVE",
        qtyType: "reserved",
        qtyDelta: row.qty,
        dateCode: row.dateCode,
        lotCode: row.lotCode,
        coo: row.coo,
        cow: row.cow,
        referenceType: "allocation",
        referenceId: row.allocationId,
        receivingInvoiceItemId: row.sourceType === "receiving_invoice_item" ? source.id : null,
        actorId,
        txnReason: "snapshot restore: reserve",
        txnAt: now(),
      });
      await tx.execute(sql`RELEASE SAVEPOINT allocation_snapshot_row`);
      report.outcome = "restored";
      report.releasedRows = itemRelease.rows + sourceRelease.rows;
      report.releasedQty = itemRelease.qty + sourceRelease.qty;
      releasedRows += report.releasedRows;
      releasedQty += report.releasedQty;
      const order = restoredByOrder.get(item.orderId) ?? { status: state.status, rows: 0, qty: 0 };
      order.rows += 1;
      order.qty += row.qty;
      restoredByOrder.set(item.orderId, order);
    }

    await tx.execute(sql`
      UPDATE inventory_lots il
      SET allocated_qty = totals.qty, last_update_date = ${now()}
      FROM (
        SELECT il2.id, COALESCE((SELECT SUM(a.qty) FROM allocations a WHERE a.inventory_lot_id = il2.id), 0)::int AS qty
        FROM inventory_lots il2
      ) totals
      WHERE il.id = totals.id AND il.allocated_qty IS DISTINCT FROM totals.qty
        AND (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code))
    `);
    await tx.execute(sql`
      UPDATE picking_items pi
      SET allocated_qty = totals.qty, last_update_date = ${now()}
      FROM (
        SELECT pi2.id, COALESCE((SELECT SUM(a.qty) FROM allocations a WHERE a.picking_item_id = pi2.id), 0)::int AS qty
        FROM picking_items pi2
      ) totals
      WHERE pi.id = totals.id AND pi.allocated_qty IS DISTINCT FROM totals.qty
    `);
    await refreshAllocationStatus(tx);

    for (const [orderId, restored] of restoredByOrder) {
      await logTransition(tx, {
        entityType: "picking_order",
        entityId: orderId,
        fromState: restored.status,
        toState: restored.status,
        actorId,
        metadata: {
          action: "allocation_snapshot_restore",
          batchId: batch.id,
          allocations: restored.rows,
          qty: restored.qty,
        },
      });
    }
    const restoredAt = now();
    const restored = rows.filter((row) => row.outcome === "restored").length;
    const existing = rows.filter((row) => row.outcome === "existing").length;
    const summary: AllocationRestoreSummary = {
      batchId: batch.id,
      snapshotDate: batch.snapshotDate,
      restoredAt: restoredAt.toISOString(),
      total: rows.length,
      restored,
      existing,
      skipped: rows.length - restored - existing,
      releasedRows,
      releasedQty,
      manualConflicts: rows.filter((row) => row.reason === "manual_conflict").length,
      rows,
    };
    await tx.execute(sql`
      UPDATE allocation_snapshot_batches
      SET restored_at = ${restoredAt}, report = ${JSON.stringify(summary)}::jsonb, last_update_date = ${restoredAt}
      WHERE id = ${batch.id}
    `);
    await logTransition(tx, {
      entityType: "allocation_snapshot",
      entityId: batch.id,
      fromState: "captured",
      toState: "restored",
      actorId,
      metadata: {
        action: "restore_allocation_snapshot",
        total: summary.total,
        restored,
        existing,
        skipped: summary.skipped,
        releasedRows,
        releasedQty,
        manualConflicts: summary.manualConflicts,
      },
    });
    const { rows: _reports, ...eventSummary } = summary;
    if (restored > 0 || releasedRows > 0) {
      await emitEvent(tx, {
        type: "allocation.computed",
        topics: ["/picking-orders", "/receiving-orders"],
        data: { scope: "snapshot-restore", ...eventSummary },
      });
    }
    await emitEvent(tx, {
      type: "allocation.finished",
      topics: ["/picking-orders", "/receiving-orders"],
      data: { scope: "snapshot-restore", changed: restored > 0 || releasedRows > 0, ...eventSummary },
    });
    return summary;
  });
}

export function restoreLatestAllocationSnapshot(
  db: AppDb,
  actorId: string | null = null
): Promise<AllocationRestoreSummary> {
  return awaitAllocationTask(db, "allocation snapshot restore", (runnerDb) => restoreLatest(runnerDb, actorId));
}
