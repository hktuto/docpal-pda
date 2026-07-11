import { sql } from "drizzle-orm";
import type { DbOrTx } from "./invariants.js";

export function assertInvariantsHold(tx: DbOrTx): void {
  const rii = tx.all<{
    id: string; sAlloc: number; sAvail: number; eAlloc: number; eAvail: number;
  }>(sql`
    SELECT rii.id,
      rii.allocated_qty AS sAlloc, rii.available_qty AS sAvail,
      COALESCE((SELECT SUM(qty) FROM allocation_receiving_items WHERE receiving_invoice_item_id = rii.id), 0) AS eAlloc,
      rii.received_qty - rii.picked_qty - rii.put_away_qty
        - COALESCE((SELECT SUM(qty) FROM allocation_receiving_items WHERE receiving_invoice_item_id = rii.id), 0) AS eAvail
    FROM receiving_invoice_items rii`);
  for (const r of rii) {
    if (r.sAlloc !== r.eAlloc || r.sAvail !== r.eAvail)
      throw new Error(`receiving ${r.id}: stored(alloc=${r.sAlloc},avail=${r.sAvail}) expected(alloc=${r.eAlloc},avail=${r.eAvail})`);
    if (r.sAvail < 0) throw new Error(`receiving ${r.id}: negative available ${r.sAvail}`);
  }

  const pi = tx.all<{
    id: string; sAlloc: number; sScanned: number; sRemaining: number; eAlloc: number; eScanned: number; eRemaining: number;
  }>(sql`
    SELECT pi.id,
      pi.allocated_qty AS sAlloc, pi.scanned_not_boxed_qty AS sScanned, pi.remaining_qty AS sRemaining,
      COALESCE((SELECT SUM(qty) FROM allocations WHERE picking_item_id = pi.id), 0) AS eAlloc,
      COALESCE((SELECT SUM(qty) FROM picking_packages WHERE picking_item_id = pi.id AND shipping_box_id IS NULL), 0) AS eScanned,
      pi.qty - pi.picked_qty - pi.scanned_not_boxed_qty AS eRemaining
    FROM picking_items pi`);
  for (const r of pi) {
    if (r.sAlloc !== r.eAlloc) throw new Error(`picking ${r.id}: allocated stored ${r.sAlloc} expected ${r.eAlloc}`);
    if (r.sScanned !== r.eScanned) throw new Error(`picking ${r.id}: scanned stored ${r.sScanned} expected ${r.eScanned}`);
    if (r.sRemaining !== r.eRemaining) throw new Error(`picking ${r.id}: remaining stored ${r.sRemaining} expected ${r.eRemaining}`);
  }

  const lots = tx.all<{ id: string; sAlloc: number; sAvail: number; eAlloc: number; eAvail: number }>(sql`
    SELECT l.id,
      l.allocated_qty AS sAlloc, l.available_qty AS sAvail, l.total_qty - l.allocated_qty AS eAvail,
      COALESCE((SELECT SUM(qty) FROM allocations WHERE inventory_lot_id = l.id), 0) AS eAlloc
    FROM inventory_lots l`);
  for (const r of lots) {
    if (r.sAlloc !== r.eAlloc) throw new Error(`lot ${r.id}: allocated stored ${r.sAlloc} expected ${r.eAlloc}`);
    if (r.sAvail !== r.eAvail) throw new Error(`lot ${r.id}: available stored ${r.sAvail} expected ${r.eAvail}`);
    if (r.sAvail < 0) throw new Error(`lot ${r.id}: negative available ${r.sAvail}`);
  }
}
