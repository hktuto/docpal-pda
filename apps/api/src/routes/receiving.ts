import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { ConfirmArrivalResponse, IngestUpsertResponse, ReceivingPutBody } from "@warehouse/shared";
import { db } from "../db.js";
import { allocateAll } from "../db/allocate.js";
import { confirmReceivingArrival, upsertReceivingOrder } from "../ingest/receiving.js";

export const receivingRoute = new Hono();

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
