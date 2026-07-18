import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { queryAll, type DbOrTx } from "./query.js";
import { allocations, inventoryTransactions } from "./schema/index.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Allocation engine (concepts 5-6 in docs/backend/concepts.md).
//
// Demand: open picking items (order status pending/picking, not yet picked).
// Sources, in priority order:
//   1. shelf stock (inventory_lots with available_qty > 0)
//   2. in-hand / provisional receiving stock (received, not yet picked)
// Rules (confirmed with the business):
//   - Date-code rule: if the demand carries one (picking item's
//     required_date_code → picking order's required_date_code_notice →
//     customer profile remark, first match wins), sources must satisfy it;
//     otherwise plain FIFO.
//   - Location: sources must match the picking order's warehouse_code,
//     warehouse_section_code (when set) and sub_inventory_code (when set).
//   - FIFO: oldest date_code first (NULLS LAST).
//   - Box granularity: a receiving line WITH box_id allocates down to that box
//     (receiving_invoice_item_id); a line WITHOUT box_id allocates to the
//     whole receiving order (receiving_order_id).
// The engine is a full idempotent recompute: existing allocations of an
// open item are wiped (RESERVE reversal txns) and rebuilt.
// ---------------------------------------------------------------------------

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
  partId: string;
  openQty: number;
  requiredDateCode: string | null;
  orderNotice: string | null;
  customerRemark: string | null;
  warehouseCode: string;
  warehouseSectionCode: string | null;
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
  boxId: string | null;
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
               pi.part_id AS "partId",
               (pi.qty - pi.picked_qty) AS "openQty",
               pi.required_date_code AS "requiredDateCode",
               po.required_date_code_notice AS "orderNotice",
               cp.remark AS "customerRemark",
               po.warehouse_code AS "warehouseCode",
               po.warehouse_section_code AS "warehouseSectionCode",
               po.sub_inventory_code AS "subInventoryCode"
        FROM picking_items pi
        JOIN picking_orders po ON po.id = pi.picking_order_id
        LEFT JOIN customer_profiles cp ON cp.code = po.customer_code
        WHERE po.status IN ('pending', 'picking')
          AND pi.qty > pi.picked_qty
          AND pi.picked_qty = 0  -- v1: never re-allocate partially picked items
        ORDER BY po.delivery_date NULLS LAST, po.created_at, pi.id`
  );
}

async function loadLotSources(dbOrTx: DbOrTx, d: DemandRow): Promise<LotRow[]> {
  return queryAll<LotRow>(
    dbOrTx,
    sql`SELECT il.id AS "lotId",
               il.date_code AS "dateCode",
               (il.total_qty - il.allocated_qty) AS "available"
        FROM inventory_lots il
        WHERE il.part_id = ${d.partId}
          AND il.warehouse_code = ${d.warehouseCode}
          AND (${d.warehouseSectionCode}::text IS NULL OR il.warehouse_section_code = ${d.warehouseSectionCode})
          AND (${d.subInventoryCode}::text IS NULL OR il.sub_inventory_code = ${d.subInventoryCode})
          AND il.total_qty - il.allocated_qty > 0
        ORDER BY il.date_code ASC NULLS LAST, il.id`
  );
}

async function loadReceivingSources(dbOrTx: DbOrTx, d: DemandRow): Promise<ReceivingRow[]> {
  return queryAll<ReceivingRow>(
    dbOrTx,
    sql`SELECT rii.id AS "receivingInvoiceItemId",
               ro.id AS "receivingOrderId",
               rii.box_id AS "boxId",
               rii.date_code AS "dateCode",
               (rii.received_qty - rii.picked_qty) AS "available"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        WHERE rii.part_id = ${d.partId}
          AND ro.status IN ('in_hand', 'provisional_received')
          AND ro.warehouse_code = ${d.warehouseCode}
          AND (${d.warehouseSectionCode}::text IS NULL OR ro.warehouse_section_code = ${d.warehouseSectionCode})
          AND (${d.subInventoryCode}::text IS NULL OR ro.sub_inventory_code = ${d.subInventoryCode})
          AND (rii.received_qty - rii.picked_qty) > 0
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
      partId: string;
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
                 COALESCE(il.part_id, rii.part_id, pi.part_id) AS "partId",
                 COALESCE(il.date_code, rii.date_code) AS "dateCode",
                 COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
                 COALESCE(il.coo, rii.coo) AS "coo",
                 COALESCE(il.cow, rii.cow) AS "cow",
                 il.shelf_code AS "shelfCode",
                 COALESCE(il.box_id, rii.box_id) AS "boxId"
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          WHERE ${inArray(sql`a.picking_item_id`, itemIds)}`
    );
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
        partId: a.partId,
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

    // Rebuild per demand.
    // In-run availability trackers (sources are shared across demands).
    const lotUsed = new Map<string, number>(); // lotId → qty allocated this run
    const recvUsed = new Map<string, number>(); // receiving source key → qty allocated this run

    for (const d of demands) {
      const rule =
        parseDateCodeRule(d.requiredDateCode) ??
        parseDateCodeRule(d.orderNotice) ??
        parseDateCodeRule(d.customerRemark);

      let remaining = d.openQty;
      const allocatedForItem: { qty: number; lotId?: string; recv?: ReceivingRow }[] = [];

      // 1. shelf stock, FIFO by date_code
      const lots = (await loadLotSources(tx, d)).filter((l) => !rule || rule(l.dateCode));
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
        const rows = (await loadReceivingSources(tx, d)).filter((r) => !rule || rule(r.dateCode));
        for (const r of rows) {
          if (remaining <= 0) break;
          // box-level sources track per item; order-level sources pool per order+part
          const key = r.boxId ? `item:${r.receivingInvoiceItemId}` : `order:${r.receivingOrderId}:${d.partId}`;
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
          receivingInvoiceItemId: alloc.recv?.boxId ? alloc.recv.receivingInvoiceItemId : null,
          receivingOrderId: alloc.recv && !alloc.recv.boxId ? alloc.recv.receivingOrderId : null,
          qty: alloc.qty,
        });
        summary.allocationsCreated += 1;
        if (alloc.lotId) {
          lotDelta.set(alloc.lotId, (lotDelta.get(alloc.lotId) ?? 0) + alloc.qty);
        }
        txnRows.push({
          id: randomUUID(),
          inventoryLotId: alloc.lotId ?? null,
          partId: d.partId,
          shelfCode: null,
          boxId: alloc.recv?.boxId ?? null,
          txnType: "RESERVE",
          qtyType: "reserved",
          qtyDelta: alloc.qty,
          dateCode: alloc.recv?.dateCode ?? null,
          referenceType: "allocation",
          referenceId: id,
          receivingInvoiceItemId: alloc.recv?.boxId ? alloc.recv.receivingInvoiceItemId : null,
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
    return summary;
  });
}
