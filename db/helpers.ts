import { sql } from "drizzle-orm";

export const availableReceivingQtySql = sql`
  rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) - COALESCE(alloc.unboxed_scanned_qty, 0)
`;

/**
 * Returns per-item reservation totals used by `availableReceivingQtySql`.
 * Includes picking allocations plus unboxed put-away scans, both of which
 * reserve quantity from the receiving item.
 */
export function allocationsCte() {
  return sql`
    SELECT
      receiving_invoice_item_id,
      SUM(allocated_qty) AS allocated_qty,
      SUM(unboxed_scanned_qty) AS unboxed_scanned_qty
    FROM (
      SELECT
        receiving_invoice_item_id,
        SUM(qty) AS allocated_qty,
        0 AS unboxed_scanned_qty
      FROM allocations
      WHERE receiving_invoice_item_id IS NOT NULL
      GROUP BY receiving_invoice_item_id
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
