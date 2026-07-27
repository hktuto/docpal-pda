import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, type DbOrTx } from "./query.js";
import { allocations, inventoryTransactions } from "./schema/index.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Allocation engine (concepts 5-6 in docs/backend/concepts.md).
//
// Demand: open picking items (order status pending/picking) whose order is NOT
// protected by a live work lock (a PDA has the order open — see
// WORK_LOCK_TTL_MINUTES). Open qty = qty − Σ picking_packages (boxed or not —
// scanned-but-unboxed packages must not be re-reserved).
// Sources, in priority order:
//   1. shelf stock (inventory_lots with available_qty > 0)
//   2. in-hand / provisional receiving stock (received, not yet picked)
// Rules (confirmed with the business):
//   - Order: demands are allocated in picking_orders.priority_seq order
//     (admin-reorderable via POST /picking-orders/reorder).
//   - Location: the picking order's (org_id, sub_inventory_code) pair must
//     match the source's pair — lots match on their own pair, receiving
//     sources on the receiving order's pair. A demand without the pair
//     (both columns NULL) is org-agnostic and matches any source. The code
//     match is widened by sub_inventory_share_members: a source whose
//     sub-inventory shares a share_group with the demand's sub-inventory
//     (same org) also matches.
//   - Customer segregation: a source in a sub-inventory with
//     sub_inventories.customer_code only allocates to picking orders of that
//     customer (customer_profiles.rule stays stored-not-interpreted).
//   - FIFO: oldest date_code first (NULLS LAST).
//   - Box granularity: a receiving line WITH ctn_no allocates down to that box
//     (receiving_invoice_item_id); a line WITHOUT ctn_no allocates to the
//     whole receiving order (receiving_order_id).
// The engine is a full idempotent recompute: existing allocations of an
// unlocked open item are wiped (RESERVE reversal txns) and rebuilt.
// ---------------------------------------------------------------------------

/** A work lock older than this is treated as expired (no cron — compared at recompute/acquire time). */
export const WORK_LOCK_TTL_MINUTES = 10;

export function workLockExpiry(ref: Date = new Date()): Date {
  return new Date(ref.getTime() - WORK_LOCK_TTL_MINUTES * 60_000);
}

export type DateCodeRule = (dateCode: string | null) => boolean;

const YYMM = /(\d{4})/;

function yymm(d: Date): string {
  return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Parse a free-text date-code requirement into a predicate on YYMM date codes.
 * Supported forms:
 *   "2601"                        → exact match
 *   "2601+"                       → date_code >= 2601
 *   "2601-"                       → date_code <= 2601
 *   "within/last/less than N year(s)"  → date_code >= YYMM(N years ago)
 *   "more than N year(s)"              → date_code <  YYMM(N years ago)
 * Returns null when the text carries no recognizable rule (→ plain FIFO).
 *
 * Note: not currently wired into allocateAll — no demand-side date-code rule
 * column remains in the schema (customer_profiles.rule is stored but not yet
 * interpreted). Kept for the future rule interpretation.
 */
export function parseDateCodeRule(text: string | null | undefined, ref: Date = new Date()): DateCodeRule | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();

  const yearsAgo = (n: number) => {
    const d = new Date(Date.UTC(ref.getUTCFullYear() - n, ref.getUTCMonth(), 1));
    return yymm(d);
  };

  const yearMatch = t.match(/(\d+)\s*(?:\+)?\s*years?/);
  if (yearMatch && /(within|last|less than|under|以[内下])/i.test(t)) {
    const threshold = yearsAgo(Number(yearMatch[1]));
    return (dc) => dc !== null && dc >= threshold;
  }
  if (yearMatch && /(more than|over|older than|以上|超过)/i.test(t)) {
    const threshold = yearsAgo(Number(yearMatch[1]));
    return (dc) => dc !== null && dc < threshold;
  }

  const m = t.match(YYMM);
  if (m) {
    const code = m[1];
    if (t.includes("+")) return (dc) => dc !== null && dc >= code;
    if (t.includes("-")) return (dc) => dc !== null && dc <= code;
    return (dc) => dc === code;
  }
  return null;
}

interface DemandRow {
  pickingItemId: string;
  partNo: string;
  openQty: number;
  customerCode: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
}

interface LotRow {
  lotId: string;
  dateCode: string | null;
  available: number;
}

interface ReceivingRow {
  receivingInvoiceItemId: string;
  receivingOrderId: string;
  ctnNo: string | null;
  dateCode: string | null;
  available: number;
}

export interface AllocateSummary {
  demands: number;
  fullyAllocated: number;
  partiallyAllocated: number;
  allocationsCreated: number;
  allocationsRemoved: number;
}

