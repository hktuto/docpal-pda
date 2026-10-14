import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { queryAll } from "../../db/query.js";
import { allowDockStock } from "../../config.js";
import { workLockExpiry } from "../../db/allocate.js";
import { locationMatches, type LocationMatchContext } from "../../db/locationMatch.js";

// Admin part-availability lookup: every stock location (inventory_lots) and
// every receiving line (any status) holding a part, matched exactly by
// part_no OR wcl_item_no. Read-only.
//
// Both endpoints accept an optional `orgId` + `subInventoryCode` context pair.
// They never filter the result — every row comes back with a `matched` flag
// computed with the same rule the allocation engine uses (same org, and the
// same sub-inventory or a sibling in the same `sub_inventory_share_members`
// group), so the dialogs can hide non-applicable rows while the exact-match
// highlight still tells the two cases apart.

interface StockRow {
  lotId: string;
  orgId: number | null;
  subInventoryCode: string | null;
  shelfCode: string | null;
  shelfDisplayName: string | null;
  boxId: string | null;
  partNo: string;
  wclItemNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
  /** Row satisfies the requested org / sub-inventory context (see header). */
  matched: boolean;
  /** False when shelf_code is missing from shelves (upstream sync wrote the
   *  lot past the FK) — the allocate endpoints reject new pins on it. */
  shelfKnown: boolean;
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
  matched: boolean;
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
  matched: boolean;
  /** Qty this row holds from `fromReceivingItemId` (0 when no context given). */
  fromItemQty: number;
  /** The order has a live PDA work lock — the re-allocate form rejects it. */
  locked: boolean;
  workingByName: string | null;
}

export const adminPartAvailabilityRoute = new Hono();

// The dialog's context partition. A missing/blank value means "no context".
function readMatchContext(c: { req: { query: (k: string) => string | undefined } }): LocationMatchContext {
  const rawOrg = c.req.query("orgId")?.trim() ?? "";
  const orgId = rawOrg === "" ? null : Number(rawOrg);
  const subInventoryCode = c.req.query("subInventoryCode")?.trim() || null;
  return { orgId: orgId !== null && Number.isInteger(orgId) ? orgId : null, subInventoryCode };
}

