import { sql } from "drizzle-orm";
import type { DbOrTx } from "./invariants.js";
import { queryAll } from "./query.js";

/**
 * Invariant contract:
 * - picking_items.allocated_qty = Σ allocations.qty per picking item (maintained).
 * - picking_items.picked_qty = Σ picking_packages.qty where boxed (maintained).
 * - inventory_lots.allocated_qty = Σ allocations.qty per lot (maintained);
 *   available_qty is generated, so only non-negativity is checked.
 * - rii computed availability (received - picked - put_away - Σ allocations) >= 0.
 * - every allocation has exactly one source set (inventory_lot_id XOR receiving_invoice_item_id).
 */
export async function assertInvariantsHold(tx: DbOrTx): Promise<void> {
  const pi = await queryAll<{ id: string; sAlloc: number; sPicked: number; eAlloc: number; ePicked: number }>(tx, sql`
    SELECT pi.id,
      pi.allocated_qty AS "sAlloc", pi.picked_qty AS "sPicked",
      COALESCE((SELECT SUM(qty)::int FROM allocations WHERE picking_item_id = pi.id), 0) AS "eAlloc",
      COALESCE((SELECT SUM(qty)::int FROM picking_packages WHERE picking_item_id = pi.id AND shipping_box_id IS NOT NULL), 0) AS "ePicked"
    FROM picking_items pi`);
  for (const r of pi) {
    if (r.sAlloc !== r.eAlloc) throw new Error(`picking ${r.id}: allocated stored ${r.sAlloc} expected ${r.eAlloc}`);
    if (r.sPicked !== r.ePicked) throw new Error(`picking ${r.id}: picked stored ${r.sPicked} expected ${r.ePicked}`);
  }

  const lots = await queryAll<{ id: string; sAlloc: number; sAvail: number; eAlloc: number }>(tx, sql`
    SELECT l.id,
      l.allocated_qty AS "sAlloc", l.available_qty AS "sAvail",
      COALESCE((SELECT SUM(qty)::int FROM allocations WHERE inventory_lot_id = l.id), 0) AS "eAlloc"
    FROM inventory_lots l`);
  for (const r of lots) {
    if (r.sAlloc !== r.eAlloc) throw new Error(`lot ${r.id}: allocated stored ${r.sAlloc} expected ${r.eAlloc}`);
    if (r.sAvail < 0) throw new Error(`lot ${r.id}: negative available ${r.sAvail}`);
  }

  const rii = await queryAll<{ id: string; avail: number }>(tx, sql`
    SELECT rii.id,
      rii.received_qty - rii.picked_qty - rii.put_away_qty
        - COALESCE((SELECT SUM(qty)::int FROM allocations WHERE receiving_invoice_item_id = rii.id), 0) AS avail
    FROM receiving_invoice_items rii`);
  for (const r of rii) {
    if (r.avail < 0) throw new Error(`receiving ${r.id}: negative available ${r.avail}`);
  }

  const allocs = await queryAll<{ id: string; lotId: string | null; riiId: string | null }>(tx, sql`
    SELECT id, inventory_lot_id AS "lotId", receiving_invoice_item_id AS "riiId" FROM allocations`);
  for (const a of allocs) {
    if ((a.lotId !== null) === (a.riiId !== null))
      throw new Error(`allocation ${a.id}: exactly one source required (lot=${a.lotId}, rii=${a.riiId})`);
  }
}
