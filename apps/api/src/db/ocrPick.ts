import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  type DbOrTx,
  createAllocation,
  linkAllocation,
  recomputePickingItem,
  recomputeReceivingItem,
} from "./invariants.js";
import { now } from "./now.js";
import { scanAllocation } from "./pickScan.js";

/**
 * One scan of a supplier label applies qty to a picking item straight from a
 * receiving order: find-or-create the order-level allocation, top it up and
 * FIFO-link the receiving invoice items, then scan it into packages.
 * Allocation is FIFO — the OCR-parsed date/lot/coo/cow are informational only
 * and never filter the portions (matches the web's applyOcrPick behavior).
 */
export function applyOcrPick(
  tx: DbOrTx,
  receivingOrderId: string,
  req: { pickingItemId: string; qty: number; actorId?: string | null }
): { packageIds: string[] } {
  if (!Number.isInteger(req.qty) || req.qty <= 0)
    throw new HTTPException(400, { message: "qty must be a positive integer" });

  const ro = tx.get<{ id: string; status: string }>(
    sql`SELECT id, status FROM receiving_orders WHERE id = ${receivingOrderId}`
  );
  if (!ro) throw new HTTPException(404, { message: "receiving order not found" });
  if (ro.status !== "in_hand") throw new HTTPException(409, { message: "receiving order is not in_hand" });

  const item = tx.get<{
    id: string; partId: string; qty: number; pickedQty: number;
    scannedNotBoxedQty: number; allocatedQty: number; remainingQty: number;
  }>(
    sql`SELECT id, part_id AS partId, qty, picked_qty AS pickedQty,
               scanned_not_boxed_qty AS scannedNotBoxedQty, allocated_qty AS allocatedQty,
               remaining_qty AS remainingQty
        FROM picking_items WHERE id = ${req.pickingItemId}`
  );
  if (!item) throw new HTTPException(404, { message: "picking item not found" });

  const partInOrder = tx.get<{ ok: number }>(sql`
    SELECT 1 AS ok
    FROM receiving_invoices ri
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    WHERE ri.receiving_order_id = ${receivingOrderId} AND rii.part_id = ${item.partId}
    LIMIT 1`);
  if (!partInOrder) throw new HTTPException(409, { message: "picking item part is not on this receiving order" });

  if (req.qty > item.remainingQty)
    throw new HTTPException(409, { message: "qty exceeds the remaining picking need" });

  // Part-level availability, mirroring the web's applyOcrPick formula exactly:
  // physical − reserved-by-others − unboxed. The item's OWN allocation is not
  // subtracted (ingested picking orders are auto-allocated by the PUT route, so
  // counting it would false-reject the primary scan path).
  const availability = tx.get<{ physical: number; reservedByOthers: number; unboxed: number }>(sql`
    SELECT
      COALESCE(SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty), 0) AS physical,
      COALESCE((
        SELECT SUM(a.qty)
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE a.receiving_order_id = ${receivingOrderId}
          AND pi.part_id = ${item.partId}
          AND a.picking_item_id != ${req.pickingItemId}
      ), 0) AS reservedByOthers,
      (
        SELECT COALESCE(SUM(pas.qty), 0)
        FROM put_away_scans pas
        JOIN receiving_invoice_items rii2 ON rii2.id = pas.receiving_invoice_item_id
        JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
        WHERE ri2.receiving_order_id = ${receivingOrderId}
          AND rii2.part_id = ${item.partId}
          AND pas.shelf_box_id IS NULL
      ) AS unboxed
    FROM receiving_invoices ri
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    WHERE ri.receiving_order_id = ${receivingOrderId} AND rii.part_id = ${item.partId}`)!;
  if (req.qty > availability.physical - availability.reservedByOthers - availability.unboxed)
    throw new HTTPException(409, { message: "qty not available on this receiving order" });

  // Find-or-create the order-level allocation (XOR CHECK: receiving_order_id set, inventory_lot_id NULL).
  let allocation = tx.get<{ id: string; qty: number }>(sql`
    SELECT id, qty FROM allocations
    WHERE picking_item_id = ${req.pickingItemId} AND receiving_order_id = ${receivingOrderId}
    ORDER BY created_at ASC, id ASC LIMIT 1`);
  const left = Math.max(0, req.qty - (allocation?.qty ?? 0));
  if (left > 0) {
    const unallocatedDemand = item.remainingQty - item.allocatedQty;
    if (left > unallocatedDemand)
      throw new HTTPException(409, { message: "qty exceeds the unallocated picking need" });

    let allocationId: string;
    if (allocation) {
      allocationId = allocation.id;
      tx.run(sql`UPDATE allocations SET qty = qty + ${left}, updated_at = ${now()} WHERE id = ${allocationId}`);
      recomputePickingItem(tx, req.pickingItemId);
    } else {
      allocationId = crypto.randomUUID();
      createAllocation(tx, { id: allocationId, pickingItemId: req.pickingItemId, qty: left, receivingOrderId });
    }
    allocation = { id: allocationId, qty: (allocation?.qty ?? 0) + left };

    // FIFO-link the top-up across this RO's invoice items with available_qty > 0.
    const riis = tx.all<{ id: string; availableQty: number }>(sql`
      SELECT rii.id AS id, rii.available_qty AS availableQty
      FROM receiving_orders ro
      JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      WHERE ro.id = ${receivingOrderId} AND rii.part_id = ${item.partId} AND rii.available_qty > 0
      ORDER BY ro.delivery_date ASC NULLS LAST, ri.invoice_no ASC, rii.date_code ASC NULLS LAST`);
    let need = left;
    for (const rii of riis) {
      if (need <= 0) break;
      const take = Math.min(need, rii.availableQty);
      if (take <= 0) continue;
      // UNIQUE(allocation_id, receiving_invoice_item_id): a consumed link from an
      // earlier scan may still exist at qty 0 — bump it instead of inserting.
      const link = tx.get<{ id: string }>(sql`
        SELECT id FROM allocation_receiving_items
        WHERE allocation_id = ${allocationId} AND receiving_invoice_item_id = ${rii.id}`);
      if (link) {
        tx.run(sql`UPDATE allocation_receiving_items SET qty = qty + ${take}, updated_at = ${now()} WHERE id = ${link.id}`);
        recomputeReceivingItem(tx, rii.id);
      } else {
        linkAllocation(tx, { id: crypto.randomUUID(), allocationId, receivingInvoiceItemId: rii.id, qty: take });
      }
      need -= take;
    }
    if (need > 0) throw new HTTPException(409, { message: "receiving invoice items under-cover the requested qty" });
  }

  return scanAllocation(tx, { allocationId: allocation!.id, qty: req.qty, actorId: req.actorId ?? null });
}
