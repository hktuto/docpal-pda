import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryAll, queryGet } from "../db/query.js";
import {
  cancelReceivingItemMismatch,
  confirmReceivingArrival,
  confirmReceivingItemMismatch,
  editReceivingItemMismatch,
  getReceivingItemMismatch,
  reportReceivingItemMismatch,
  scanReceivingOrder,
} from "../db/receiving.js";
import { allocateAll } from "../db/allocate.js";
import { actorFrom } from "../auth/middleware.js";

// Empty bodies parse as {} — after the auth migration several mutations no
// longer carry any body fields (the actor comes from the token).
async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export interface ReceivingOrderListRow {
  id: string;
  batchNo: string;
  status: string;
  deliveryDate: string | null;
  dateCode: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  orgId: number;
  subInventoryCode: string;
  invoiceCount: number;
  itemCount: number;
  remainingItems: number;
  pendingPickingOrders: number;
}

export const receivingRoute = new Hono();

// List endpoint. `remainingItems` = invoice items not fully put away;
// `pendingPickingOrders` = distinct open picking orders with allocations
// pointing at this order (whole-order or via a boxed invoice item).
// `?status=` is a pass-through filter (statuses evolve, no enum here).
receivingRoute.get("/receiving-orders", async (c) => {
  const status = c.req.query("status");
  const rows = await queryAll<ReceivingOrderListRow>(
    db,
    sql`
      SELECT
        ro.id,
        ro.batch_no AS "batchNo",
        ro.status,
        ro.delivery_date AS "deliveryDate",
        ro.date_code AS "dateCode",
        s.code AS "supplierCode",
        s.name AS "supplierName",
        ro.org_id AS "orgId",
        ro.sub_inventory_code AS "subInventoryCode",
        COUNT(DISTINCT inv.id)::int AS "invoiceCount",
        COUNT(rii.id)::int AS "itemCount",
        COUNT(rii.id) FILTER (WHERE rii.put_away_qty < rii.line_qty)::int AS "remainingItems",
        (
          SELECT COUNT(DISTINCT po.id)::int
          FROM picking_orders po
          JOIN picking_items pi ON pi.picking_order_id = po.id
          JOIN allocations a ON a.picking_item_id = pi.id
          LEFT JOIN receiving_invoice_items rii2 ON rii2.id = a.receiving_invoice_item_id
          LEFT JOIN receiving_invoices inv2 ON inv2.id = rii2.receiving_invoice_id
          WHERE po.status IN ('pending', 'picking')
            AND (a.receiving_order_id = ro.id OR inv2.receiving_order_id = ro.id)
        ) AS "pendingPickingOrders"
      FROM receiving_orders ro
      LEFT JOIN suppliers s ON s.id = ro.supplier_id
      LEFT JOIN receiving_invoices inv ON inv.receiving_order_id = ro.id
      LEFT JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = inv.id
      ${status ? sql`WHERE ro.status = ${status}` : sql``}
      GROUP BY ro.id, s.id
      ORDER BY ro.created_at DESC
    `
  );
  return c.json(rows, 200);
});

// ------------------------------------------------------------------
// GET /receiving-orders/:id — nested detail
// ------------------------------------------------------------------

interface OrderDetailRow {
  id: string;
  batchNo: string;
  status: string;
  deliveryDate: string | null;
  dateCode: string | null;
  orgId: number;
  subInventoryCode: string;
  arrivedAt: string | null;
  arrivedBy: string | null;
  createdAt: string;
  updatedAt: string;
  supplierId: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  supplierShortName: string | null;
  profileId: string | null;
  profileName: string | null;
  profileQrTemplate: string | null;
  profileQtyEncoding: string | null;
  profileRemark: string | null;
}