// Reverse lookup for the receiving-detail Allocate modal: open picking items
// (pending/picking orders) needing a part, with the remaining uncovered qty.
adminPartAvailabilityRoute.get("/part-demand", async (c) => {
  const partNo = c.req.query("partNo")?.trim() ?? "";
  if (partNo === "") throw new HTTPException(400, { message: "part_no_required" });
  const wclItemNo = c.req.query("wclItemNo")?.trim() ?? "";
  const ctx = readMatchContext(c);
  // The re-allocate form is a final-state form, so it needs to know what each
  // row already holds from the receiving item being redistributed.
  const fromReceivingItemId = c.req.query("fromReceivingItemId")?.trim() || null;

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
        GREATEST(0, pi.qty - COALESCE(pkg.qty, 0) - COALESCE(alloc.qty, 0))::int AS "remainingQty",
        ${locationMatches(ctx, sql`po.org_id`, sql`po.sub_inventory_code`)} AS "matched",
        COALESCE(selfalloc.qty, 0)::int AS "fromItemQty",
        (po.working_by IS NOT NULL AND po.working_at >= ${workLockExpiry()}) AS "locked",
        u.display_name AS "workingByName"
      FROM picking_items pi
      JOIN picking_orders po ON po.id = pi.picking_order_id
      LEFT JOIN users u ON u.id = po.working_by
      LEFT JOIN (
        SELECT picking_item_id, SUM(qty) AS qty FROM picking_packages GROUP BY picking_item_id
      ) pkg ON pkg.picking_item_id = pi.id
      LEFT JOIN (
        SELECT picking_item_id, SUM(qty) AS qty FROM allocations GROUP BY picking_item_id
      ) alloc ON alloc.picking_item_id = pi.id
      LEFT JOIN (
        SELECT picking_item_id, SUM(qty) AS qty FROM allocations
        WHERE receiving_invoice_item_id = ${fromReceivingItemId}
        GROUP BY picking_item_id
      ) selfalloc ON selfalloc.picking_item_id = pi.id
      WHERE po.status IN ('pending', 'picking', 'allocated')
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
  const ctx = readMatchContext(c);

  const stock = await queryAll<StockRow>(
    db,
    sql`
      SELECT
        il.id AS "lotId",
        il.org_id AS "orgId",
        il.sub_inventory_code AS "subInventoryCode",
        il.shelf_code AS "shelfCode",
        s.display_name AS "shelfDisplayName",
        il.box_id AS "boxId",
        il.part_no AS "partNo",
        il.wcl_item_no AS "wclItemNo",
        il.date_code AS "dateCode",
        il.lot_code AS "lotCode",
        il.coo,
        il.cow,
        il.total_qty AS "totalQty",
        il.allocated_qty AS "allocatedQty",
        il.available_qty AS "availableQty",
        (il.shelf_code IS NULL OR s.code IS NOT NULL) AS "shelfKnown",
        ${locationMatches(ctx, sql`il.org_id`, sql`il.sub_inventory_code`)} AS "matched"
      FROM inventory_lots il
      LEFT JOIN shelves s ON s.code = il.shelf_code
      WHERE il.part_no = ${partNo} OR (${wclItemNo} <> '' AND il.wcl_item_no = ${wclItemNo})
      ORDER BY il.org_id, il.sub_inventory_code, il.shelf_code
    `
  );

  // Dock stock is only allocatable when the flow config allows it — the dialogs
  // hide the receiving-sources table entirely when it is off.
  const dockStock = allowDockStock();
  const receiving: ReceivingRow[] = dockStock
    ? await queryAll<ReceivingRow>(
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
            rii.date_code AS "dateCode",
            ${locationMatches(ctx, sql`rii.org_id`, sql`rii.sub_inventory_code`)} AS "matched"
          FROM receiving_invoice_items rii
          JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
          WHERE rii.part_no = ${partNo} OR (${wclItemNo} <> '' AND rii.wcl_item_no = ${wclItemNo})
          ORDER BY ro.created_date DESC
        `
      )
    : [];

  return c.json({ stock, receiving, dockStockAllowed: dockStock });
});

interface AllocationBreakdownRow {
  allocationId: string;
  pickingOrderId: string;
  orderNo: string;
  orderStatus: string;
  pickingItemId: string;
  partNo: string;
  wclItemNo: string | null;
  qty: number;
  manual: boolean;
  sourceType: "lot" | "receiving-item" | "receiving-order";
  inventoryLotId: string | null;
  receivingInvoiceItemId: string | null;
  receivingOrderId: string | null;
  orgId: number | null;
  subInventoryCode: string | null;
  shelfCode: string | null;
  shelfDisplayName: string | null;
  boxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  locked: boolean;
  workingByName: string | null;
}

// Per-order breakdown of every allocation row holding a part (spec
// docs/superpowers/specs/2026-10-14-admin-cross-order-allocation-control-design.md):
// the availability dialogs' "allocated" counter lists WHICH orders hold the
// stock, so an admin can transfer or remove a specific row in place. Same part
// matching as part-availability; all picking orders and statuses are included;
// `locked`/`workingByName` reuse the part-demand work-lock rule.
adminPartAvailabilityRoute.get("/part-allocations", async (c) => {
  const partNo = c.req.query("partNo")?.trim() ?? "";
  if (partNo === "") throw new HTTPException(400, { message: "part_no_required" });
  const wclItemNo = c.req.query("wclItemNo")?.trim() ?? "";

  const allocations = await queryAll<AllocationBreakdownRow>(
    db,
    sql`
      SELECT
        a.id AS "allocationId",
        po.id AS "pickingOrderId",
        po.order_no AS "orderNo",
        po.status AS "orderStatus",
        pi.id AS "pickingItemId",
        COALESCE(il.part_no, rii.part_no, pi.part_no) AS "partNo",
        COALESCE(il.wcl_item_no, rii.wcl_item_no) AS "wclItemNo",
        a.qty,
        a.manual,
        CASE
          WHEN a.inventory_lot_id IS NOT NULL THEN 'lot'
          WHEN a.receiving_invoice_item_id IS NOT NULL THEN 'receiving-item'
          ELSE 'receiving-order'
        END AS "sourceType",
        a.inventory_lot_id AS "inventoryLotId",
        a.receiving_invoice_item_id AS "receivingInvoiceItemId",
        a.receiving_order_id AS "receivingOrderId",
        COALESCE(il.org_id, rii.org_id,
          (SELECT rii2.org_id FROM receiving_invoice_items rii2
           JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
           WHERE ri2.receiving_order_id = a.receiving_order_id
           ORDER BY rii2.created_date LIMIT 1)) AS "orgId",
        COALESCE(il.sub_inventory_code, rii.sub_inventory_code,
          (SELECT rii2.sub_inventory_code FROM receiving_invoice_items rii2
           JOIN receiving_invoices ri2 ON ri2.id = rii2.receiving_invoice_id
           WHERE ri2.receiving_order_id = a.receiving_order_id
           ORDER BY rii2.created_date LIMIT 1)) AS "subInventoryCode",
        il.shelf_code AS "shelfCode",
        s.display_name AS "shelfDisplayName",
        COALESCE(il.box_id, rii.ctn_no) AS "boxId",
        COALESCE(il.date_code, rii.date_code) AS "dateCode",
        COALESCE(il.lot_code, rii.lot_code) AS "lotCode",
        (po.working_by IS NOT NULL AND po.working_at >= ${workLockExpiry()}) AS "locked",
        u.display_name AS "workingByName"
      FROM allocations a
      JOIN picking_items pi ON pi.id = a.picking_item_id
      JOIN picking_orders po ON po.id = pi.picking_order_id
      LEFT JOIN users u ON u.id = po.working_by
      LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
      LEFT JOIN shelves s ON s.code = il.shelf_code
      LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
      WHERE COALESCE(il.part_no, rii.part_no, pi.part_no) = ${partNo}
         OR (${wclItemNo} <> '' AND COALESCE(il.wcl_item_no, rii.wcl_item_no) = ${wclItemNo})
      ORDER BY po.priority_seq, po.order_no, a.created_date
    `
  );

  return c.json({ allocations });
});