async function loadDemands(dbOrTx: DbOrTx): Promise<DemandRow[]> {
  return queryAll<DemandRow>(
    dbOrTx,
    sql`SELECT pi.id AS "pickingItemId",
               pi.part_no AS "partNo",
               (pi.qty - COALESCE(pkg.qty, 0)) AS "openQty",
               po.customer_code AS "customerCode",
               po.org_id AS "orgId",
               po.sub_inventory_code AS "subInventoryCode"
        FROM picking_items pi
        JOIN picking_orders po ON po.id = pi.picking_order_id
        LEFT JOIN (
          SELECT picking_item_id, SUM(qty)::int AS qty
          FROM picking_packages GROUP BY picking_item_id
        ) pkg ON pkg.picking_item_id = pi.id
        WHERE po.status IN ('pending', 'picking')
          AND (po.working_by IS NULL OR po.working_at IS NULL OR po.working_at < ${workLockExpiry()})
          AND pi.qty > COALESCE(pkg.qty, 0)
        ORDER BY po.priority_seq, po.delivery_date NULLS LAST, po.order_no, pi.id`
  );
}

async function loadLotSources(dbOrTx: DbOrTx, d: DemandRow): Promise<LotRow[]> {
  return queryAll<LotRow>(
    dbOrTx,
    sql`SELECT il.id AS "lotId",
               il.date_code AS "dateCode",
               (il.total_qty - il.allocated_qty) AS "available"
        FROM inventory_lots il
        LEFT JOIN sub_inventories si ON si.org_id = il.org_id AND si.code = il.sub_inventory_code
        WHERE il.part_no = ${d.partNo}
          AND (${d.orgId}::int IS NULL OR il.org_id = ${d.orgId})
          AND (${d.subInventoryCode}::text IS NULL
               OR il.sub_inventory_code = ${d.subInventoryCode}
               OR EXISTS (SELECT 1 FROM sub_inventory_share_members sm_d
                          JOIN sub_inventory_share_members sm_s ON sm_s.share_group = sm_d.share_group
                          WHERE sm_d.org_id = ${d.orgId} AND sm_d.code = ${d.subInventoryCode}
                            AND sm_s.org_id = il.org_id AND sm_s.code = il.sub_inventory_code))
          AND (si.customer_code IS NULL OR si.customer_code = ${d.customerCode})
          AND il.total_qty - il.allocated_qty > 0
        ORDER BY il.date_code ASC NULLS LAST, il.id`
  );
}

async function loadReceivingSources(dbOrTx: DbOrTx, d: DemandRow): Promise<ReceivingRow[]> {
  // Availability must net out allocations held by work-locked orders (their
  // rows survive the wipe). Lot sources get this for free via
  // inventory_lots.allocated_qty; receiving sources have no such counter.
  const expiry = workLockExpiry();
  return queryAll<ReceivingRow>(
    dbOrTx,
    sql`SELECT rii.id AS "receivingInvoiceItemId",
               ro.id AS "receivingOrderId",
               rii.ctn_no AS "ctnNo",
               rii.date_code AS "dateCode",
               (rii.received_qty - rii.picked_qty
                 - COALESCE(locked_ii.qty, 0) - COALESCE(locked_ro.qty, 0)) AS "available"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        LEFT JOIN sub_inventories si ON si.org_id = ro.org_id AND si.code = ro.sub_inventory_code
        LEFT JOIN (
          SELECT a.receiving_invoice_item_id AS rii_id, SUM(a.qty)::int AS qty
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          WHERE a.receiving_invoice_item_id IS NOT NULL
            AND po.working_by IS NOT NULL AND po.working_at >= ${expiry}
          GROUP BY a.receiving_invoice_item_id
        ) locked_ii ON locked_ii.rii_id = rii.id
        LEFT JOIN (
          SELECT a.receiving_order_id AS ro_id, SUM(a.qty)::int AS qty
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          WHERE a.receiving_order_id IS NOT NULL AND pi.part_no = ${d.partNo}
            AND po.working_by IS NOT NULL AND po.working_at >= ${expiry}
          GROUP BY a.receiving_order_id
        ) locked_ro ON locked_ro.ro_id = ro.id
        WHERE rii.part_no = ${d.partNo}
          AND ro.status IN ('in_hand', 'provisional_received')
          AND (${d.orgId}::int IS NULL OR ro.org_id = ${d.orgId})
          AND (${d.subInventoryCode}::text IS NULL
               OR ro.sub_inventory_code = ${d.subInventoryCode}
               OR EXISTS (SELECT 1 FROM sub_inventory_share_members sm_d
                          JOIN sub_inventory_share_members sm_s ON sm_s.share_group = sm_d.share_group
                          WHERE sm_d.org_id = ${d.orgId} AND sm_d.code = ${d.subInventoryCode}
                            AND sm_s.org_id = ro.org_id AND sm_s.code = ro.sub_inventory_code))
          AND (si.customer_code IS NULL OR si.customer_code = ${d.customerCode})
          AND (rii.received_qty - rii.picked_qty
                - COALESCE(locked_ii.qty, 0) - COALESCE(locked_ro.qty, 0)) > 0
        ORDER BY rii.date_code ASC NULLS LAST, rii.id`
  );
}

