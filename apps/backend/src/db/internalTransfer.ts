import { sql } from "drizzle-orm";
import { queryAll, queryGet, type DbOrTx } from "./query.js";

// ---------------------------------------------------------------------------
// Internal transfer orders — read-only view for the admin console.
// Upstream sync (external service, like the cancel_invoice tables) writes
// internal_transfer_orders / internal_transfer_items; the PDA/admin flow
// itself is not built yet (spec 2026-09-28-internal-transfer-order-design.md
// is at schema stage). These are the first consumers of the synced data.
// ---------------------------------------------------------------------------

/**
 * Order page (newest first) with per-order item aggregates.
 * Server-paged like GET /admin/picking-orders: `page` is 1-based,
 * `pageSize` capped at 200 (same convention as the crud endpoints);
 * `total` counts the whole filtered set.
 */
export async function listInternalTransferOrders(
  db: DbOrTx,
  filter?: { status?: string; search?: string; page?: number; pageSize?: number }
): Promise<{ rows: unknown[]; total: number }> {
  const pageSize = Math.min(Math.max(Math.floor(filter?.pageSize ?? 50), 1), 200);
  const page = Math.max(Math.floor(filter?.page ?? 1), 1);
  const rows = await queryAll<Record<string, unknown>>(
    db,
    sql`SELECT COUNT(*) OVER ()::int AS total, o.id, o.order_no AS "orderNo",
               o.from_org_id AS "fromOrgId", o.from_sub_inventory_code AS "fromSubInventoryCode",
               o.to_org_id AS "toOrgId", o.to_sub_inventory_code AS "toSubInventoryCode",
               o.status, o.allocation_status AS "allocationStatus",
               o.customer_name AS "customerName", o.remark,
               o.created_date AS "createdDate", o.last_update_date AS "lastUpdateDate",
               (SELECT COUNT(*)::int FROM internal_transfer_items i WHERE i.transfer_order_id = o.id) AS "itemCount",
               (SELECT COALESCE(SUM(i.qty), 0)::int FROM internal_transfer_items i WHERE i.transfer_order_id = o.id) AS "totalQty",
               (SELECT COALESCE(SUM(i.picked_qty), 0)::int FROM internal_transfer_items i WHERE i.transfer_order_id = o.id) AS "pickedQty",
               (SELECT COALESCE(SUM(i.allocated_qty), 0)::int FROM internal_transfer_items i WHERE i.transfer_order_id = o.id) AS "allocatedQty"
        FROM internal_transfer_orders o
        WHERE (${filter?.status ?? null}::text IS NULL OR o.status = ${filter?.status ?? null})
          AND (${filter?.search ?? null}::text IS NULL
               OR o.order_no ILIKE '%' || ${filter?.search ?? null} || '%'
               OR o.customer_name ILIKE '%' || ${filter?.search ?? null} || '%')
        ORDER BY o.created_date DESC, o.order_no
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
  );
  const total = rows.length > 0 ? (rows[0].total as number) : 0;
  for (const row of rows) delete row.total;
  return { rows, total };
}

/** One order + its item lines. Returns null when the id is unknown. */
export async function getInternalTransferOrder(
  db: DbOrTx,
  id: string
): Promise<{ order: Record<string, unknown>; items: unknown[] } | null> {
  const order = await queryGet<Record<string, unknown>>(
    db,
    sql`SELECT id, order_no AS "orderNo",
               from_org_id AS "fromOrgId", from_sub_inventory_code AS "fromSubInventoryCode",
               to_org_id AS "toOrgId", to_sub_inventory_code AS "toSubInventoryCode",
               picking_order_id AS "pickingOrderId", priority_seq AS "prioritySeq",
               status, allocation_status AS "allocationStatus",
               customer_name AS "customerName", remark,
               issue_reason AS "issueReason", issue_qty AS "issueQty",
               issue_note AS "issueNote", issue_remark AS "issueRemark",
               issue_reported_at AS "issueReportedAt",
               additional_data AS "additionalData",
               created_date AS "createdDate", last_update_date AS "lastUpdateDate"
        FROM internal_transfer_orders WHERE id = ${id}`
  );
  if (!order) return null;
  const items = await queryAll(
    db,
    sql`SELECT id, part_no AS "partNo", wcl_item_no AS "wclItemNo",
               qty, picked_qty AS "pickedQty", allocated_qty AS "allocatedQty",
               status, po_no AS "poNo", line_id AS "lineId", line_number AS "lineNumber",
               additional_data AS "additionalData",
               created_date AS "createdDate", last_update_date AS "lastUpdateDate"
        FROM internal_transfer_items
        WHERE transfer_order_id = ${id}
        ORDER BY line_number NULLS LAST, part_no`
  );
  return { order, items };
}
