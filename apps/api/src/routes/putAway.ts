import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import type { CreateShelfBoxRequest, RecordPutAwayScanRequest, AssignScanToBoxRequest } from "@warehouse/shared";
import { db } from "../db.js";
import { createShelfBox, cancelShelfBox, recordPutAwayScan, removeScannedPiece, assignScanToBox, addAllUnboxedToBox, removeScanFromBox, closeShelfBox } from "../db/putAway.js";

export const putAwayRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try { return await c.req.json<T>(); } catch { throw new HTTPException(400, { message: "invalid JSON body" }); }
}

putAwayRoute.post("/receiving-orders/:id/shelf-boxes", async (c) => {
  const receivingOrderId = c.req.param("id");
  const body = await readJson<CreateShelfBoxRequest>(c);
  if (!body.shelf_code) throw new HTTPException(400, { message: "shelf_code is required" });
  const result = db.transaction((tx) => createShelfBox(tx, { receivingOrderId, shelfCode: body.shelf_code, actorId: body.actor_id ?? null }));
  return c.json(result, 201);
});

putAwayRoute.delete("/shelf-boxes/:id", (c) => {
  const shelfBoxId = c.req.param("id");
  db.transaction((tx) => cancelShelfBox(tx, { shelfBoxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.post("/put-away/scans", async (c) => {
  const body = await readJson<RecordPutAwayScanRequest>(c);
  if (!body.receiving_invoice_item_id) throw new HTTPException(400, { message: "receiving_invoice_item_id is required" });
  const result = db.transaction((tx) => recordPutAwayScan(tx, {
    receivingInvoiceItemId: body.receiving_invoice_item_id, qty: body.qty,
    dateCode: body.date_code ?? null, lotCode: body.lot_code ?? null, coo: body.coo ?? null, cow: body.cow ?? null,
  }));
  return c.json(result, 201);
});

putAwayRoute.post("/put-away/scans/:id/remove-piece", (c) => {
  const scanId = c.req.param("id");
  db.transaction((tx) => removeScannedPiece(tx, { scanId }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.post("/put-away/scans/:id/assign-to-box", async (c) => {
  const scanId = c.req.param("id");
  const body = await readJson<AssignScanToBoxRequest>(c);
  if (!body.shelf_box_id) throw new HTTPException(400, { message: "shelf_box_id is required" });
  db.transaction((tx) => assignScanToBox(tx, { scanId, shelfBoxId: body.shelf_box_id, actorId: body.actor_id ?? null }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.post("/shelf-boxes/:id/add-all-unboxed", (c) => {
  const shelfBoxId = c.req.param("id");
  const result = db.transaction((tx) => addAllUnboxedToBox(tx, { shelfBoxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json(result, 200);
});

putAwayRoute.post("/put-away/scans/:id/remove-from-box", (c) => {
  const scanId = c.req.param("id");
  db.transaction((tx) => removeScanFromBox(tx, { scanId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.post("/shelf-boxes/:id/close", (c) => {
  const shelfBoxId = c.req.param("id");
  db.transaction((tx) => closeShelfBox(tx, { shelfBoxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.get("/put-away/candidates", (c) => {
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT ro.id, ro.ref_no, ro.status, s.name AS supplier_name,
           SUM(rii.available_qty) AS available_qty,
           COALESCE(SUM(u.unboxed_qty), 0) AS unboxed_qty
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    LEFT JOIN suppliers s ON s.id = ro.supplier_id
    LEFT JOIN (
      SELECT receiving_invoice_item_id, SUM(qty) AS unboxed_qty
      FROM put_away_scans WHERE shelf_box_id IS NULL
      GROUP BY receiving_invoice_item_id
    ) u ON u.receiving_invoice_item_id = rii.id
    WHERE ro.status = 'in_hand'
    GROUP BY ro.id
    HAVING SUM(rii.available_qty) > 0 OR COALESCE(SUM(u.unboxed_qty), 0) > 0
    ORDER BY ro.ref_no`);
  return c.json(rows, 200);
});

putAwayRoute.get("/receiving-orders/:id/put-away-lots", (c) => {
  const orderId = c.req.param("id");
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT rii.id AS receiving_invoice_item_id, p.id AS part_id, p.part_no,
           rii.date_code, rii.lot_code, rii.coo, rii.cow,
           rii.qty AS total_qty, rii.available_qty AS available_qty,
           COALESCE(SUM(pas.qty), 0) AS scanned_qty,
           COALESCE(SUM(CASE WHEN pas.shelf_box_id IS NOT NULL THEN pas.qty ELSE 0 END), 0) AS boxed_qty
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    JOIN parts p ON p.id = rii.part_id
    LEFT JOIN put_away_scans pas ON pas.receiving_invoice_item_id = rii.id
    WHERE ro.id = ${orderId} AND ro.status = 'in_hand'
    GROUP BY rii.id
    HAVING rii.available_qty > 0
        OR COALESCE(SUM(CASE WHEN pas.shelf_box_id IS NULL THEN pas.qty ELSE 0 END), 0) > 0
    ORDER BY p.part_no, rii.date_code`);
  return c.json(rows, 200);
});

putAwayRoute.get("/receiving-orders/:id/put-away-scans", (c) => {
  const orderId = c.req.param("id");
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT pas.id, pas.receiving_invoice_item_id, rii.part_id, pas.qty,
           pas.date_code, pas.lot_code, pas.coo, pas.cow,
           pas.shelf_box_id, pas.verified, pas.verified_at, pas.created_at
    FROM put_away_scans pas
    JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE ri.receiving_order_id = ${orderId}
    ORDER BY pas.created_at DESC`);
  return c.json(rows, 200);
});

putAwayRoute.get("/receiving-orders/:id/shelf-boxes", (c) => {
  const orderId = c.req.param("id");
  const boxes = db.all<Record<string, unknown>>(sql`
    SELECT id, receiving_order_id, shelf_code, status, created_at, updated_at
    FROM shelf_boxes WHERE receiving_order_id = ${orderId}
    ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC`);
  if (boxes.length === 0) return c.json([], 200);
  // Aggregate scan items per box in one query filtered by order id (equivalent to
  // an IN (box ids) list, but avoids building a dynamic parameter list).
  const items = db.all<Record<string, unknown>>(sql`
    SELECT pas.shelf_box_id, rii.part_id, p.part_no,
           SUM(pas.qty) AS qty, MIN(pas.verified) AS verified
    FROM put_away_scans pas
    JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    JOIN parts p ON p.id = rii.part_id
    WHERE ri.receiving_order_id = ${orderId} AND pas.shelf_box_id IS NOT NULL
    GROUP BY pas.shelf_box_id, rii.part_id, p.part_no`);
  const itemsByBox = new Map<string, Record<string, unknown>[]>();
  for (const it of items) {
    const { shelf_box_id, ...rest } = it;
    const key = String(shelf_box_id);
    const list = itemsByBox.get(key) ?? [];
    list.push(rest);
    itemsByBox.set(key, list);
  }
  return c.json(boxes.map((b) => ({ ...b, items: itemsByBox.get(String(b.id)) ?? [] })), 200);
});
