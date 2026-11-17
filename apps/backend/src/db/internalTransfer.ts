import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AppDb } from "../db.js";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import { logTransition } from "./picking.js";
import { emitEvent } from "./events.js";
import { now } from "./now.js";
import { dateCodeFormat, outdatedStockYears } from "../config.js";
import { dateCodeRank, isOutdatedRank, outdatedThresholdRank, toCanonicalDateCode } from "./dateCode.js";

// ---------------------------------------------------------------------------
// Internal transfer orders — admin console view. The allocation engine
// lives in internalTransferAllocate.ts; picking promises live in
// allocations.internal_transfer_item_id (spec
// 2026-11-17-internal-transfer-allocation-supply-design.md). Upstream sync
// (external service, like the cancel_invoice tables) writes
// internal_transfer_orders / _items; our writes into those rows
// (allocation_status, allocated_qty) must be insert-only from the sync
// side, never clobbered. The old order-level picking_order_id link is
// deprecated — the migration NULLs it and app code never writes it.
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
               (SELECT COUNT(*)::int FROM internal_transfer_items i
                WHERE i.transfer_order_id = o.id
                  AND EXISTS (SELECT 1 FROM allocations a WHERE a.internal_transfer_item_id = i.id)) AS "promisedItems",
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
               o.priority_seq AS "prioritySeq",
               o.status, o.allocation_status AS "allocationStatus",
               (SELECT COUNT(*)::int FROM internal_transfer_items i
                WHERE i.transfer_order_id = o.id
                  AND EXISTS (SELECT 1 FROM allocations a WHERE a.internal_transfer_item_id = i.id)) AS "promisedItems",
               o.customer_name AS "customerName", o.remark,
               o.issue_reason AS "issueReason", o.issue_qty AS "issueQty",
               o.issue_note AS "issueNote", o.issue_remark AS "issueRemark",
               o.issue_reported_at AS "issueReportedAt",
               o.additional_data AS "additionalData",
               o.created_date AS "createdDate", o.last_update_date AS "lastUpdateDate"
        FROM internal_transfer_orders o
        WHERE o.id = ${id}`
  );
  if (!order) return null;
  const items = await queryAll<Record<string, unknown>>(
    db,
    sql`SELECT id, part_no AS "partNo", wcl_item_no AS "wclItemNo",
               internal_transfer_items.qty, internal_transfer_items.picked_qty AS "pickedQty", internal_transfer_items.allocated_qty AS "allocatedQty",
               internal_transfer_items.status, po_no AS "poNo", line_id AS "lineId", line_number AS "lineNumber",
               additional_data AS "additionalData",
               COALESCE(prm.qty, 0) AS "promisedQty",
               prm.order_nos AS "promisedOrders",
               created_date AS "createdDate", last_update_date AS "lastUpdateDate"
        FROM internal_transfer_items
        LEFT JOIN (
          SELECT a.internal_transfer_item_id AS iti_id, SUM(a.qty)::int AS qty,
                 string_agg(DISTINCT po.order_no, ', ') AS order_nos
          FROM allocations a
          JOIN picking_items pi ON pi.id = a.picking_item_id
          JOIN picking_orders po ON po.id = pi.picking_order_id
          WHERE a.internal_transfer_item_id IS NOT NULL
          GROUP BY a.internal_transfer_item_id
        ) prm ON prm.iti_id = internal_transfer_items.id
        WHERE transfer_order_id = ${id}
        ORDER BY line_number NULLS LAST, part_no`
  );
  // Allocation rows shaped like the picking detail's (lot / receiving embeds
  // + outdated flag) so the admin items table reuses the same
  // Allocations*Row / AllocationDetail components verbatim.
  interface AllocQueryRow {
    id: string;
    transferItemId: string;
    qty: number;
    manual: boolean;
    sourceType: "lot" | "receiving-item" | "receiving-order";
    inventoryLotId: string | null;
    receivingInvoiceItemId: string | null;
    receivingOrderId: string | null;
    boxId: string | null;
    lotId: string | null;
    lotShelfCode: string | null;
    lotShelfDisplayName: string | null;
    lotShelfWarning: string | null;
    lotBoxId: string | null;
    lotDateCode: string | null;
    lotLotCode: string | null;
    lotCoo: string | null;
    lotCow: string | null;
    lotTotalQty: number;
    lotAllocatedQty: number;
    lotAvailableQty: number;
    recvOrderId: string | null;
    recvBatchNo: string | null;
    recvInvoiceNo: string | null;
    recvPartNo: string | null;
    recvPoNo: string | null;
    recvReceivedQty: number | null;
    recvDateCode: string | null;
    orderLevelBatchNo: string | null;
  }
  const allocations = await queryAll<AllocQueryRow>(
    db,
    sql`SELECT ita.id, ita.transfer_item_id AS "transferItemId", ita.qty, ita.manual,
               CASE WHEN ita.inventory_lot_id IS NOT NULL THEN 'lot'
                    WHEN ita.receiving_invoice_item_id IS NOT NULL THEN 'receiving-item'
                    ELSE 'receiving-order' END AS "sourceType",
               ita.inventory_lot_id AS "inventoryLotId",
               ita.receiving_invoice_item_id AS "receivingInvoiceItemId",
               ita.receiving_order_id AS "receivingOrderId",
               rii.ctn_no AS "boxId",
               il.id AS "lotId", il.shelf_code AS "lotShelfCode",
               s.display_name AS "lotShelfDisplayName", s.warning AS "lotShelfWarning",
               il.box_id AS "lotBoxId", il.date_code AS "lotDateCode", il.lot_code AS "lotLotCode",
               il.coo AS "lotCoo", il.cow AS "lotCow",
               il.total_qty AS "lotTotalQty", il.allocated_qty AS "lotAllocatedQty",
               il.available_qty AS "lotAvailableQty",
               ro.id AS "recvOrderId", ro.batch_no AS "recvBatchNo", ri.invoice_no AS "recvInvoiceNo",
               rii.part_no AS "recvPartNo", rii.po_no AS "recvPoNo",
               rii.received_qty AS "recvReceivedQty", rii.date_code AS "recvDateCode",
               ro2.batch_no AS "orderLevelBatchNo"
        FROM internal_transfer_allocations ita
        JOIN internal_transfer_items iti ON iti.id = ita.transfer_item_id
        LEFT JOIN inventory_lots il ON il.id = ita.inventory_lot_id
        LEFT JOIN shelves s ON s.code = il.shelf_code
        LEFT JOIN receiving_invoice_items rii ON rii.id = ita.receiving_invoice_item_id
        LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        LEFT JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        LEFT JOIN receiving_orders ro2 ON ro2.id = ita.receiving_order_id
        WHERE iti.transfer_order_id = ${id}
        ORDER BY ita.created_date, ita.id`
  );
  const outdatedRank = outdatedThresholdRank(outdatedStockYears());
  const dcFmt = dateCodeFormat();
  const byItem = new Map<string, Record<string, unknown>[]>();
  for (const a of allocations) {
    const shaped = {
      id: a.id,
      transferItemId: a.transferItemId,
      qty: a.qty,
      manual: a.manual,
      sourceType: a.sourceType,
      inventoryLotId: a.inventoryLotId,
      receivingInvoiceItemId: a.receivingInvoiceItemId,
      receivingOrderId: a.receivingOrderId,
      boxId: a.boxId,
      lot: a.lotId
        ? {
            id: a.lotId,
            shelfCode: a.lotShelfCode,
            shelfDisplayName: a.lotShelfDisplayName,
            shelfWarning: a.lotShelfWarning,
            boxId: a.lotBoxId,
            dateCode: a.lotDateCode,
            lotCode: a.lotLotCode,
            coo: a.lotCoo,
            cow: a.lotCow,
            totalQty: a.lotTotalQty,
            allocatedQty: a.lotAllocatedQty,
            availableQty: a.lotAvailableQty,
          }
        : null,
      receiving: a.receivingInvoiceItemId && a.recvOrderId
        ? {
            orderId: a.recvOrderId,
            batchNo: a.recvBatchNo,
            invoiceNo: a.recvInvoiceNo,
            partNo: a.recvPartNo,
            poNo: a.recvPoNo,
            receivedQty: a.recvReceivedQty,
            dateCode: a.recvDateCode,
          }
        : null,
      // Order-level dock rows carry no invoice line — surface the batch no
      // for the source label (the tooltip stays empty, same as picking).
      orderLevelBatchNo: a.orderLevelBatchNo,
      outdated: isOutdatedRank(dateCodeRank(a.lotDateCode ?? toCanonicalDateCode(a.recvDateCode, dcFmt)), outdatedRank),
    };
    const list = byItem.get(a.transferItemId) ?? [];
    list.push(shaped);
    byItem.set(a.transferItemId, list);
  }
  for (const item of items) item.allocations = byItem.get(item.id as string) ?? [];
  return { order, items };
}
