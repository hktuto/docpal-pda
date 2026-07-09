import { sql } from "drizzle-orm";

export const availableReceivingQtySql = sql`
  rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) - COALESCE(alloc.unboxed_scanned_qty, 0)
`;

/**
 * Returns per-item reservation totals used by `availableReceivingQtySql`.
 * Includes picking allocations plus unboxed put-away scans, both of which
 * reserve quantity from the receiving item.
 *
 * Allocations are now at receiving-order + part level, so allocated_qty
 * for a receiving invoice item is the sum of allocations against the same
 * receiving order and same part.
 */
export function allocationsCte() {
  return sql`
    SELECT
      receiving_invoice_item_id,
      SUM(allocated_qty) AS allocated_qty,
      SUM(unboxed_scanned_qty) AS unboxed_scanned_qty
    FROM (
      SELECT
        rii.id AS receiving_invoice_item_id,
        COALESCE(SUM(a.qty), 0) AS allocated_qty,
        0 AS unboxed_scanned_qty
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      JOIN allocations a ON a.receiving_order_id = ri.receiving_order_id
      JOIN picking_items pi ON pi.id = a.picking_item_id
      WHERE pi.part_id = rii.part_id
      GROUP BY rii.id
      UNION ALL
      SELECT
        receiving_invoice_item_id,
        0 AS allocated_qty,
        SUM(qty) AS unboxed_scanned_qty
      FROM put_away_scans
      WHERE shelf_box_id IS NULL
      GROUP BY receiving_invoice_item_id
    ) combined
    GROUP BY receiving_invoice_item_id
  `;
}
