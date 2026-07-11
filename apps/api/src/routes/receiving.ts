import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { IngestUpsertResponse, ReceivingPutBody } from "@warehouse/shared";
import { db } from "../db.js";
import { upsertReceivingOrder } from "../ingest/receiving.js";

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