/** Full idempotent recompute of allocations for all open picking items. */
export async function allocateAll(db: AppDb): Promise<AllocateSummary> {
  return db.transaction(async (tx) => {
    const summary: AllocateSummary = {
      demands: 0,
      fullyAllocated: 0,
      partiallyAllocated: 0,
      allocationsCreated: 0,
      allocationsRemoved: 0,
    };
    const demands = await loadDemands(tx);
    summary.demands = demands.length;
    if (demands.length === 0) return summary;

    // Wipe existing allocations of the participating items (+ RESERVE reversals).
    const itemIds = demands.map((d) => d.pickingItemId);
    const existing = await queryAll<{
      id: string;
      pickingItemId: string;
      inventoryLotId: string | null;
      receivingInvoiceItemId: string | null;
      receivingOrderId: string | null;
      qty: number;
      partNo: string;
      dateCode: string | null;
      lotCode: string | null;
      coo: string | null;
      cow: string | null;
      shelfCode: string | null;
      boxId: string | null;
    }>(
      tx,
      sql`SELECT a.id, a.picking_item_id AS "pickingItemId", a.inventory_lot_id AS "inventoryLotId",
                 a.receiving_invoice_item_id AS "receivingInvoiceItemId",
                 a.receiving_order_id AS "receivingOrderId", a.qty,
                 COALESCE(il.part_no, rii.part_no, pi.part_no) AS "partNo",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode",
                 COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS "coo",
                 COALESCE(il.cow, rii.cow) AS "cow",
                 il.shelf_code AS "shelfCode",
                 COALESCE(il.box_id, rii.ctn_no) AS "boxId"
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          WHERE ${inArray(sql`a.picking_item_id`, itemIds)}`
    );
    // Net-change detection for the SSE event: the wipe-and-rebuild counters
    // are non-zero on every run with open demand, so emit only when the
    // allocation set actually changed (multiset compare of canonical keys).
    const allocationKey = (
      pickingItemId: string,
      inventoryLotId: string | null,
      receivingInvoiceItemId: string | null,
      receivingOrderId: string | null,
      qty: number
    ) => `${pickingItemId}|${inventoryLotId ?? ""}|${receivingInvoiceItemId ?? ""}|${receivingOrderId ?? ""}|${qty}`;
    const beforeKeys = existing.map((a) =>
      allocationKey(a.pickingItemId, a.inventoryLotId, a.receivingInvoiceItemId, a.receivingOrderId, a.qty)
    );
    const afterKeys: string[] = [];
    const txnRows: (typeof inventoryTransactions.$inferInsert)[] = [];
    const lotDelta = new Map<string, number>(); // lotId → allocated_qty delta

    for (const a of existing) {
      summary.allocationsRemoved += 1;
      if (a.inventoryLotId) {
        lotDelta.set(a.inventoryLotId, (lotDelta.get(a.inventoryLotId) ?? 0) - a.qty);
      }
      txnRows.push({
        id: randomUUID(),
        inventoryLotId: a.inventoryLotId,
        partNo: a.partNo,
        shelfCode: a.shelfCode,
        boxId: a.boxId,
        txnType: "RESERVE",
        qtyType: "reserved",
        qtyDelta: -a.qty,
        dateCode: a.dateCode,
        lotCode: a.lotCode,
        coo: a.coo,
        cow: a.cow,
        referenceType: "allocation",
        referenceId: a.id,
        receivingInvoiceItemId: a.receivingInvoiceItemId,
        txnReason: "recompute: release",
        txnAt: now(),
      });
    }
    await tx.execute(
      sql`DELETE FROM allocations WHERE ${inArray(sql`picking_item_id`, itemIds)}`
    );
    // Apply the wipe to lot allocated_qty up front (negative deltas only):
    // the per-demand source queries below must see availability net of the
    // removed reservations — otherwise a priority change makes wiped stock
    // look still-reserved. New allocations accumulate in lotDelta as usual
    // and are applied at the end.
    for (const [lotId, delta] of lotDelta) {
      if (delta === 0) continue;
      await tx.execute(
        sql`UPDATE inventory_lots SET allocated_qty = allocated_qty + ${delta} WHERE id = ${lotId}`
      );
    }
    lotDelta.clear();

    // Rebuild per demand.
    // In-run availability trackers (sources are shared across demands).
    const lotUsed = new Map<string, number>(); // lotId → qty allocated this run
    const recvUsed = new Map<string, number>(); // receiving source key → qty allocated this run

    for (const d of demands) {
      let remaining = d.openQty;
      const allocatedForItem: { qty: number; lotId?: string; recv?: ReceivingRow }[] = [];

      // 1. shelf stock, FIFO by date_code
      const lots = await loadLotSources(tx, d);
      for (const lot of lots) {
        if (remaining <= 0) break;
        const usable = lot.available - (lotUsed.get(lot.lotId) ?? 0);
        if (usable <= 0) continue;
        const take = Math.min(usable, remaining);
        allocatedForItem.push({ qty: take, lotId: lot.lotId });
        lotUsed.set(lot.lotId, (lotUsed.get(lot.lotId) ?? 0) + take);
        remaining -= take;
      }

      // 2. in-hand / provisional receiving stock, FIFO by date_code
      if (remaining > 0) {
        const rows = await loadReceivingSources(tx, d);
        for (const r of rows) {
          if (remaining <= 0) break;
          // box-level sources track per item; order-level sources pool per order+part
          const key = r.ctnNo ? `item:${r.receivingInvoiceItemId}` : `order:${r.receivingOrderId}:${d.partNo}`;
          const usable = r.available - (recvUsed.get(key) ?? 0);
          if (usable <= 0) continue;
          const take = Math.min(usable, remaining);
          allocatedForItem.push({ qty: take, recv: r });
          recvUsed.set(key, (recvUsed.get(key) ?? 0) + take);
          remaining -= take;
        }
      }

      if (allocatedForItem.length === 0) continue;
      if (remaining <= 0) summary.fullyAllocated += 1;
      else summary.partiallyAllocated += 1;

      for (const alloc of allocatedForItem) {
        const id = randomUUID();
        await tx.insert(allocations).values({
          id,
          pickingItemId: d.pickingItemId,
          inventoryLotId: alloc.lotId ?? null,
          receivingInvoiceItemId: alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
          receivingOrderId: alloc.recv && !alloc.recv.ctnNo ? alloc.recv.receivingOrderId : null,
          qty: alloc.qty,
        });
        summary.allocationsCreated += 1;
        afterKeys.push(
          allocationKey(
            d.pickingItemId,
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
          id: randomUUID(),
          inventoryLotId: alloc.lotId ?? null,
          partNo: d.partNo,
          shelfCode: null,
          boxId: alloc.recv?.ctnNo ?? null,
          txnType: "RESERVE",
          qtyType: "reserved",
          qtyDelta: alloc.qty,
          dateCode: alloc.recv?.dateCode ?? null,
          referenceType: "allocation",
          referenceId: id,
          receivingInvoiceItemId: alloc.recv?.ctnNo ? alloc.recv.receivingInvoiceItemId : null,
          txnReason: "recompute: reserve",
          txnAt: now(),
        });
      }
      await tx.execute(
        sql`UPDATE picking_items SET allocated_qty = ${d.openQty - remaining}, updated_at = ${now()} WHERE id = ${d.pickingItemId}`
      );
    }

    // Apply lot allocated_qty deltas and write the ledger.
    for (const [lotId, delta] of lotDelta) {
      if (delta === 0) continue;
      await tx.execute(
        sql`UPDATE inventory_lots SET allocated_qty = allocated_qty + ${delta} WHERE id = ${lotId}`
      );
    }
    if (txnRows.length > 0) {
      await tx.insert(inventoryTransactions).values(txnRows);
    }
    // Demands with no source leave allocated_qty at 0.
    await tx.execute(
      sql`UPDATE picking_items SET allocated_qty = 0, updated_at = ${now()}
          WHERE ${inArray(sql`id`, itemIds)} AND id NOT IN (
            SELECT DISTINCT picking_item_id FROM allocations WHERE ${inArray(sql`picking_item_id`, itemIds)}
          )`
    );
    if (beforeKeys.slice().sort().join("\n") !== afterKeys.slice().sort().join("\n")) {
      await emitEvent(tx, {
        type: "allocation.computed",
        topics: ["/picking-orders"],
        data: { ...summary },
      });
    }
    return summary;
  });
}
