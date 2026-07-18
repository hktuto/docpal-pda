import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  type DbOrTx,
  createAllocation,
  recomputePickingItem,
} from "./invariants.js";
import { queryAll, queryGet, queryRun } from "./query.js";
import { scanAllocation } from "./pickScan.js";

/**
 * One scan of a supplier label applies qty to a picking item straight from a
 * receiving order: top up the item's single-level allocations on this order's
 * invoice items (FIFO), then scan them into packages (one scanAllocation, i.e.
 * one package, per allocation row). Allocation is FIFO — the OCR-parsed
 * date/lot/coo/cow are informational only and never filter the portions
 * (matches the web's applyOcrPick behavior).
 */
export async function applyOcrPick(
  tx: DbOrTx,
  receivingOrderId: string,
  req: { pickingItemId: string; qty: number; actorId?: string | null }
): Promise<{ packageIds: string[] }> {
  if (!Number.isInteger(req.qty) || req.qty <= 0)
    throw new HTTPException(400, { message: "qty must be a positive integer" });

  const ro = await queryGet<{ id: string; status: string }>(
    tx,
    sql`SELECT id, status FROM receiving_orders WHERE id = ${receivingOrderId}`
  );
  if (!ro) throw new HTTPException(404, { message: "receiving order not found" });
  if (ro.status !== "in_hand") throw new HTTPException(409, { message: "receiving order is not in_hand" });

  const item = await queryGet<{
    id: string; partId: string; qty: number; packagedQty: number; allocatedQty: number;
  }>(
    tx,
    sql`SELECT pi.id, pi.part_id AS "partId", pi.qty, pi.allocated_qty AS "allocatedQty",
          COALESCE((SELECT SUM(pp.qty)::int FROM picking_packages pp WHERE pp.picking_item_id = pi.id), 0) AS "packagedQty"
        FROM picking_items pi WHERE pi.id = ${req.pickingItemId}`
  );
  if (!item) throw new HTTPException(404, { message: "picking item not found" });
  // remaining need is computed (no remaining_qty column anymore).
  const remainingQty = item.qty - item.packagedQty;

  const partInOrder = await queryGet<{ ok: number }>(tx, sql`
    SELECT 1 AS ok
    FROM receiving_invoices ri
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    WHERE ri.receiving_order_id = ${receivingOrderId} AND rii.part_id = ${item.partId}
    LIMIT 1`);
  if (!partInOrder) throw new HTTPException(409, { message: "picking item part is not on this receiving order" });

  if (req.qty > remainingQty)
    throw new HTTPException(409, { message: "qty exceeds the remaining picking need" });

  // Part-level availability, mirroring the web's applyOcrPick formula exactly:
  // physical − reserved-by-others − staged. The item's OWN allocations are not
  // subtracted (ingested picking orders are auto-allocated by the PUT route, so
  // counting them would false-reject the primary scan path). "staged" = pieces
  // sitting in the order's staging box (shelf_boxes with shelf_code IS NULL).
  const availability = (await queryGet<{ physical: number; reservedByOthers: number; staged: number }>(tx, sql`
    SELECT
      COALESCE(SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty)::int, 0) AS physical,
      COALESCE((
        SELECT SUM(a.qty)::int
        FROM allocations a
        JOIN receiving_invoice_items rii2 ON rii2.id = a.receiving_invoice_item_id
        JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
        JOIN picking_items pi2 ON pi2.id = a.picking_item_id
        WHERE ri2.receiving_order_id = ${receivingOrderId}
          AND pi2.part_id = ${item.partId}
          AND a.picking_item_id != ${req.pickingItemId}
      ), 0) AS "reservedByOthers",
      COALESCE((
        SELECT SUM(sbi.qty)::int
        FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id AND sb.shelf_code IS NULL
        JOIN receiving_invoice_items rii3 ON rii3.id = sbi.receiving_invoice_item_id
        JOIN receiving_invoices ri3 ON ri3.id = rii3.receiving_invoice_id
        WHERE ri3.receiving_order_id = ${receivingOrderId}
          AND rii3.part_id = ${item.partId}
      ), 0) AS staged
    FROM receiving_invoices ri
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    WHERE ri.receiving_order_id = ${receivingOrderId} AND rii.part_id = ${item.partId}`))!;
  if (req.qty > availability.physical - availability.reservedByOthers - availability.staged)
    throw new HTTPException(409, { message: "qty not available on this receiving order" });

  // Coverage = Σ this item's allocations pointing at this order's invoice items.
  const covered = (await queryGet<{ s: number }>(tx, sql`
    SELECT COALESCE(SUM(a.qty)::int, 0) AS s
    FROM allocations a
    JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE a.picking_item_id = ${req.pickingItemId} AND ri.receiving_order_id = ${receivingOrderId}`))!;
  const left = Math.max(0, req.qty - covered.s);
  if (left > 0) {
    const unallocatedDemand = remainingQty - item.allocatedQty;
    if (left > unallocatedDemand)
      throw new HTTPException(409, { message: "qty exceeds the unallocated picking need" });

    // FIFO top-up across this RO's invoice items with computed availability
    // (received − picked − put_away − Σ allocations) > 0. One single-level
    // allocation row per rii; a fully-consumed row from an earlier scan may
    // still exist at qty 0 — bump it instead of inserting a duplicate.
    const riis = await queryAll<{ id: string; availableQty: number }>(tx, sql`
      SELECT rii.id,
        rii.received_qty - rii.picked_qty - rii.put_away_qty
          - COALESCE((SELECT SUM(a.qty)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id), 0) AS "availableQty"
      FROM receiving_invoices ri
      JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
      WHERE ri.receiving_order_id = ${receivingOrderId} AND rii.part_id = ${item.partId}
      ORDER BY ri.invoice_no ASC, rii.date_code ASC NULLS LAST, rii.id ASC`);
    let need = left;
    for (const rii of riis) {
      if (need <= 0) break;
      const take = Math.min(need, rii.availableQty);
      if (take <= 0) continue;
      const existing = await queryGet<{ id: string }>(tx, sql`
        SELECT id FROM allocations
        WHERE picking_item_id = ${req.pickingItemId} AND receiving_invoice_item_id = ${rii.id}`);
      if (existing) {
        await queryRun(tx, sql`UPDATE allocations SET qty = qty + ${take}, updated_at = now() WHERE id = ${existing.id}`);
        await recomputePickingItem(tx, req.pickingItemId);
      } else {
        await createAllocation(tx, { id: crypto.randomUUID(), pickingItemId: req.pickingItemId, qty: take, receivingInvoiceItemId: rii.id });
      }
      need -= take;
    }
    if (need > 0) throw new HTTPException(409, { message: "receiving invoice items under-cover the requested qty" });
  }

  // Scan the covered qty into packages: FIFO over this item's allocations on
  // this order (invoice order, like the old link-consumption order).
  const allocs = await queryAll<{ id: string; qty: number }>(tx, sql`
    SELECT a.id, a.qty
    FROM allocations a
    JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE a.picking_item_id = ${req.pickingItemId} AND ri.receiving_order_id = ${receivingOrderId} AND a.qty > 0
    ORDER BY ri.invoice_no ASC, rii.date_code ASC NULLS LAST, rii.id ASC`);
  const packageIds: string[] = [];
  let remaining = req.qty;
  for (const alloc of allocs) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, alloc.qty);
    const r = await scanAllocation(tx, { allocationId: alloc.id, qty: take, actorId: req.actorId ?? null });
    packageIds.push(...r.packageIds);
    remaining -= take;
  }
  if (remaining > 0) throw new HTTPException(409, { message: "allocations under-cover the requested qty" });
  return { packageIds };
}
