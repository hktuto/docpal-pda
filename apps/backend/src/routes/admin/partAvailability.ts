import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { queryAll } from "../../db/query.js";

// Admin part-availability lookup: every stock location (inventory_lots) and
// every receiving line (any status) holding a part, matched exactly by
// part_no OR wcl_item_no. No org filter — the admin console sees all
// locations. Read-only.

interface StockRow {
  lotId: string;
  orgId: number | null;
  subInventoryCode: string | null;
  shelfCode: string | null;
  boxId: string | null;
  partNo: string;
  wclItemNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
}

interface ReceivingRow {
  receivingOrderId: string;
  batchNo: string;
  supplierCode: string | null;
  status: string;
  invoiceNo: string;
  receivingInvoiceItemId: string;
  lineQty: number | null;
  receivedQty: number;
  putAwayQty: number;
  pickedQty: number;
  orgId: number;
  subInventoryCode: string | null;
  ctnNo: string | null;
  dateCode: string | null;
}

interface DemandRow {
  pickingOrderId: string;
  orderNo: string;
  orderStatus: string;
  deliveryDate: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  pickingItemId: string;
  partNo: string;
  qty: number;
  pickedQty: number;
  allocatedQty: number;
  remainingQty: number;
}

export const adminPartAvailabilityRoute = new Hono();

// Reverse lookup for the receiving-detail Allocate modal: open picking items
// (pending/picking orders) needing a part, with the remaining uncovered qty.
adminPartAvailabilityRoute.get("/part-demand", async (c) => {
  const partNo = c.req.query("partNo")?.trim() ?? "";
  if (partNo === "") throw new HTTPException(400, { message: "part_no_required" });
  const wclItemNo = c.req.query("wclItemNo")?.trim() ?? "";

  const demand = await queryAll<DemandRow>(
    db,
    sql`
      SELECT
        po.id AS "pickingOrderId",
        po.order_no AS "orderNo",
        po.status AS "orderStatus",
        po.delivery_date AS "deliveryDate",
        po.org_id AS "orgId",
        po.sub_inventory_code AS "subInventoryCode",
        pi.id AS "pickingItemId",
        pi.part_no AS "partNo",
        pi.qty,
        COALESCE(pkg.qty, 0)::int AS "pickedQty",
        COALESCE(alloc.qty, 0)::int AS "allocatedQty",
        GREATEST(0, pi.qty - COALESCE(pkg.qty, 0) - COALESCE(alloc.qty, 0))::int AS "remainingQty"
      FROM picking_items pi
      JOIN picking_orders po ON po.id = pi.picking_order_id
      LEFT JOIN (
        SELECT picking_item_id, SUM(qty) AS qty FROM picking_packages GROUP BY picking_item_id
      ) pkg ON pkg.picking_item_id = pi.id
      LEFT JOIN (
        SELECT picking_item_id, SUM(qty) AS qty FROM allocations GROUP BY picking_item_id
      ) alloc ON alloc.picking_item_id = pi.id
      WHERE po.status IN ('pending', 'picking')
        AND (pi.part_no = ${partNo}
             OR (${wclItemNo} <> '' AND (
                  pi.part_no = ${wclItemNo}
                  OR ${wclItemNo} = (SELECT p.wcl_item_no FROM parts p WHERE p.part_no = pi.part_no LIMIT 1))))
        AND pi.qty - COALESCE(pkg.qty, 0) - COALESCE(alloc.qty, 0) > 0
      ORDER BY po.priority_seq, po.delivery_date NULLS LAST, po.order_no, pi.id
    `
  );

  return c.json({ demand });
});

adminPartAvailabilityRoute.get("/part-availability", async (c) => {
  const partNo = c.req.query("partNo")?.trim() ?? "";
  if (partNo === "") throw new HTTPException(400, { message: "part_no_required" });
  const wclItemNo = c.req.query("wclItemNo")?.trim() ?? "";

  const stock = await queryAll<StockRow>(
    db,
    sql`
      SELECT
        il.id AS "lotId",
        il.org_id AS "orgId",
        il.sub_inventory_code AS "subInventoryCode",
        il.shelf_code AS "shelfCode",
        il.box_id AS "boxId",
        il.part_no AS "partNo",
        il.wcl_item_no AS "wclItemNo",
        il.date_code AS "dateCode",
        il.lot_code AS "lotCode",
        il.total_qty AS "totalQty",
        il.allocated_qty AS "allocatedQty",
        il.available_qty AS "availableQty"
      FROM inventory_lots il
      WHERE il.part_no = ${partNo} OR (${wclItemNo} <> '' AND il.wcl_item_no = ${wclItemNo})
      ORDER BY il.org_id, il.sub_inventory_code, il.shelf_code
    `
  );

  const receiving = await queryAll<ReceivingRow>(
    db,
    sql`
      SELECT
        ro.id AS "receivingOrderId",
        ro.batch_no AS "batchNo",
        ro.supplier_code AS "supplierCode",
        ro.status,
        ri.invoice_no AS "invoiceNo",
        rii.id AS "receivingInvoiceItemId",
        rii.line_qty AS "lineQty",
        rii.received_qty AS "receivedQty",
        rii.put_away_qty AS "putAwayQty",
        rii.picked_qty AS "pickedQty",
        rii.org_id AS "orgId",
        rii.sub_inventory_code AS "subInventoryCode",
        rii.ctn_no AS "ctnNo",
        rii.date_code AS "dateCode"
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
      WHERE rii.part_no = ${partNo} OR (${wclItemNo} <> '' AND rii.wcl_item_no = ${wclItemNo})
      ORDER BY ro.created_date DESC
    `
  );

  return c.json({ stock, receiving });
});
