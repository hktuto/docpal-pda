import { sql } from "drizzle-orm";

export const availableReceivingQtySql = sql`
  rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0) - COALESCE(alloc.unboxed_scanned_qty, 0)
`;

/**
 * Returns per-item reservation totals used by `availableReceivingQtySql`.
 * Includes picking allocations plus unboxed put-away scans, both of which
 * reserve quantity from the receiving item.
 *
 * Allocations are now at receiving-order + part level, so the total
 * allocation for a receiving order + part is distributed across that part's
 * invoice items in FIFO order (receiving invoice date, then invoice number,
 * then item date code). This prevents a single order-level allocation from
 * being counted against every invoice item for the same part.
 *
 * @param excludePickingItemId - Optional picking item id to omit from the
 * allocation total. Used when the caller is about to consume quantity on
 * behalf of that picking item, so its own allocation should not count as a
 * reservation.
 */
export function allocationsCte(excludePickingItemId?: string) {
  const excludeClause = excludePickingItemId
    ? sql`AND a.picking_item_id != ${excludePickingItemId}`
    : sql``;
  return sql`
    WITH invoice_items AS (
      SELECT
        rii.id AS receiving_invoice_item_id,
        rii.part_id,
        ri.receiving_order_id,
        (rii.received_qty - rii.picked_qty - rii.put_away_qty) AS gross_qty,
        ROW_NUMBER() OVER (
          PARTITION BY ri.receiving_order_id, rii.part_id
          ORDER BY ro.delivery_date ASC NULLS LAST, ri.invoice_no ASC, rii.date_code ASC NULLS LAST
        ) AS rn
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
    ),
    order_allocations AS (
      SELECT
        a.receiving_order_id,
        pi.part_id,
        COALESCE(SUM(a.qty), 0) AS total_allocated
      FROM allocations a
      JOIN picking_items pi ON pi.id = a.picking_item_id
      WHERE 1 = 1 ${excludeClause}
      GROUP BY a.receiving_order_id, pi.part_id
    ),
    cumulative_gross AS (
      SELECT
        receiving_invoice_item_id,
        part_id,
        receiving_order_id,
        gross_qty,
        SUM(gross_qty) OVER (PARTITION BY receiving_order_id, part_id ORDER BY rn) AS cumulative_gross
      FROM invoice_items
    ),
    allocated_distribution AS (
      SELECT
        c.receiving_invoice_item_id,
        GREATEST(
          0,
          LEAST(
            c.gross_qty,
            oa.total_allocated - (c.cumulative_gross - c.gross_qty)
          )
        ) AS allocated_qty
      FROM cumulative_gross c
      JOIN order_allocations oa
        ON oa.receiving_order_id = c.receiving_order_id
        AND oa.part_id = c.part_id
    )
    SELECT
      receiving_invoice_item_id,
      SUM(allocated_qty) AS allocated_qty,
      SUM(unboxed_scanned_qty) AS unboxed_scanned_qty
    FROM (
      SELECT
        receiving_invoice_item_id,
        allocated_qty,
        0 AS unboxed_scanned_qty
      FROM allocated_distribution
      UNION ALL
      SELECT
        receiving_invoice_item_id,
        0 AS allocated_qty,
        SUM(qty) AS unboxed_scanned_qty
      FROM put_away_scans
      WHERE shelf_box_id IS NULL
        AND receiving_invoice_item_id IS NOT NULL
      GROUP BY receiving_invoice_item_id
    ) combined
    GROUP BY receiving_invoice_item_id
  `;
}
