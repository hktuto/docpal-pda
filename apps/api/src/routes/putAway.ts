import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { CreateShelfBoxRequest, RecordPutAwayScanRequest, AssignScanToBoxRequest } from "@warehouse/shared";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryAll, queryGet } from "../db/query.js";
import { createShelfBox, cancelShelfBox, recordPutAwayScan, removeScannedPiece, assignScanToBox, addAllUnboxedToBox, removeScanFromBox, closeShelfBox } from "../db/putAway.js";

export const putAwayRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try { return await c.req.json<T>(); } catch { throw new HTTPException(400, { message: "invalid JSON body" }); }
}

putAwayRoute.post("/receiving-orders/:id/shelf-boxes", async (c) => {
  const receivingOrderId = c.req.param("id");
  const body = await readJson<CreateShelfBoxRequest>(c);
  if (!body.shelf_code) throw new HTTPException(400, { message: "shelf_code is required" });
  const result = await db.transaction(async (tx) => createShelfBox(tx, { receivingOrderId, shelfCode: body.shelf_code, actorId: body.actor_id ?? null }));
  return c.json(result, 201);
});

putAwayRoute.delete("/shelf-boxes/:id", async (c) => {
  const shelfBoxId = c.req.param("id");
  await db.transaction(async (tx) => cancelShelfBox(tx, { shelfBoxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.post("/put-away/scans", async (c) => {
  const body = await readJson<RecordPutAwayScanRequest>(c);
  if (!body.receiving_invoice_item_id) throw new HTTPException(400, { message: "receiving_invoice_item_id is required" });
  const result = await db.transaction(async (tx) => recordPutAwayScan(tx, {
    receivingInvoiceItemId: body.receiving_invoice_item_id, qty: body.qty,
    dateCode: body.date_code ?? null, lotCode: body.lot_code ?? null, coo: body.coo ?? null, cow: body.cow ?? null,
  })) as Record<string, any>;
  if (result.shelf_box_id) {
    const box = await queryGet<{ shelfCode: string | null }>(db, sql`SELECT shelf_code AS "shelfCode" FROM shelf_boxes WHERE id = ${result.shelf_box_id}`);
    if (box?.shelfCode === null) result.shelf_box_id = null;
  }
  return c.json(result, 201);
});

putAwayRoute.post("/put-away/scans/:id/remove-piece", async (c) => {
  const scanId = c.req.param("id");
  await db.transaction(async (tx) => removeScannedPiece(tx, { scanId }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.post("/put-away/scans/:id/assign-to-box", async (c) => {
  const scanId = c.req.param("id");
  const body = await readJson<AssignScanToBoxRequest>(c);
  if (!body.shelf_box_id) throw new HTTPException(400, { message: "shelf_box_id is required" });
  await db.transaction(async (tx) => assignScanToBox(tx, { scanId, shelfBoxId: body.shelf_box_id, actorId: body.actor_id ?? null }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.post("/shelf-boxes/:id/add-all-unboxed", async (c) => {
  const shelfBoxId = c.req.param("id");
  const result = await db.transaction(async (tx) => addAllUnboxedToBox(tx, { shelfBoxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json(result, 200);
});

putAwayRoute.post("/put-away/scans/:id/remove-from-box", async (c) => {
  const scanId = c.req.param("id");
  await db.transaction(async (tx) => removeScanFromBox(tx, { scanId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.post("/shelf-boxes/:id/close", async (c) => {
  const shelfBoxId = c.req.param("id");
  await db.transaction(async (tx) => closeShelfBox(tx, { shelfBoxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.get("/put-away/candidates", async (c) => {
  const rows = await queryAll<Record<string, unknown>>(db, sql`
    SELECT ro.id, ro.ref_no, ro.status, s.name AS supplier_name,
           SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty)::int AS available_qty,
           COALESCE(SUM(u.unboxed_qty)::int, 0) AS unboxed_qty
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    LEFT JOIN suppliers s ON s.id = ro.supplier_id
    LEFT JOIN (
      SELECT sbi.receiving_invoice_item_id, SUM(sbi.qty)::int AS unboxed_qty
      FROM shelf_box_items sbi
      JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
      WHERE sb.shelf_code IS NULL
      GROUP BY sbi.receiving_invoice_item_id
    ) u ON u.receiving_invoice_item_id = rii.id
    WHERE ro.status = 'in_hand'
    GROUP BY ro.id, s.name
    HAVING SUM(rii.received_qty - rii.picked_qty - rii.put_away_qty)::int > 0
        OR COALESCE(SUM(u.unboxed_qty)::int, 0) > 0
    ORDER BY ro.ref_no`);
  return c.json(rows, 200);
});

putAwayRoute.get("/receiving-orders/:id/put-away-lots", async (c) => {
  const orderId = c.req.param("id");
  const rows = await queryAll<Record<string, unknown>>(db, sql`
    SELECT rii.id AS receiving_invoice_item_id, p.id AS part_id, p.part_no,
           rii.date_code, rii.lot_code, rii.coo, rii.cow,
           rii.qty AS total_qty,
           (rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.alloc_qty, 0))::int AS available_qty,
           COALESCE(SUM(sbi.qty)::int, 0) AS scanned_qty,
           COALESCE(SUM(CASE WHEN sb.shelf_code IS NOT NULL THEN sbi.qty ELSE 0 END)::int, 0) AS boxed_qty
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    JOIN parts p ON p.id = rii.part_id
    LEFT JOIN shelf_box_items sbi ON sbi.receiving_invoice_item_id = rii.id
    LEFT JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
    LEFT JOIN (
      SELECT receiving_invoice_item_id, COALESCE(SUM(qty), 0)::int AS alloc_qty
      FROM allocations GROUP BY receiving_invoice_item_id
    ) alloc ON alloc.receiving_invoice_item_id = rii.id
    WHERE ro.id = ${orderId} AND ro.status = 'in_hand'
    GROUP BY rii.id, p.id, p.part_no, rii.date_code, rii.lot_code, rii.coo, rii.cow, rii.qty,
             rii.received_qty, rii.picked_qty, rii.put_away_qty, alloc.alloc_qty
    HAVING (rii.received_qty - rii.picked_qty - rii.put_away_qty - COALESCE(alloc.alloc_qty, 0)) > 0
        OR COALESCE(SUM(CASE WHEN sb.shelf_code IS NULL THEN sbi.qty ELSE 0 END)::int, 0) > 0
    ORDER BY p.part_no, rii.date_code`);
  return c.json(rows, 200);
});

putAwayRoute.get("/receiving-orders/:id/put-away-scans", async (c) => {
  const orderId = c.req.param("id");
  const rows = await queryAll<Record<string, unknown>>(db, sql`
    SELECT sbi.id, sbi.receiving_invoice_item_id, rii.part_id, sbi.qty,
           rii.date_code, rii.lot_code, rii.coo, rii.cow,
           CASE WHEN sb.shelf_code IS NULL THEN NULL ELSE sbi.shelf_box_id END AS shelf_box_id,
           sbi.verified, sbi.verified_at
    FROM shelf_box_items sbi
    JOIN receiving_invoice_items rii ON rii.id = sbi.receiving_invoice_item_id
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    LEFT JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
    WHERE ri.receiving_order_id = ${orderId}
    ORDER BY sbi.id DESC`);
  return c.json(rows, 200);
});

putAwayRoute.get("/receiving-orders/:id/shelf-boxes", async (c) => {
  const orderId = c.req.param("id");
  const boxes = await queryAll<Record<string, unknown>>(db, sql`
    SELECT id, receiving_order_id, shelf_code, status, created_at
    FROM shelf_boxes
    WHERE receiving_order_id = ${orderId} AND shelf_code IS NOT NULL
    ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC`);
  if (boxes.length === 0) return c.json([], 200);
  const items = await queryAll<Record<string, unknown>>(db, sql`
    SELECT sbi.shelf_box_id, sbi.part_id, p.part_no,
           SUM(sbi.qty)::int AS qty, BOOL_AND(sbi.verified) AS verified
    FROM shelf_box_items sbi
    JOIN parts p ON p.id = sbi.part_id
    WHERE sbi.shelf_box_id IN (SELECT id FROM shelf_boxes WHERE receiving_order_id = ${orderId})
    GROUP BY sbi.shelf_box_id, sbi.part_id, p.part_no`);
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
