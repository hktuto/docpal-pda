import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { ConfirmArrivalResponse, IngestUpsertResponse, ReceivingPutBody } from "@warehouse/shared";
import { db } from "../db.js";
import { allocateAll } from "../db/allocate.js";
import { confirmReceivingArrival, upsertReceivingOrder } from "../ingest/receiving.js";

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
    ORDER BY ro.ref_no`);
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

receivingRoute.post("/receiving-orders/:external_id/confirm-arrival", (c) => {
  const externalId = c.req.param("external_id");
  const order = db.transaction((tx) => {
    const found = tx.get<{ id: string }>(sql`SELECT id FROM receiving_orders WHERE external_id = ${externalId}`);
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
