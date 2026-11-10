import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import { logTransition } from "./picking.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";

// ---------------------------------------------------------------------------
// Internal transfer orders — admin console view + the stage-1 mutations
// (spec 2026-11-10-internal-transfer-admin-allocate-design.md): delegated
// picking order assignment. The allocation engine lives in
// internalTransferAllocate.ts. Upstream sync (external service, like the
// cancel_invoice tables) writes internal_transfer_orders / _items; our
// writes into those rows (picking_order_id, allocation_status,
// allocated_qty) must be insert-only from the sync side, never clobbered.
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
               (o.picking_order_id IS NOT NULL) AS "linked",
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

/** One order + its item lines (each embedding its allocation rows) + the
 *  assigned delegated picking order summary. Returns null when the id is
 *  unknown. */
export async function getInternalTransferOrder(
  db: DbOrTx,
  id: string
): Promise<{ order: Record<string, unknown>; items: unknown[] } | null> {
  const order = await queryGet<Record<string, unknown>>(
    db,
    sql`SELECT o.id, o.order_no AS "orderNo",
               o.from_org_id AS "fromOrgId", o.from_sub_inventory_code AS "fromSubInventoryCode",
               o.to_org_id AS "toOrgId", o.to_sub_inventory_code AS "toSubInventoryCode",
               o.picking_order_id AS "pickingOrderId", o.priority_seq AS "prioritySeq",
               o.status, o.allocation_status AS "allocationStatus",
               o.customer_name AS "customerName", o.remark,
               o.issue_reason AS "issueReason", o.issue_qty AS "issueQty",
               o.issue_note AS "issueNote", o.issue_remark AS "issueRemark",
               o.issue_reported_at AS "issueReportedAt",
               o.additional_data AS "additionalData",
               po.order_no AS "pickingOrderNo", po.status AS "pickingOrderStatus",
               po.org_id AS "pickingOrderOrgId", po.sub_inventory_code AS "pickingOrderSubInventoryCode",
               po.customer_code AS "pickingOrderCustomerCode",
               o.created_date AS "createdDate", o.last_update_date AS "lastUpdateDate"
        FROM internal_transfer_orders o
        LEFT JOIN picking_orders po ON po.id = o.picking_order_id
        WHERE o.id = ${id}`
  );
  if (!order) return null;
  const items = await queryAll<Record<string, unknown>>(
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
  const allocations = await queryAll<Record<string, unknown>>(
    db,
    sql`SELECT ita.id, ita.transfer_item_id AS "transferItemId", ita.qty, ita.manual,
               CASE WHEN ita.inventory_lot_id IS NOT NULL THEN 'lot'
                    WHEN ita.receiving_invoice_item_id IS NOT NULL THEN 'receiving-item'
                    ELSE 'receiving-order' END AS "sourceType",
               ita.inventory_lot_id AS "inventoryLotId",
               il.shelf_code AS "shelfCode", s.display_name AS "shelfDisplayName",
               il.box_id AS "boxId", il.date_code AS "dateCode", il.lot_code AS "lotCode",
               ita.receiving_invoice_item_id AS "receivingInvoiceItemId",
               rii.ctn_no AS "ctnNo", ro.batch_no AS "receivingBatchNo", ri.invoice_no AS "receivingInvoiceNo"
        FROM internal_transfer_allocations ita
        JOIN internal_transfer_items iti ON iti.id = ita.transfer_item_id
        LEFT JOIN inventory_lots il ON il.id = ita.inventory_lot_id
        LEFT JOIN shelves s ON s.code = il.shelf_code
        LEFT JOIN receiving_invoice_items rii ON rii.id = ita.receiving_invoice_item_id
        LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        LEFT JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        WHERE iti.transfer_order_id = ${id}
        ORDER BY ita.created_date, ita.id`
  );
  const byItem = new Map<string, Record<string, unknown>[]>();
  for (const a of allocations) {
    const itemId = a.transferItemId as string;
    const list = byItem.get(itemId) ?? [];
    list.push(a);
    byItem.set(itemId, list);
  }
  for (const item of items) item.allocations = byItem.get(item.id as string) ?? [];
  return { order, items };
}

/**
 * Assign or clear the delegated picking order (spec
 * 2026-11-10-internal-transfer-admin-allocate §Delegated picking order):
 * a disposition marker consumed by the stage-2 finish branch — it never
 * touches allocations or stock. 404 transfer_order_not_found /
 * picking_order_not_found; 409 transfer_not_editable (status past
 * pending/allocated — a stage-2 PDA session has begun); 409
 * picking_order_not_open (status outside pending/allocated/picking/issue);
 * 409 org_mismatch (picking_orders.org_id ≠ to_org_id — a NULL picking org
 * is org-agnostic and matches anywhere). to_sub_inventory_code is
 * deliberately not enforced (99.7% NULL upstream; sub-inventory
 * compatibility resolves via the engine's pair/share matching in stage 2).
 */
export async function assignTransferPickingOrder(
  db: AppDb,
  transferOrderId: string,
  pickingOrderId: string | null,
  actorId: string
): Promise<{ pickingOrderId: string | null; pickingOrderNo: string | null }> {
  return db.transaction(async (tx) => {
    const order = await queryGet<{ id: string; status: string; toOrgId: number | null }>(
      tx,
      sql`SELECT ito.id, ito.status, ito.to_org_id AS "toOrgId"
          FROM internal_transfer_orders ito
          WHERE ito.id = ${transferOrderId}
          FOR UPDATE OF ito`
    );
    if (!order) throw new HTTPException(404, { message: "transfer_order_not_found" });
    if (order.status !== "pending" && order.status !== "allocated") {
      throw new HTTPException(409, { message: "transfer_not_editable" });
    }

    let pickingOrderNo: string | null = null;
    if (pickingOrderId) {
      const po = await queryGet<{ id: string; orderNo: string; status: string; orgId: number | null }>(
        tx,
        sql`SELECT po.id, po.order_no AS "orderNo", po.status, po.org_id AS "orgId"
            FROM picking_orders po WHERE po.id = ${pickingOrderId}`
      );
      if (!po) throw new HTTPException(404, { message: "picking_order_not_found" });
      if (po.status !== "pending" && po.status !== "allocated" && po.status !== "picking" && po.status !== "issue") {
        throw new HTTPException(409, { message: "picking_order_not_open" });
      }
      if (order.toOrgId !== null && po.orgId !== null && po.orgId !== order.toOrgId) {
        throw new HTTPException(409, { message: "org_mismatch" });
      }
      pickingOrderNo = po.orderNo;
    }

    await tx.execute(
      sql`UPDATE internal_transfer_orders SET picking_order_id = ${pickingOrderId}, last_update_date = ${now()}
          WHERE id = ${transferOrderId}`
    );

    await logTransition(tx, {
      entityType: "internal_transfer_order",
      entityId: transferOrderId,
      fromState: order.status,
      toState: order.status,
      actorId,
      metadata: {
        action: pickingOrderId ? "assign_picking_order" : "clear_picking_order",
        pickingOrderId,
        pickingOrderNo,
      },
    });

    await emitEvent(tx, {
      type: "internal-transfer.updated",
      topics: ["/internal-transfer-orders"],
      data: { transferOrderId, pickingOrderId, pickingOrderNo },
    });

    return { pickingOrderId, pickingOrderNo };
  });
}
