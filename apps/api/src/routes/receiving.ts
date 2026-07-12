import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { ConfirmArrivalResponse, IngestUpsertResponse, ReceivingPutBody } from "@warehouse/shared";
import { db } from "../db.js";
import { allocateAll } from "../db/allocate.js";
import { confirmReceivingArrival, upsertReceivingOrder } from "../ingest/receiving.js";
import { collapseUpper } from "../db/schema/normalize.js";

export const receivingRoute = new Hono();

receivingRoute.get("/receiving-orders", (c) => {
  const status = c.req.query("status") ?? null;
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT ro.id, ro.ref_no, ro.status, ro.delivery_date, s.name AS supplier_name,
      (SELECT COUNT(*) FROM receiving_invoice_items rii
         JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
         LEFT JOIN (SELECT receiving_invoice_item_id, SUM(qty) AS uq FROM put_away_scans
                    WHERE shelf_box_id IS NULL GROUP BY receiving_invoice_item_id) u
           ON u.receiving_invoice_item_id = rii.id
         WHERE ri.receiving_order_id = ro.id AND rii.available_qty - COALESCE(u.uq, 0) > 0) AS remaining_items,
      (SELECT COUNT(DISTINCT po.id) FROM picking_orders po
         JOIN picking_items pi ON pi.picking_order_id = po.id
         JOIN allocations a ON a.picking_item_id = pi.id AND a.qty > 0
         LEFT JOIN allocation_receiving_items ari ON ari.allocation_id = a.id
         LEFT JOIN receiving_invoice_items link_rii ON link_rii.id = ari.receiving_invoice_item_id
         LEFT JOIN receiving_invoices link_ri ON link_ri.id = link_rii.receiving_invoice_id
         LEFT JOIN inventory_lot_sources ils ON ils.inventory_lot_id = a.inventory_lot_id
         LEFT JOIN receiving_invoice_items src_rii ON src_rii.id = ils.receiving_invoice_item_id
         LEFT JOIN receiving_invoices src_ri ON src_ri.id = src_rii.receiving_invoice_id
         WHERE po.status IN ('pending','picking')
           AND (a.receiving_order_id = ro.id
                OR link_ri.receiving_order_id = ro.id
                OR src_ri.receiving_order_id = ro.id)) AS pending_picking_orders
    FROM receiving_orders ro
    LEFT JOIN suppliers s ON s.id = ro.supplier_id
    WHERE (${status} IS NULL OR ro.status = ${status})
    ORDER BY ro.delivery_date`);
  return c.json(rows, 200);
});

receivingRoute.get("/receiving-orders/:id", (c) => {
  const orderId = c.req.param("id");
  const order = db.get<Record<string, unknown>>(sql`
    SELECT ro.id, ro.ref_no, ro.status, ro.delivery_date,
           s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name,
           s.qr_template AS supplier_qr_template, s.qrcode_qty_encoding AS supplier_qrcode_qty_encoding
    FROM receiving_orders ro
    LEFT JOIN suppliers s ON s.id = ro.supplier_id
    WHERE ro.id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "receiving order not found" });

  const remaining = db.get<{ remaining_items: number }>(sql`
    SELECT COUNT(*) AS remaining_items
    FROM receiving_invoice_items rii
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    LEFT JOIN (SELECT receiving_invoice_item_id, SUM(qty) AS uq FROM put_away_scans
               WHERE shelf_box_id IS NULL GROUP BY receiving_invoice_item_id) u
      ON u.receiving_invoice_item_id = rii.id
    WHERE ri.receiving_order_id = ${orderId} AND rii.available_qty - COALESCE(u.uq, 0) > 0`);

  const allocRows = db.all<{ item_id: string; qty: number }>(sql`
    SELECT ari.receiving_invoice_item_id AS item_id, SUM(ari.qty) AS qty
    FROM allocation_receiving_items ari
    JOIN receiving_invoice_items rii ON rii.id = ari.receiving_invoice_item_id
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE ri.receiving_order_id = ${orderId}
    GROUP BY ari.receiving_invoice_item_id`);
  const allocatedByItem: Record<string, number> = {};
  for (const r of allocRows) allocatedByItem[r.item_id] = r.qty;

  const invoices = db.all<Record<string, unknown>>(sql`
    SELECT id, receiving_order_id, invoice_no, supplier_id
    FROM receiving_invoices WHERE receiving_order_id = ${orderId}
    ORDER BY invoice_no`);

  const itemRows = db.all<Record<string, unknown>>(sql`
    SELECT rii.id, rii.receiving_invoice_id, rii.part_id, rii.qty, rii.received_qty,
           rii.picked_qty, rii.put_away_qty, rii.box_id, rii.date_code, rii.lot_code, rii.coo, rii.cow,
           p.id AS part_ref_id, p.part_no, p.description AS part_description
    FROM receiving_invoice_items rii
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    LEFT JOIN parts p ON p.id = rii.part_id
    WHERE ri.receiving_order_id = ${orderId}
    ORDER BY ri.invoice_no, rii.id`);

  // Latest non-cancelled mismatch per item (created_at DESC picks the most recent report).
  const mismatchRows = db.all<Record<string, unknown>>(sql`
    SELECT rim.id, rim.receiving_invoice_item_id, rim.kind, rim.mismatch_qty, rim.wrong_part_no, rim.note,
           rim.status, rim.effective_received_qty, rim.previous_received_qty,
           rim.reported_by, rim.confirmed_by, rim.confirmed_at, rim.cancelled_by, rim.cancelled_at,
           rim.created_at, rim.updated_at
    FROM receiving_item_mismatches rim
    JOIN receiving_invoice_items rii ON rii.id = rim.receiving_invoice_item_id
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE ri.receiving_order_id = ${orderId} AND rim.status != 'cancelled'
    ORDER BY rim.created_at DESC, rim.id DESC`);
  const mismatchByItem = new Map<string, Record<string, unknown>>();
  for (const m of mismatchRows) {
    const key = String(m.receiving_invoice_item_id);
    if (!mismatchByItem.has(key)) mismatchByItem.set(key, m);
  }

  const itemsByInvoice = new Map<string, Record<string, unknown>[]>();
  for (const row of itemRows) {
    const { part_ref_id, part_no, part_description, ...item } = row;
    const dto = {
      ...item,
      part: part_ref_id ? { id: part_ref_id, part_no, description: part_description } : null,
      mismatch: mismatchByItem.get(String(row.id)) ?? null,
    };
    const key = String(row.receiving_invoice_id);
    const list = itemsByInvoice.get(key) ?? [];
    list.push(dto);
    itemsByInvoice.set(key, list);
  }

  return c.json({
    id: order.id,
    ref_no: order.ref_no,
    status: order.status,
    delivery_date: order.delivery_date,
    remaining_items: remaining?.remaining_items ?? 0,
    allocated_by_item: allocatedByItem,
    supplier: order.supplier_id
      ? { id: order.supplier_id, code: order.supplier_code, name: order.supplier_name,
          qr_template: order.supplier_qr_template, qrcode_qty_encoding: order.supplier_qrcode_qty_encoding }
      : null,
    invoices: invoices.map((inv) => ({ ...inv, items: itemsByInvoice.get(String(inv.id)) ?? [] })),
  }, 200);
});