interface InvoiceRow {
  id: string;
  invoiceNo: string;
  supplierId: string | null;
  wclCompanyName: string | null;
  totalQty: number | null;
  totalCtn: number | null;
  deliveryDate: string | null;
  orgId: number;
  subInventoryCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ItemRow {
  id: string;
  receivingInvoiceId: string;
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
  poLine: string | null;
  lineQty: number;
  receivedQty: number;
  pickedQty: number;
  putAwayQty: number;
  ctnNo: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  reportedMismatch: boolean;
  mismatchReason: string | null;
  mismatchQty: number | null;
  wrongPartNo: string | null;
  mismatchNote: string | null;
  allocatedQty: number;
  partPk: string;
  partWclItemNo: string | null;
  partDescription: string | null;
  partDefaultCoo: string | null;
}

// Complete nested read: order + supplier (with profile) + invoices + items,
// each item embedding its part, allocation total, and active mismatch.
receivingRoute.get("/receiving-orders/:id", async (c) => {
  const id = c.req.param("id");

  const order = await queryGet<OrderDetailRow>(
    db,
    sql`
      SELECT
        ro.id, ro.batch_no AS "batchNo", ro.status,
        ro.delivery_date AS "deliveryDate", ro.date_code AS "dateCode",
        ro.org_id AS "orgId",
        ro.sub_inventory_code AS "subInventoryCode",
        ro.arrived_at AS "arrivedAt", ro.arrived_by AS "arrivedBy",
        ro.created_at AS "createdAt", ro.updated_at AS "updatedAt",
        s.id AS "supplierId", s.code AS "supplierCode", s.name AS "supplierName",
        s.short_name AS "supplierShortName",
        sp.id AS "profileId", sp.name AS "profileName",
        sp.qr_template AS "profileQrTemplate", sp.qty_encoding AS "profileQtyEncoding",
        sp.remark AS "profileRemark"
      FROM receiving_orders ro
      LEFT JOIN suppliers s ON s.id = ro.supplier_id
      LEFT JOIN supplier_profiles sp ON sp.supplier_code = s.code
      WHERE ro.id = ${id}
    `
  );
  if (!order) throw new HTTPException(404, { message: "receiving_order_not_found" });

  const invoices = await queryAll<InvoiceRow>(
    db,
    sql`
      SELECT
        id, invoice_no AS "invoiceNo", supplier_id AS "supplierId",
        wcl_company_name AS "wclCompanyName", total_qty AS "totalQty", total_ctn AS "totalCtn",
        delivery_date AS "deliveryDate", org_id AS "orgId",
        sub_inventory_code AS "subInventoryCode",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM receiving_invoices
      WHERE receiving_order_id = ${id}
      ORDER BY created_at, id
    `
  );

  const items = await queryAll<ItemRow>(
    db,
    sql`
      SELECT
        rii.id, rii.receiving_invoice_id AS "receivingInvoiceId",
        rii.part_no AS "partNo", rii.wcl_item_no AS "wclItemNo",
        rii.po_no AS "poNo", rii.po_line AS "poLine",
        rii.line_qty AS "lineQty", rii.received_qty AS "receivedQty", rii.picked_qty AS "pickedQty",
        rii.put_away_qty AS "putAwayQty",
        rii.ctn_no AS "ctnNo", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
        rii.coo, rii.cow,
        rii.reported_mismatch AS "reportedMismatch", rii.mismatch_reason AS "mismatchReason",
        rii.mismatch_qty AS "mismatchQty", rii.wrong_part_no AS "wrongPartNo",
        rii.mismatch_note AS "mismatchNote",
        COALESCE((
          SELECT SUM(a.qty) FROM allocations a
          WHERE a.receiving_invoice_item_id = rii.id
        ), 0)::int AS "allocatedQty",
        p.id AS "partPk", p.wcl_item_no AS "partWclItemNo",
        p.description AS "partDescription",
        p.default_coo AS "partDefaultCoo"
      FROM receiving_invoice_items rii
      JOIN receiving_invoices inv ON inv.id = rii.receiving_invoice_id
      JOIN parts p ON p.part_no = rii.part_no
      WHERE inv.receiving_order_id = ${id}
      ORDER BY rii.po_no, rii.po_line, rii.id
    `
  );

  return c.json(
    {
      id: order.id,
      batchNo: order.batchNo,
      status: order.status,
      deliveryDate: order.deliveryDate,
      dateCode: order.dateCode,
      orgId: order.orgId,
      subInventoryCode: order.subInventoryCode,
      arrivedAt: order.arrivedAt,
      arrivedBy: order.arrivedBy,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      supplier: order.supplierId
        ? {
            id: order.supplierId,
            code: order.supplierCode,
            name: order.supplierName,
            shortName: order.supplierShortName,
            profile: order.profileId
              ? {
                  name: order.profileName,
                  qrTemplate: order.profileQrTemplate,
                  qtyEncoding: order.profileQtyEncoding,
                  remark: order.profileRemark,
                }
              : null,
          }
        : null,
      invoices: invoices.map((inv) => ({
        ...inv,
        items: items
          .filter((i) => i.receivingInvoiceId === inv.id)
          .map((i) => ({
            id: i.id,
            partNo: i.partNo,
            wclItemNo: i.wclItemNo,
            poNo: i.poNo,
            poLine: i.poLine,
            lineQty: i.lineQty,
            receivedQty: i.receivedQty,
            pickedQty: i.pickedQty,
            putAwayQty: i.putAwayQty,
            ctnNo: i.ctnNo,
            dateCode: i.dateCode,
            lotCode: i.lotCode,
            coo: i.coo,
            cow: i.cow,
            allocatedQty: i.allocatedQty,
            part: {
              id: i.partPk,
              partNo: i.partNo,
              wclItemNo: i.partWclItemNo,
              description: i.partDescription,
              defaultCoo: i.partDefaultCoo,
            },
            mismatch: i.reportedMismatch
              ? {
                  reason: i.mismatchReason,
                  mismatchQty: i.mismatchQty,
                  wrongPartNo: i.wrongPartNo,
                  note: i.mismatchNote,
                }
              : null,
          })),
      })),
    },
    200
  );
});

// ------------------------------------------------------------------
// POST /receiving-orders/:id/confirm-arrival — pending → in_hand
// ------------------------------------------------------------------

// Applies full receipt (received_qty = qty per line, date-code fallback from
// the order), writes RECEIVE_TO_DOCK ledger rows + a transition log, then
// recalculates allocations (concept 5) — best-effort, after commit.
// Accepts pending and provisional_received orders (a provisional order is
// completed to full receipt).
receivingRoute.post("/receiving-orders/:id/confirm-arrival", async (c) => {
  const result = await confirmReceivingArrival(db, c.req.param("id"), actorFrom(c).id);
  try {
    await allocateAll(db);
  } catch (err) {
    console.error("allocateAll after confirm-arrival failed", err);
  }
  return c.json(result, 200);
});

// ------------------------------------------------------------------
// GET /receiving-orders/:id/picking — nested picking section
// ------------------------------------------------------------------

interface PickingDemandRow {
  orderId: string;
  orderNo: string;
  status: string;
  shipTo: string | null;
  customerCode: string | null;
  itemId: string;
  partNo: string;
  itemQty: number;
  pickedQty: number;
  allocatedQty: number;
}

interface PickingAllocationRow {
  id: string;
  pickingItemId: string;
  qty: number;
  inventoryLotId: string | null;
  receivingInvoiceItemId: string | null;
  receivingOrderId: string | null;
  boxId: string | null;
  shelfCode: string | null;
  lotBoxId: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

interface PickingPackageRow {
  id: string;
  pickingItemId: string;
  qty: number;
  dateCode: string | null;
  lotCode: string | null;
  verified: boolean;
  shippingBoxId: string | null;
}

interface PickingBoxRow {
  id: string;
  pickingOrderId: string;
  status: string;
  boxSize: string | null;
  grossWeight: number | null;
  netWeight: number | null;
}

interface PickingLogRow {
  entityId: string;
  fromState: string | null;
  toState: string;
  actorId: string | null;
  createdAt: string;
}

// Picking orders with allocations tracing to this receiving order
// (allocations.receiving_order_id, or allocations.receiving_invoice_item_id →
// receiving_invoices → this order) — plus orders that no longer have such
// allocations but already have scanned PACKAGES tracing back here (a fully
// picked item loses its allocation rows when allocateAll recomputes, and the
// order must stay visible until boxing is done). Items embed ALL their
// allocations (full sourcing picture), their packages, and their
// picking_item transition logs; orders embed their shipping boxes.
receivingRoute.get("/receiving-orders/:id/picking", async (c) => {
  const id = c.req.param("id");
  const order = await queryGet<{ id: string }>(db, sql`SELECT id FROM receiving_orders WHERE id = ${id}`);
  if (!order) throw new HTTPException(404, { message: "receiving_order_not_found" });

  const rows = await queryAll<PickingDemandRow>(
    db,
    sql`
      SELECT
        po.id AS "orderId", po.order_no AS "orderNo", po.status,
        po.ship_to AS "shipTo", po.customer_code AS "customerCode",
        pi.id AS "itemId", pi.part_no AS "partNo",
        pi.qty AS "itemQty", pi.picked_qty AS "pickedQty", pi.allocated_qty AS "allocatedQty"
      FROM picking_items pi
      JOIN picking_orders po ON po.id = pi.picking_order_id
      WHERE EXISTS (
        SELECT 1 FROM allocations a
        LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
        LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE a.picking_item_id = pi.id
          AND (a.receiving_order_id = ${id} OR ri.receiving_order_id = ${id})
      ) OR EXISTS (
        SELECT 1 FROM picking_packages pp
        LEFT JOIN receiving_invoice_items prii
          ON pp.source_type = 'receiving_invoice_item' AND prii.id = pp.source_id
        LEFT JOIN receiving_invoices pri ON pri.id = prii.receiving_invoice_id
        LEFT JOIN inventory_lot_sources ils
          ON pp.source_type = 'inventory_lot' AND ils.inventory_lot_id = pp.source_id
        LEFT JOIN receiving_invoice_items lrii ON lrii.id = ils.receiving_invoice_item_id
        LEFT JOIN receiving_invoices lri ON lri.id = lrii.receiving_invoice_id
        WHERE pp.picking_item_id = pi.id
          AND ((pp.source_type = 'receiving_order' AND pp.source_id = ${id})
            OR pri.receiving_order_id = ${id}
            OR lri.receiving_order_id = ${id})
      )
      ORDER BY po.order_no, pi.id
    `
  );

  const itemIds = [...new Set(rows.map((r) => r.itemId))];
  const orderIds = [...new Set(rows.map((r) => r.orderId))];

  const allocations = itemIds.length
    ? await queryAll<PickingAllocationRow>(
        db,
        sql`
          SELECT
            a.id, a.picking_item_id AS "pickingItemId", a.qty,
            a.inventory_lot_id AS "inventoryLotId",
            a.receiving_invoice_item_id AS "receivingInvoiceItemId",
            a.receiving_order_id AS "receivingOrderId",
            rii.ctn_no AS "boxId",
            il.shelf_code AS "shelfCode", il.box_id AS "lotBoxId",
            il.date_code AS "dateCode", il.lot_code AS "lotCode", il.coo, il.cow
          FROM allocations a
          LEFT JOIN inventory_lots il ON il.id = a.inventory_lot_id
          LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
          WHERE ${inArray(sql`a.picking_item_id`, itemIds)}
          ORDER BY a.created_at, a.id
        `
      )
    : [];

  const packages = itemIds.length
    ? await queryAll<PickingPackageRow>(
        db,
        sql`
          SELECT
            id, picking_item_id AS "pickingItemId", qty,
            date_code AS "dateCode", lot_code AS "lotCode",
            verified, shipping_box_id AS "shippingBoxId"
          FROM picking_packages
          WHERE ${inArray(sql`picking_item_id`, itemIds)}
          ORDER BY created_at, id
        `
      )
    : [];

  const boxes = orderIds.length
    ? await queryAll<PickingBoxRow>(
        db,
        sql`
          SELECT
            id, picking_order_id AS "pickingOrderId", status,
            box_size AS "boxSize", gross_weight AS "grossWeight", net_weight AS "netWeight"
          FROM shipping_boxes
          WHERE ${inArray(sql`picking_order_id`, orderIds)}
          ORDER BY id
        `
      )
    : [];

  const logs = itemIds.length
    ? await queryAll<PickingLogRow>(
        db,
        sql`
          SELECT
            entity_id AS "entityId", from_state AS "fromState", to_state AS "toState",
            actor_id AS "actorId", created_at AS "createdAt"
          FROM transaction_logs
          WHERE entity_type = 'picking_item' AND ${inArray(sql`entity_id`, itemIds)}
          ORDER BY created_at
        `
      )
    : [];

  const byOrder = new Map<
    string,
    {
      id: string;
      orderNo: string;
      status: string;
      shipTo: string | null;
      customerCode: string | null;
      items: unknown[];
      boxes: unknown[];
    }
  >();
  for (const r of rows) {
    let o = byOrder.get(r.orderId);
    if (!o) {
      o = {
        id: r.orderId,
        orderNo: r.orderNo,
        status: r.status,
        shipTo: r.shipTo,
        customerCode: r.customerCode,
        items: [],
        boxes: boxes
          .filter((b) => b.pickingOrderId === r.orderId)
          .map((b) => ({
            id: b.id,
            status: b.status,
            boxSize: b.boxSize,
            grossWeight: b.grossWeight,
            netWeight: b.netWeight,
          })),
      };
      byOrder.set(r.orderId, o);
    }
    o.items.push({
      id: r.itemId,
      partNo: r.partNo,
      qty: r.itemQty,
      pickedQty: r.pickedQty,
      allocatedQty: r.allocatedQty,
      allocations: allocations
        .filter((a) => a.pickingItemId === r.itemId)
        .map((a) => ({
          id: a.id,
          qty: a.qty,
          lot: a.inventoryLotId
            ? {
                shelfCode: a.shelfCode,
                boxId: a.lotBoxId,
                dateCode: a.dateCode,
                lotCode: a.lotCode,
                coo: a.coo,
                cow: a.cow,
              }
            : null,
          receivingInvoiceItemId: a.receivingInvoiceItemId,
          receivingOrderId: a.receivingOrderId,
          boxId: a.boxId,
        })),
      packages: packages
        .filter((p) => p.pickingItemId === r.itemId)
        .map((p) => ({
          id: p.id,
          qty: p.qty,
          dateCode: p.dateCode,
          lotCode: p.lotCode,
          verified: p.verified,
          shippingBoxId: p.shippingBoxId,
        })),
      transitionLogs: logs
        .filter((l) => l.entityId === r.itemId)
        .map((l) => ({
          fromState: l.fromState,
          toState: l.toState,
          actorId: l.actorId,
          createdAt: l.createdAt,
        })),
    });
  }

  return c.json({ pickingOrders: [...byOrder.values()] }, 200);
});

// ------------------------------------------------------------------
// POST /receiving-orders/:id/scan — scan-based partial receipt
// ------------------------------------------------------------------

// Parses `raw` through the order's supplier QR template (explicit body fields
// override parsed ones), matches against the order's items, and auto-applies
// the partial receipt on a single match (order pending → provisional_received,
// RECEIVE_TO_DOCK ledger row). A parsed/explicit `serialNo` (S-key) is
// deduped per order via receiving_scan_labels — a repeat → 409
// label_already_scanned. Zero/multiple matches → 409 {message, candidates}.
// Then recalculates allocations — best-effort, after commit.
receivingRoute.post("/receiving-orders/:id/scan", async (c) => {
  const body = await readJson<{
    raw?: string;
    partNo?: string;
    qty?: number;
    dateCode?: string;
    lotCode?: string;
    coo?: string;
    cow?: string;
    ctnNo?: string;
    serialNo?: string;
  }>(c);
  const result = await scanReceivingOrder(db, c.req.param("id"), {
    actorId: actorFrom(c).id,
    raw: body.raw ?? null,
    partNo: body.partNo ?? null,
    qty: body.qty ?? null,
    dateCode: body.dateCode ?? null,
    lotCode: body.lotCode ?? null,
    coo: body.coo ?? null,
    cow: body.cow ?? null,
    ctnNo: body.ctnNo ?? null,
    serialNo: body.serialNo ?? null,
  });
  try {
    await allocateAll(db);
  } catch (err) {
    console.error("allocateAll after scan failed", err);
  }
  return c.json(result, 200);
});

// ------------------------------------------------------------------
// Mismatch lifecycle on receiving_invoice_items flat columns
// ------------------------------------------------------------------

receivingRoute.get("/receiving-invoice-items/:id/mismatch", async (c) => {
  return c.json(await getReceivingItemMismatch(db, c.req.param("id")), 200);
});

interface MismatchBody {
  reason?: string;
  mismatchQty?: number | null;
  wrongPartNo?: string | null;
  note?: string | null;
}

function parseMismatchBody(body: MismatchBody): MismatchBody {
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.trim() === "")) {
    throw new HTTPException(400, { message: "mismatch_reason_required" });
  }
  if (
    body.mismatchQty !== undefined &&
    body.mismatchQty !== null &&
    (!Number.isInteger(body.mismatchQty) || body.mismatchQty < 0)
  ) {
    throw new HTTPException(400, { message: "invalid_mismatch_qty" });
  }
  return body;
}

receivingRoute.post("/receiving-invoice-items/:id/mismatch", async (c) => {
  const body = parseMismatchBody(await readJson<MismatchBody>(c));
  if (body.reason === undefined) throw new HTTPException(400, { message: "mismatch_reason_required" });
  const row = await reportReceivingItemMismatch(db, c.req.param("id"), {
    ...body,
    actorId: actorFrom(c).id,
    reason: body.reason,
  });
  return c.json(row, 200);
});

receivingRoute.patch("/receiving-invoice-items/:id/mismatch", async (c) => {
  const body = parseMismatchBody(await readJson<MismatchBody>(c));
  const row = await editReceivingItemMismatch(db, c.req.param("id"), { ...body, actorId: actorFrom(c).id });
  return c.json(row, 200);
});

receivingRoute.post("/receiving-invoice-items/:id/mismatch/confirm", async (c) => {
  const row = await confirmReceivingItemMismatch(db, c.req.param("id"), actorFrom(c).id);
  return c.json(row, 200);
});

receivingRoute.post("/receiving-invoice-items/:id/mismatch/cancel", async (c) => {
  const row = await cancelReceivingItemMismatch(db, c.req.param("id"), actorFrom(c).id);
  return c.json(row, 200);
});
