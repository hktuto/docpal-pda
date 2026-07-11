import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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
