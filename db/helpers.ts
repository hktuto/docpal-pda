import { sql } from "drizzle-orm";

export const availableReceivingQtySql = sql`
  rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.allocated_qty, 0)
`;

export function allocationsCte() {
  return sql`
    SELECT receiving_invoice_item_id, SUM(qty) AS allocated_qty
    FROM allocations
    WHERE receiving_invoice_item_id IS NOT NULL
    GROUP BY receiving_invoice_item_id
  `;
}