// The web keys its candidate map with normalize() from
// apps/web/composables/useMockOcr.ts — trim/uppercase/collapse-whitespace,
// WITHOUT the confusable mapping the stored part_no_norm applies. The client
// looks up by that same key, so the map key must match it exactly.
// collapseUpper (db/schema/normalize.ts) is the same transform.

// Scan-candidates snapshot powering the web's useScanMatchers without direct
// DB access. Mirrors findReceivingCandidatesForOrder / findPickingCandidatesForOrder
// in apps/web/db/ocrPicking.ts: the web groups Maps keyed by normalized part
// no / part_id; here they are plain objects. date_code/lot_code/coo/cow carry
// the stored *_norm columns (the web normalizes in SQL to the same values).
// available_qty is the API's stored column minus unboxed put-away scans (same
// subquery shape as the list endpoint above); the web computes the same value
// from received - picked - put_away - allocated - unboxed.
receivingRoute.get("/receiving-orders/:id/scan-candidates", (c) => {
  const orderId = c.req.param("id");
  const order = db.get<{ id: string; status: string }>(sql`
    SELECT id, status FROM receiving_orders WHERE id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "receiving order not found" });
  if (order.status !== "in_hand") {
    return c.json({ receiving_by_part_no: {}, picking_by_part_id: {} }, 200);
  }

  const receivingRows = db.all<Record<string, unknown>>(sql`
    SELECT rii.id AS receiving_invoice_item_id, p.id AS part_id, p.part_no,
           rii.date_code_norm AS date_code, rii.lot_code_norm AS lot_code,
           rii.coo_norm AS coo, rii.cow_norm AS cow,
           rii.available_qty - COALESCE(u.uq, 0) AS available_qty
    FROM receiving_invoices ri
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    JOIN parts p ON p.id = rii.part_id
    LEFT JOIN (SELECT receiving_invoice_item_id, SUM(qty) AS uq FROM put_away_scans
               WHERE shelf_box_id IS NULL GROUP BY receiving_invoice_item_id) u
      ON u.receiving_invoice_item_id = rii.id
    WHERE ri.receiving_order_id = ${orderId}
      AND rii.available_qty - COALESCE(u.uq, 0) > 0
    ORDER BY p.part_no_norm, rii.date_code_norm, rii.lot_code_norm`);
  const receivingByPartNo: Record<string, Record<string, unknown>[]> = {};
  for (const row of receivingRows) {
    (receivingByPartNo[collapseUpper(String(row.part_no))] ??= []).push(row);
  }

  // remaining_qty mirrors the web: qty - picked_qty - SUM(unboxed packages).
  // The EXISTS is order-level (any item of the picking order allocated to this
  // receiving order), exactly as in findPickingCandidatesForOrder.
  const pickingRows = db.all<Record<string, unknown>>(sql`
    SELECT DISTINCT po.id AS picking_order_id, po.ref_no AS picking_order_ref_no,
           pi.id AS picking_item_id, pi.part_id, po.ship_to,
           pi.qty AS required_qty, pi.picked_qty,
           (pi.qty - pi.picked_qty - COALESCE((
             SELECT SUM(pp.qty) FROM picking_packages pp
             WHERE pp.picking_item_id = pi.id AND pp.shipping_box_id IS NULL
           ), 0)) AS remaining_qty
    FROM picking_items pi
    JOIN picking_orders po ON po.id = pi.picking_order_id
    WHERE po.status != 'finished'
      AND (pi.qty - pi.picked_qty - COALESCE((
        SELECT SUM(pp.qty) FROM picking_packages pp
        WHERE pp.picking_item_id = pi.id AND pp.shipping_box_id IS NULL
      ), 0)) > 0
      AND EXISTS (
        SELECT 1 FROM picking_items pi2
        JOIN allocations a ON a.picking_item_id = pi2.id
        WHERE pi2.picking_order_id = po.id AND a.receiving_order_id = ${orderId}
      )
    ORDER BY po.ref_no`);
  const pickingByPartId: Record<string, Record<string, unknown>[]> = {};
  for (const row of pickingRows) {
    (pickingByPartId[String(row.part_id)] ??= []).push(row);
  }

  return c.json({
    receiving_by_part_no: receivingByPartNo,
    picking_by_part_id: pickingByPartId,
  }, 200);
});

receivingRoute.get("/receiving-orders/:id/picking", (c) => {
  const orderId = c.req.param("id");
  const order = db.get<{ id: string }>(sql`SELECT id FROM receiving_orders WHERE id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "receiving order not found" });

  // One row per allocation: lot allocations traceable to this order through
  // inventory_lot_sources carry the lot's location/date fields; order-level
  // allocations have none. scanned/boxed mirror the web adapter: unboxed vs
  // boxed package qty per picking item.
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT po.id AS picking_order_id, po.ref_no AS picking_order_ref, po.status AS picking_order_status,
           po.ship_to AS picking_order_ship_to, pi.id AS picking_item_id, pi.qty AS required_qty, pi.picked_qty,
           a.id AS allocation_id, a.qty AS allocated_qty, pi.part_id, p.part_no,
           il.shelf_code, il.box_id, il.date_code, il.lot_code, il.coo, il.cow,
           COALESCE(pt.scanned_qty, 0) AS scanned_qty,
           COALESCE(pt.boxed_qty, 0) AS boxed_qty
    FROM allocations a
    JOIN picking_items pi ON pi.id = a.picking_item_id
    JOIN picking_orders po ON po.id = pi.picking_order_id
    JOIN parts p ON p.id = pi.part_id
    JOIN inventory_lots il ON il.id = a.inventory_lot_id
    JOIN inventory_lot_sources ils ON ils.inventory_lot_id = a.inventory_lot_id
    JOIN receiving_invoice_items rii ON rii.id = ils.receiving_invoice_item_id
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    LEFT JOIN (SELECT picking_item_id,
                      SUM(CASE WHEN shipping_box_id IS NULL THEN qty ELSE 0 END) AS scanned_qty,
                      SUM(CASE WHEN shipping_box_id IS NOT NULL THEN qty ELSE 0 END) AS boxed_qty
               FROM picking_packages GROUP BY picking_item_id) pt ON pt.picking_item_id = pi.id
    WHERE ri.receiving_order_id = ${orderId} AND a.qty > 0
    GROUP BY a.id
    UNION ALL
    SELECT po.id, po.ref_no, po.status, po.ship_to, pi.id, pi.qty, pi.picked_qty,
           a.id, a.qty, pi.part_id, p.part_no,
           NULL, NULL, NULL, NULL, NULL, NULL,
           COALESCE(pt.scanned_qty, 0),
           COALESCE(pt.boxed_qty, 0)
    FROM allocations a
    JOIN picking_items pi ON pi.id = a.picking_item_id
    JOIN picking_orders po ON po.id = pi.picking_order_id
    JOIN parts p ON p.id = pi.part_id
    LEFT JOIN (SELECT picking_item_id,
                      SUM(CASE WHEN shipping_box_id IS NULL THEN qty ELSE 0 END) AS scanned_qty,
                      SUM(CASE WHEN shipping_box_id IS NOT NULL THEN qty ELSE 0 END) AS boxed_qty
               FROM picking_packages GROUP BY picking_item_id) pt ON pt.picking_item_id = pi.id
    WHERE a.receiving_order_id = ${orderId} AND a.qty > 0
    ORDER BY picking_order_ref, picking_item_id`);

  const itemIds = [...new Set(rows.map((r) => String(r.picking_item_id)))];
  const orderIds = [...new Set(rows.map((r) => String(r.picking_order_id)))];

  // The web adapter returns ALL packages for the involved items (boxed + unboxed).
  const packagesByItem: Record<string, Record<string, unknown>[]> = {};
  if (itemIds.length) {
    const pkgs = db.all<Record<string, unknown>>(sql`
      SELECT id, picking_item_id, source_type, source_id, qty, shipping_box_id,
             date_code, lot_code, coo, cow, verified, created_at, updated_at
      FROM picking_packages
      WHERE picking_item_id IN (${sql.join(itemIds.map((i) => sql`${i}`))})
      ORDER BY created_at`);
    for (const pkg of pkgs) {
      const key = String(pkg.picking_item_id);
      (packagesByItem[key] ??= []).push(pkg);
    }
  }

  const boxesByOrder: Record<string, Record<string, unknown>[]> = {};
  if (orderIds.length) {
    const boxes = db.all<Record<string, unknown>>(sql`
      SELECT id, picking_order_id, status
      FROM shipping_boxes
      WHERE picking_order_id IN (${sql.join(orderIds.map((i) => sql`${i}`))})
      ORDER BY id`);
    for (const box of boxes) {
      const key = String(box.picking_order_id);
      (boxesByOrder[key] ??= []).push(box);
    }
  }

  const transitionLogs: Record<string, Record<string, unknown>[]> = {};
  if (orderIds.length) {
    const logs = db.all<Record<string, unknown>>(sql`
      SELECT tl.id, tl.entity_type, tl.entity_id, tl.from_status, tl.to_status,
             tl.actor_id, tl.note, tl.created_at, tl.updated_at, u.name AS actor_name
      FROM transition_logs tl
      LEFT JOIN users u ON u.id = tl.actor_id
      WHERE tl.entity_type = 'picking_order'
        AND tl.entity_id IN (${sql.join(orderIds.map((i) => sql`${i}`))})
      ORDER BY tl.created_at DESC`);
    for (const log of logs) {
      const key = String(log.entity_id);
      (transitionLogs[key] ??= []).push(log);
    }
  }

  return c.json({
    rows,
    packages_by_item: packagesByItem,
    boxes_by_order: boxesByOrder,
    transition_logs: transitionLogs,
  }, 200);
});

receivingRoute.post("/picking-items/transition-logs", async (c) => {
  let body: { ids?: unknown };
  try {
    body = await c.req.json<{ ids?: unknown }>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === "string")) {
    throw new HTTPException(400, { message: "ids must be a non-empty string array" });
  }
  const logs = db.all<Record<string, unknown>>(sql`
    SELECT tl.id, tl.entity_type, tl.entity_id, tl.from_status, tl.to_status,
           tl.actor_id, tl.note, tl.created_at, tl.updated_at, u.name AS actor_name
    FROM transition_logs tl
    LEFT JOIN users u ON u.id = tl.actor_id
    WHERE tl.entity_type = 'picking_item'
      AND tl.entity_id IN (${sql.join(ids.map((i) => sql`${i}`))})
    ORDER BY tl.created_at DESC`);
  return c.json({ logs }, 200);
});

receivingRoute.put("/receiving-orders/:external_id", async (c) => {
  const externalId = c.req.param("external_id");
  let body: ReceivingPutBody;
  try {
    body = await c.req.json<ReceivingPutBody>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const result = db.transaction((tx) => upsertReceivingOrder(tx, externalId, body));
  const res: IngestUpsertResponse = { id: result.orderId, external_id: externalId, created: result.created, changed: result.changed };
  return c.json(res, result.created ? 201 : 200);
});

// :external_id accepts either the internal order id or the ingest external_id
// (the web adapter passes internal ids).
receivingRoute.post("/receiving-orders/:external_id/confirm-arrival", (c) => {
  const externalId = c.req.param("external_id");
  const order = db.transaction((tx) => {
    const found = tx.get<{ id: string }>(sql`SELECT id FROM receiving_orders WHERE id = ${externalId} OR external_id = ${externalId}`);
    if (!found) throw new HTTPException(404, { message: "receiving order not found" });
    confirmReceivingArrival(tx, found.id);
    return found;
  });
  // Allocation is best-effort and recomputable; it must never roll back a confirmed arrival.
  try {
    allocateAll(db);
  } catch (err) {
    console.error("allocateAll after confirm-arrival failed", err);
  }
  const res: ConfirmArrivalResponse = { id: order.id, status: "in_hand" };
  return c.json(res, 200);
});
