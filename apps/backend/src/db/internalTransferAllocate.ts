import { newId } from "./id.js";
import { inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import { internalTransferAllocations, inventoryTransactions } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";
import { allowDockStock } from "../config.js";
import { logTransition, recomputeLot } from "./picking.js";
import { loadLotSources, workLockExpiry, type DemandRow } from "./allocate.js";

// ---------------------------------------------------------------------------
// Internal transfer allocation engine (spec
// docs/superpowers/specs/2026-11-10-internal-transfer-admin-allocate-design.md).
//
// An internal transfer order is a DEMAND exactly like a picking order: admin
// presses per-order Re-allocate, sources are restricted to the order's from_
// (org_id, sub_inventory_code) pair (share-group widened, NULL pair =
// org-agnostic — the same rule as the picking engine, applied to the transfer's
// OWN from_ columns; resolveDemandLocation is deliberately NOT used, it is
// the picking-side transfer-item conversion).
//
// Mirrors allocateAll/allocateForPickingOrder's wipe/rebuild mechanics on
// purpose — keep them in sync when the allocation rules change (same note as
// allocate.ts). Deliberate divergences from the picking cores:
//   - separate allocation table (internal_transfer_allocations), so a
//     transfer's rows survive every PICKING wipe; only its own Re-allocate
//     wipes them (order-scoped, non-manual rows only).
//   - no dock pre-passes (PO / perfect-match pinning) — admins pin manually.
//   - order status is untouched; allocation_status carries the state (the
//     pending → allocated confirm arrives with the stage-2 PDA gate).
//
// Shared-pool invariant: availability nets BOTH allocation tables everywhere
// (loadReceivingSources here nets all picking rows + other transfers' rows;
// the picking-side loaders net transfer rows — see allocate.ts / picking.ts).
// ---------------------------------------------------------------------------

export interface TransferDemandRow {
  transferItemId: string;
  partNo: string;
  openQty: number;
}

export interface TransferAllocateResult {
  demands: number;
  fullyAllocated: number;
  partiallyAllocated: number;
  allocationsCreated: number;
  allocationsRemoved: number;
  skippedReceivingSources: number;
  changed: boolean;
  durationMs: number;
}

/** Open demands of ONE transfer order — no item status clause (explicit
 *  repair path, mirroring the picking order-only scope). Open qty = qty −
 *  Σ internal_transfer_packages (stage-2 records; 0 until then). */
async function loadTransferDemands(dbOrTx: DbOrTx, transferOrderId: string): Promise<TransferDemandRow[]> {
  return queryAll<TransferDemandRow>(
    dbOrTx,
    sql`SELECT iti.id AS "transferItemId",
               iti.part_no AS "partNo",
               (iti.qty - COALESCE(pkg.qty, 0)) AS "openQty"
        FROM internal_transfer_items iti
        LEFT JOIN (
          SELECT transfer_item_id, SUM(qty)::int AS qty
          FROM internal_transfer_packages GROUP BY transfer_item_id
        ) pkg ON pkg.transfer_item_id = iti.id
        WHERE iti.transfer_order_id = ${transferOrderId}
          AND iti.qty > COALESCE(pkg.qty, 0)
        ORDER BY iti.line_number NULLS LAST, iti.part_no`
  );
}

interface TransferReceivingRow {
  receivingInvoiceItemId: string;
  receivingOrderId: string;
  ctnNo: string | null;
  dateCode: string | null;
  poNo: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  available: number;
}

/**
 * Dock sources for one transfer demand. Transfer-scope netting (mirror of
 * loadReceivingSources with netAllRemaining, plus the other side of the
 * shared pool): every PICKING allocation row survives a transfer-order-scoped
 * wipe, and so does every OTHER transfer order's row — both are subtracted.
 * The target order's own rows are excluded (they are being wiped).
 */
async function loadTransferReceivingSources(
  dbOrTx: DbOrTx,
  d: TransferDemandRow,
  from: { orgId: number | null; subInventoryCode: string | null },
  transferOrderId: string
): Promise<TransferReceivingRow[]> {
  return queryAll<TransferReceivingRow>(
    dbOrTx,
    sql`SELECT rii.id AS "receivingInvoiceItemId",
               ro.id AS "receivingOrderId",
               rii.ctn_no AS "ctnNo",
               rii.date_code AS "dateCode",
               rii.po_no AS "poNo",
               rii.org_id AS "orgId",
               rii.sub_inventory_code AS "subInventoryCode",
               (rii.received_qty - rii.picked_qty
                 - COALESCE(locked_ii.qty, 0) - COALESCE(locked_ro.qty, 0)) AS "available"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        LEFT JOIN (
          SELECT rii_id, SUM(qty)::int AS qty FROM (
            SELECT a.receiving_invoice_item_id AS rii_id, a.qty
            FROM allocations a
            WHERE a.receiving_invoice_item_id IS NOT NULL
            UNION ALL
            SELECT ita.receiving_invoice_item_id, ita.qty
            FROM internal_transfer_allocations ita
            JOIN internal_transfer_items iti ON iti.id = ita.transfer_item_id
            WHERE ita.receiving_invoice_item_id IS NOT NULL
              AND iti.transfer_order_id <> ${transferOrderId}
          ) u GROUP BY rii_id
        ) locked_ii ON locked_ii.rii_id = rii.id
        LEFT JOIN (
          SELECT ro_id, SUM(qty)::int AS qty FROM (
            SELECT a.receiving_order_id AS ro_id, a.qty
            FROM allocations a
            JOIN picking_items pi ON pi.id = a.picking_item_id
            WHERE a.receiving_order_id IS NOT NULL AND pi.part_no = ${d.partNo}
            UNION ALL
            SELECT ita.receiving_order_id, ita.qty
            FROM internal_transfer_allocations ita
            JOIN internal_transfer_items iti ON iti.id = ita.transfer_item_id
            WHERE ita.receiving_order_id IS NOT NULL
              AND iti.part_no = ${d.partNo}
              AND iti.transfer_order_id <> ${transferOrderId}
          ) u GROUP BY ro_id
        ) locked_ro ON locked_ro.ro_id = ro.id
        WHERE (rii.part_no = ${d.partNo} OR rii.wcl_item_no = ${d.partNo})
          AND ro.status IN ('in_hand', 'provisional_received')
          AND (${from.orgId}::int IS NULL OR rii.org_id = ${from.orgId})
          AND (${from.subInventoryCode}::text IS NULL
               OR upper(rii.sub_inventory_code) = upper(${from.subInventoryCode})
               OR EXISTS (SELECT 1 FROM sub_inventory_share_members sm_d
                          JOIN sub_inventory_share_members sm_s ON sm_s.share_group = sm_d.share_group
                          WHERE sm_d.org_id = ${from.orgId} AND upper(sm_d.code) = upper(${from.subInventoryCode})
                            AND sm_s.org_id = rii.org_id AND upper(sm_s.code) = upper(rii.sub_inventory_code)))
          AND (rii.received_qty - rii.picked_qty
                - COALESCE(locked_ii.qty, 0) - COALESCE(locked_ro.qty, 0)) > 0
        ORDER BY rii.date_code ASC NULLS LAST, rii.id`
  );
}

/** internal_transfer_orders.allocation_status recompute — mirror of
 *  refreshAllocationStatus for the transfer demand world. */
export async function refreshTransferAllocationStatus(dbOrTx: DbOrTx): Promise<void> {
  await dbOrTx.execute(sql`
    UPDATE internal_transfer_orders ito
    SET allocation_status = agg.new_status, last_update_date = now()
    FROM (
      SELECT ito2.id,
             CASE
               WHEN COALESCE(SUM(iti.allocated_qty), 0) = COALESCE(SUM(iti.qty), 0) - COALESCE(SUM(pkg.qty), 0) THEN 'allocated'
               WHEN COALESCE(SUM(iti.allocated_qty), 0) > 0 THEN 'partial'
               ELSE 'unallocated'
             END AS new_status
      FROM internal_transfer_orders ito2
      LEFT JOIN internal_transfer_items iti ON iti.transfer_order_id = ito2.id
      LEFT JOIN (
        SELECT transfer_item_id, SUM(qty)::int AS qty
        FROM internal_transfer_packages GROUP BY transfer_item_id
      ) pkg ON pkg.transfer_item_id = iti.id
      WHERE ito2.status IN ('pending', 'allocated', 'picking')
      GROUP BY ito2.id
    ) agg
    WHERE ito.id = agg.id
      AND ito.allocation_status IS DISTINCT FROM agg.new_status
  `);
}

/** internal_transfer_items: allocated_qty = Σ internal_transfer_allocations,
 *  picked_qty = Σ internal_transfer_packages (no boxing concept), status =
 *  'picked' once picked_qty covers qty. Mirrors recomputePickingItem. */
export async function recomputeTransferItem(tx: DbOrTx, transferItemId: string): Promise<void> {
  const alloc = await queryGet<{ s: number }>(
    tx,
    sql`SELECT COALESCE(SUM(qty), 0)::int AS s FROM internal_transfer_allocations WHERE transfer_item_id = ${transferItemId}`
  );
  const picked = await queryGet<{ s: number }>(
    tx,
    sql`SELECT COALESCE(SUM(qty), 0)::int AS s FROM internal_transfer_packages WHERE transfer_item_id = ${transferItemId}`
  );
  await tx.execute(
    sql`UPDATE internal_transfer_items SET allocated_qty = ${alloc?.s ?? 0}, picked_qty = ${picked?.s ?? 0},
           status = CASE WHEN ${picked?.s ?? 0} >= qty THEN 'picked' ELSE 'pending' END,
           last_update_date = ${now()}
        WHERE id = ${transferItemId}`
  );
}

/**
 * Order-scoped wipe/rebuild for ONE internal transfer order (the admin
 * "Re-allocate" button — mirror of allocateForPickingOrder). 404
 * transfer_order_not_found; 409 order_not_open unless pending/allocated/
 * picking; 409 lock_held when a live work lock is held (stage-2 PDA).
 * shortcut: no dock pre-passes (PO / perfect-match) — admins pin manually;
 * revisit when stage-2 transfer picking makes dock sourcing common.
 */
export async function allocateForInternalTransferOrder(db: AppDb, transferOrderId: string): Promise<TransferAllocateResult> {
  const startedAt = Date.now();
  return db.transaction(async (tx) => {
    // The status + work-lock check lives INSIDE the transaction, locking the
    // order row (same rationale as allocateForPickingOrder, audit 2026-11-06
    // #12 — a stage-2 PDA claim can't land between the check and the wipe).
    const order = await queryGet<{
      id: string;
      status: string;
      fromOrgId: number | null;
      fromSubInventoryCode: string | null;
      workingBy: string | null;
      workingAt: Date | null;
      holderName: string | null;
    }>(
      tx,
      sql`SELECT ito.id, ito.status, ito.from_org_id AS "fromOrgId",
                 ito.from_sub_inventory_code AS "fromSubInventoryCode",
                 ito.working_by AS "workingBy", ito.working_at AS "workingAt",
                 u.display_name AS "holderName"
          FROM internal_transfer_orders ito
          LEFT JOIN users u ON u.id = ito.working_by
          WHERE ito.id = ${transferOrderId}
          FOR UPDATE OF ito`
    );
    if (!order) throw new HTTPException(404, { message: "transfer_order_not_found" });
    if (order.status !== "pending" && order.status !== "allocated" && order.status !== "picking") {
      throw new HTTPException(409, { message: "order_not_open" });
    }
    if (order.workingBy && order.workingAt && order.workingAt >= workLockExpiry()) {
      throw new HTTPException(409, {
        message: "lock_held",
        res: new Response(
          JSON.stringify({ error: "lock_held", holderId: order.workingBy, holderName: order.holderName }),
          { status: 409, headers: { "content-type": "application/json" } }
        ),
      });
    }

    const result: TransferAllocateResult = {
      demands: 0,
      fullyAllocated: 0,
      partiallyAllocated: 0,
      allocationsCreated: 0,
      allocationsRemoved: 0,
      skippedReceivingSources: 0,
      changed: false,
      durationMs: 0,
    };
    const demands = await loadTransferDemands(tx, transferOrderId);
    result.demands = demands.length;
    if (demands.length === 0) {
      await refreshTransferAllocationStatus(tx);
      await emitEvent(tx, {
        type: "allocation.finished",
        topics: ["/internal-transfer-orders"],
        data: { ...result, changed: false },
      });
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    // Wipe existing non-manual rows of the order's items (+ RESERVE reversals).
    const itemIds = demands.map((d) => d.transferItemId);
    const existing = await queryAll<{
      id: string;
      transferItemId: string;
      inventoryLotId: string | null;
      receivingInvoiceItemId: string | null;
      receivingOrderId: string | null;
      qty: number;
      manual: boolean;
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
      sql`SELECT ita.id, ita.transfer_item_id AS "transferItemId",
                 ita.inventory_lot_id AS "inventoryLotId",
                 ita.receiving_invoice_item_id AS "receivingInvoiceItemId",
                 ita.receiving_order_id AS "receivingOrderId", ita.qty, ita.manual,
                 COALESCE(il.part_no, rii.part_no, iti.part_no) AS "partNo",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode",
                 COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS "coo",
                 COALESCE(il.cow, rii.cow) AS "cow",
                 il.shelf_code AS "shelfCode",
                 (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code)) AS "shelfKnown",
                 COALESCE(il.box_id, rii.ctn_no) AS "boxId"
          FROM internal_transfer_allocations ita
          JOIN internal_transfer_items iti ON iti.id = ita.transfer_item_id
          LEFT JOIN inventory_lots il ON il.id = ita.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = ita.receiving_invoice_item_id
          WHERE ${inArray(sql`ita.transfer_item_id`, itemIds)}`
    );
    const allocationKey = (
      transferItemId: string,
      inventoryLotId: string | null,
      receivingInvoiceItemId: string | null,
      receivingOrderId: string | null,
      qty: number
    ) => `${transferItemId}|${inventoryLotId ?? ""}|${receivingInvoiceItemId ?? ""}|${receivingOrderId ?? ""}|${qty}`;
    const beforeKeys = existing.filter((a) => !a.manual).map((a) =>
      allocationKey(a.transferItemId, a.inventoryLotId, a.receivingInvoiceItemId, a.receivingOrderId, a.qty)
    );
    const afterKeys: string[] = [];
    const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
    const lotDelta = new Map<string, number>();
    const manualQtyByItem = new Map<string, number>();

    for (const a of existing) {
      if (a.manual) {
        manualQtyByItem.set(a.transferItemId, (manualQtyByItem.get(a.transferItemId) ?? 0) + a.qty);
        continue;
      }
      result.allocationsRemoved += 1;
      if (a.inventoryLotId) {
        lotDelta.set(a.inventoryLotId, (lotDelta.get(a.inventoryLotId) ?? 0) - a.qty);
      }
      txnRows.push({
        id: newId(),
        inventoryLotId: a.inventoryLotId,
        partNo: a.partNo,
        shelfCode: a.shelfKnown ? a.shelfCode : null,
        boxId: a.boxId,
        txnType: "RESERVE",
        qtyType: "reserved",
        qtyDelta: -a.qty,
        dateCode: a.dateCode,
        lotCode: a.lotCode,
        coo: a.coo,
        cow: a.cow,
        referenceType: "internal_transfer_allocation",
        referenceId: a.id,
        receivingInvoiceItemId: a.receivingInvoiceItemId,
        txnReason: "recompute: release",
        txnAt: now(),
      });
    }
    await tx.execute(
      sql`DELETE FROM internal_transfer_allocations WHERE ${inArray(sql`transfer_item_id`, itemIds)} AND NOT manual`
    );
    // Negative lot deltas up front so the source queries see net availability
    // (same ordering rationale as allocateAll).
    for (const [lotId, delta] of lotDelta) {
      if (delta === 0) continue;
      await tx.execute(
        sql`UPDATE inventory_lots il SET allocated_qty = allocated_qty + ${delta} WHERE il.id = ${lotId} AND (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code))`
      );
    }
    lotDelta.clear();

    const from = { orgId: order.fromOrgId, subInventoryCode: order.fromSubInventoryCode };
    const lotUsed = new Map<string, number>();
    const recvUsed = new Map<string, number>();

    for (const d of demands) {
      // Synthesized picking DemandRow carrying the transfer's OWN from_ pair —
      // resolveDemandLocation is never applied (that is the picking-side
      // transfer-item conversion, not ours).
      const lotDemand: DemandRow = {
        pickingItemId: d.transferItemId,
        partNo: d.partNo,
        openQty: d.openQty,
        customerCode: null,
        orgId: from.orgId,
        subInventoryCode: from.subInventoryCode,
        orderNo: null,
        itemPoNo: null,
        orderPoNo: null,
        fromSubinventory: null,
      };
      let remaining = Math.max(0, d.openQty - (manualQtyByItem.get(d.transferItemId) ?? 0));
      const allocatedForItem: { qty: number; lotId?: string; recv?: { receivingInvoiceItemId: string; receivingOrderId: string; ctnNo: string | null; dateCode: string | null } }[] = [];

      // 1. shelf stock, FIFO by date_code — lot availability is counter-based
      //    (total_qty − allocated_qty), so transfer and picking reservations
      //    net each other with no query change.
      const lots = await loadLotSources(tx, lotDemand);
      for (const lot of lots) {
        if (remaining <= 0) break;
        const usable = lot.available - (lotUsed.get(lot.lotId) ?? 0);
        if (usable <= 0) continue;
        const take = Math.min(usable, remaining);
        allocatedForItem.push({ qty: take, lotId: lot.lotId });
        lotUsed.set(lot.lotId, (lotUsed.get(lot.lotId) ?? 0) + take);
        remaining -= take;
      }

      // 2. dock stock, FIFO — transfer-scope netting (both tables, other
      //    orders only) lives inside loadTransferReceivingSources.
      if (remaining > 0 && allowDockStock()) {
        const rows = await loadTransferReceivingSources(tx, d, from, transferOrderId);
        for (const r of rows) {
          if (remaining <= 0) break;
          if (r.orgId === null || r.subInventoryCode === null) {
            result.skippedReceivingSources += 1;
            continue;
          }
          const key = r.ctnNo ? `item:${r.receivingInvoiceItemId}` : `order:${r.receivingOrderId}:${d.partNo}`;
          const usable = r.available - (recvUsed.get(key) ?? 0);
          if (usable <= 0) continue;
          const take = Math.min(usable, remaining);
          allocatedForItem.push({
            qty: take,
            recv: { receivingInvoiceItemId: r.receivingInvoiceItemId, receivingOrderId: r.receivingOrderId, ctnNo: r.ctnNo, dateCode: r.dateCode },
          });
          recvUsed.set(key, (recvUsed.get(key) ?? 0) + take);
          remaining -= take;
        }
      }

      if (d.openQty - remaining <= 0) continue;
      if (remaining <= 0) result.fullyAllocated += 1;
      else result.partiallyAllocated += 1;

      for (const alloc of allocatedForItem) {
        const id = newId();
        await tx.insert(internalTransferAllocations).values({
          id,
          transferItemId: d.transferItemId,
          inventoryLotId: alloc.lotId ?? null,
          receivingInvoiceItemId: alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
          receivingOrderId: alloc.recv && !alloc.recv.ctnNo ? alloc.recv.receivingOrderId : null,
          qty: alloc.qty,
        });
        result.allocationsCreated += 1;
        afterKeys.push(
          allocationKey(
            d.transferItemId,
            alloc.lotId ?? null,
            alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
            alloc.recv && !alloc.recv.ctnNo ? alloc.recv.receivingOrderId : null,
            alloc.qty
          )
        );
        if (alloc.lotId) {
          lotDelta.set(alloc.lotId, (lotDelta.get(alloc.lotId) ?? 0) + alloc.qty);
        }
        txnRows.push({
          id: newId(),
          inventoryLotId: alloc.lotId ?? null,
          partNo: d.partNo,
          shelfCode: null,
          boxId: alloc.recv?.ctnNo ?? null,
          txnType: "RESERVE",
          qtyType: "reserved",
          qtyDelta: alloc.qty,
          dateCode: alloc.recv?.dateCode ?? null,
          referenceType: "internal_transfer_allocation",
          referenceId: id,
          receivingInvoiceItemId: alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
          txnReason: "recompute: reserve",
          txnAt: now(),
        });
      }
      await tx.execute(
        sql`UPDATE internal_transfer_items SET allocated_qty = ${d.openQty - remaining}, last_update_date = ${now()}
            WHERE id = ${d.transferItemId}`
      );
    }

    for (const [lotId, delta] of lotDelta) {
      if (delta === 0) continue;
      await tx.execute(
        sql`UPDATE inventory_lots il SET allocated_qty = allocated_qty + ${delta} WHERE il.id = ${lotId} AND (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code))`
      );
    }
    if (txnRows.length > 0) {
      await tx.insert(inventoryTransactions).values(txnRows);
    }
    await tx.execute(
      sql`UPDATE internal_transfer_items SET allocated_qty = 0, last_update_date = ${now()}
          WHERE ${inArray(sql`id`, itemIds)} AND id NOT IN (
            SELECT DISTINCT transfer_item_id FROM internal_transfer_allocations WHERE ${inArray(sql`transfer_item_id`, itemIds)}
          )`
    );
    if (result.skippedReceivingSources > 0) {
      console.warn(
        `allocateForInternalTransferOrder: skipped ${result.skippedReceivingSources} receiving source(s) with a NULL item location pair (org_id/sub_inventory_code)`
      );
    }
    result.changed = beforeKeys.slice().sort().join("\n") !== afterKeys.slice().sort().join("\n");
    if (result.changed) {
      await emitEvent(tx, {
        type: "allocation.computed",
        topics: ["/internal-transfer-orders"],
        data: { ...result },
      });
    }
    await emitEvent(tx, {
      type: "allocation.finished",
      topics: ["/internal-transfer-orders"],
      data: { ...result, changed: result.changed },
    });
    await refreshTransferAllocationStatus(tx);
    result.durationMs = Date.now() - startedAt;
    console.log(`[alloc-timing] allocateForInternalTransferOrder ${transferOrderId} engine=${result.durationMs}ms`);
    return result;
  });
}

/**
 * Admin "remove allocation" for a transfer item — mirror of
 * removePickingAllocation: delete ONE row (RESERVE-release ledger, lot/item
 * recomputes, audit, SSE); no order-status check; work-lock guard; transient
 * (the next Re-allocate may re-create it).
 */
export async function removeInternalTransferAllocation(
  db: AppDb,
  transferOrderId: string,
  transferItemId: string,
  allocationId: string,
  actorId: string
): Promise<{ removed: number; qty: number }> {
  const order = await queryGet<{
    id: string;
    status: string;
    workingBy: string | null;
    workingAt: Date | null;
    holderName: string | null;
  }>(
    db,
    sql`SELECT ito.id, ito.status, ito.working_by AS "workingBy", ito.working_at AS "workingAt",
               u.display_name AS "holderName"
        FROM internal_transfer_orders ito
        LEFT JOIN users u ON u.id = ito.working_by
        WHERE ito.id = ${transferOrderId}`
  );
  if (!order) throw new HTTPException(404, { message: "transfer_order_not_found" });
  if (order.workingBy && order.workingAt && order.workingAt >= workLockExpiry()) {
    throw new HTTPException(409, {
      message: "lock_held",
      res: new Response(
        JSON.stringify({ error: "lock_held", holderId: order.workingBy, holderName: order.holderName }),
        { status: 409, headers: { "content-type": "application/json" } }
      ),
    });
  }

  const item = await queryGet<{ id: string; partNo: string }>(
    db,
    sql`SELECT id, part_no AS "partNo" FROM internal_transfer_items
        WHERE id = ${transferItemId} AND transfer_order_id = ${transferOrderId}`
  );
  if (!item) throw new HTTPException(404, { message: "transfer_item_not_found" });

  return db.transaction(async (tx) => {
    const existing = await queryGet<{
      id: string;
      inventoryLotId: string | null;
      receivingInvoiceItemId: string | null;
      qty: number;
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
      sql`SELECT ita.id, ita.inventory_lot_id AS "inventoryLotId",
                 ita.receiving_invoice_item_id AS "receivingInvoiceItemId", ita.qty,
                 COALESCE(il.part_no, rii.part_no, iti.part_no) AS "partNo",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode",
                 COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS "coo",
                 COALESCE(il.cow, rii.cow) AS "cow",
                 il.shelf_code AS "shelfCode",
                 (il.shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = il.shelf_code)) AS "shelfKnown",
                 COALESCE(il.box_id, rii.ctn_no) AS "boxId"
          FROM internal_transfer_allocations ita
          JOIN internal_transfer_items iti ON iti.id = ita.transfer_item_id
          LEFT JOIN inventory_lots il ON il.id = ita.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = ita.receiving_invoice_item_id
          WHERE ita.id = ${allocationId} AND ita.transfer_item_id = ${transferItemId}`
    );
    if (!existing) throw new HTTPException(404, { message: "allocation_not_found" });

    await tx.execute(sql`DELETE FROM internal_transfer_allocations WHERE id = ${allocationId}`);
    if (existing.inventoryLotId) {
      await recomputeLot(tx, existing.inventoryLotId);
    }
    await recomputeTransferItem(tx, transferItemId);

    await tx.insert(inventoryTransactions).values({
      id: newId(),
      inventoryLotId: existing.inventoryLotId,
      partNo: existing.partNo,
      shelfCode: existing.shelfKnown ? existing.shelfCode : null,
      boxId: existing.boxId,
      txnType: "RESERVE",
      qtyType: "reserved",
      qtyDelta: -existing.qty,
      dateCode: existing.dateCode,
      lotCode: existing.lotCode,
      coo: existing.coo,
      cow: existing.cow,
      referenceType: "internal_transfer_allocation",
      referenceId: existing.id,
      receivingInvoiceItemId: existing.receivingInvoiceItemId,
      actorId,
      txnReason: "admin: remove allocation",
      txnAt: now(),
    });

    await refreshTransferAllocationStatus(tx);

    await logTransition(tx, {
      entityType: "internal_transfer_order",
      entityId: transferOrderId,
      fromState: order.status,
      toState: order.status,
      actorId,
      metadata: { action: "remove_allocation", allocationId, itemId: transferItemId, partNo: item.partNo, qty: existing.qty },
    });

    await emitEvent(tx, {
      type: "allocation.computed",
      topics: ["/internal-transfer-orders"],
      data: { scope: "internal-transfer-order-item", transferOrderId, transferItemId, allocationId, removed: 1, qty: existing.qty },
    });

    return { removed: 1, qty: existing.qty };
  });
}

/**
 * Admin "manual allocation" (availability modal) for a transfer item —
 * mirror of addManualPickingAllocation: pin one manual row against a stock
 * lot or receiving invoice item, ANY location (admin override — the modal
 * filters to the from_ pair, the API trusts the admin). No order-status
 * check. shortcut: no override-steal — a shortfall above the source's
 * availability is refused (409 insufficient_available); remove the other
 * order's allocation by hand instead.
 */
export async function addManualInternalTransferAllocation(
  db: AppDb,
  transferOrderId: string,
  transferItemId: string,
  input: { qty: number; inventoryLotId?: string; receivingInvoiceItemId?: string },
  actorId: string
): Promise<{ allocationId: string; qty: number }> {
  const qty = input.qty;
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new HTTPException(400, { message: "invalid_qty" });
  }
  const hasLot = !!input.inventoryLotId;
  const hasRecv = !!input.receivingInvoiceItemId;
  if (hasLot === hasRecv) {
    throw new HTTPException(400, { message: "source_required" });
  }

  const order = await queryGet<{
    id: string;
    status: string;
    workingBy: string | null;
    workingAt: Date | null;
    holderName: string | null;
  }>(
    db,
    sql`SELECT ito.id, ito.status, ito.working_by AS "workingBy", ito.working_at AS "workingAt",
               u.display_name AS "holderName"
        FROM internal_transfer_orders ito
        LEFT JOIN users u ON u.id = ito.working_by
        WHERE ito.id = ${transferOrderId}`
  );
  if (!order) throw new HTTPException(404, { message: "transfer_order_not_found" });
  if (order.workingBy && order.workingAt && order.workingAt >= workLockExpiry()) {
    throw new HTTPException(409, {
      message: "lock_held",
      res: new Response(
        JSON.stringify({ error: "lock_held", holderId: order.workingBy, holderName: order.holderName }),
        { status: 409, headers: { "content-type": "application/json" } }
      ),
    });
  }

  const item = await queryGet<{ id: string; partNo: string; qty: number }>(
    db,
    sql`SELECT id, part_no AS "partNo", qty FROM internal_transfer_items
        WHERE id = ${transferItemId} AND transfer_order_id = ${transferOrderId}`
  );
  if (!item) throw new HTTPException(404, { message: "transfer_item_not_found" });

  return db.transaction(async (tx) => {
    let source: {
      partNo: string;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      shelfCode: string | null;
      boxId: string | null;
      available: number;
    };
    if (hasLot) {
      const lot = await queryGet<{
        id: string;
        partNo: string;
        dateCode: string | null;
        lotCode: string | null;
        coo: string | null;
        cow: string | null;
        shelfCode: string | null;
        boxId: string | null;
        available: number;
        shelfKnown: boolean;
      }>(
        tx,
        sql`SELECT id, part_no AS "partNo", date_code AS "dateCode", lot_code AS "lotCode",
                   coo, cow, shelf_code AS "shelfCode", box_id AS "boxId",
                   (total_qty - allocated_qty) AS "available",
                   (shelf_code IS NULL OR EXISTS (SELECT 1 FROM shelves sh WHERE sh.code = inventory_lots.shelf_code)) AS "shelfKnown"
            FROM inventory_lots WHERE id = ${input.inventoryLotId!}`
      );
      if (!lot) throw new HTTPException(404, { message: "inventory_lot_not_found" });
      if (!lot.shelfKnown) throw new HTTPException(409, { message: "shelf_not_found" });
      source = lot;
    } else {
      const recv = await queryGet<{
        id: string;
        partNo: string;
        dateCode: string | null;
        lotCode: string | null;
        coo: string | null;
        cow: string | null;
        boxId: string | null;
        available: number;
      }>(
        tx,
        sql`SELECT rii.id, rii.part_no AS "partNo", rii.date_code AS "dateCode",
                   rii.lot_code AS "lotCode", rii.coo, rii.cow, rii.ctn_no AS "boxId",
                   (rii.received_qty - rii.picked_qty - COALESCE(alloc.qty, 0)) AS "available"
            FROM receiving_invoice_items rii
            LEFT JOIN (
              SELECT rii_id, SUM(qty)::int AS qty FROM (
                SELECT receiving_invoice_item_id AS rii_id, qty
                FROM allocations WHERE receiving_invoice_item_id IS NOT NULL
                UNION ALL
                SELECT ita.receiving_invoice_item_id, ita.qty
                FROM internal_transfer_allocations ita
                WHERE ita.receiving_invoice_item_id IS NOT NULL
              ) u GROUP BY rii_id
            ) alloc ON alloc.rii_id = rii.id
            WHERE rii.id = ${input.receivingInvoiceItemId!}`
      );
      if (!recv) throw new HTTPException(404, { message: "receiving_invoice_item_not_found" });
      source = { ...recv, shelfCode: null };
    }
    if (qty > source.available) {
      throw new HTTPException(409, { message: "insufficient_available" });
    }

    const open = await queryGet<{ openQty: number; allocated: number }>(
      tx,
      sql`SELECT (iti.qty - COALESCE(pkg.qty, 0)) AS "openQty",
                 COALESCE(alloc.qty, 0) AS "allocated"
          FROM internal_transfer_items iti
          LEFT JOIN (
            SELECT transfer_item_id, SUM(qty)::int AS qty FROM internal_transfer_packages GROUP BY transfer_item_id
          ) pkg ON pkg.transfer_item_id = iti.id
          LEFT JOIN (
            SELECT transfer_item_id, SUM(qty)::int AS qty FROM internal_transfer_allocations GROUP BY transfer_item_id
          ) alloc ON alloc.transfer_item_id = iti.id
          WHERE iti.id = ${transferItemId}`
    );
    if (open!.allocated + qty > open!.openQty) {
      throw new HTTPException(409, { message: "over_allocation" });
    }

    const allocationId = newId();
    await tx.insert(internalTransferAllocations).values({
      id: allocationId,
      transferItemId,
      inventoryLotId: input.inventoryLotId ?? null,
      receivingInvoiceItemId: input.receivingInvoiceItemId ?? null,
      receivingOrderId: null,
      qty,
      manual: true,
    });

    if (input.inventoryLotId) {
      await recomputeLot(tx, input.inventoryLotId);
    }
    await recomputeTransferItem(tx, transferItemId);

    await tx.insert(inventoryTransactions).values({
      id: newId(),
      inventoryLotId: input.inventoryLotId ?? null,
      partNo: source.partNo,
      shelfCode: source.shelfCode,
      boxId: source.boxId,
      txnType: "RESERVE",
      qtyType: "reserved",
      qtyDelta: qty,
      dateCode: source.dateCode,
      lotCode: source.lotCode,
      coo: source.coo,
      cow: source.cow,
      referenceType: "internal_transfer_allocation",
      referenceId: allocationId,
      receivingInvoiceItemId: input.receivingInvoiceItemId ?? null,
      actorId,
      txnReason: "admin: manual allocation",
      txnAt: now(),
    });

    await refreshTransferAllocationStatus(tx);

    await logTransition(tx, {
      entityType: "internal_transfer_order",
      entityId: transferOrderId,
      fromState: order.status,
      toState: order.status,
      actorId,
      metadata: {
        action: "manual_allocation",
        allocationId,
        itemId: transferItemId,
        partNo: item.partNo,
        qty,
        inventoryLotId: input.inventoryLotId ?? null,
        receivingInvoiceItemId: input.receivingInvoiceItemId ?? null,
      },
    });

    await emitEvent(tx, {
      type: "allocation.computed",
      topics: ["/internal-transfer-orders"],
      data: { scope: "internal-transfer-order-item", transferOrderId, transferItemId, allocationId, manual: true, qty },
    });

    return { allocationId, qty };
  });
}
