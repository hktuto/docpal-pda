import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { IngestUpsertResponse, PickingPutBody } from "@warehouse/shared";
import { db } from "../db.js";
import { upsertPickingOrder } from "../ingest/picking.js";
import { allocatePickingOrder } from "../db/allocate.js";

export const pickingRoute = new Hono();

pickingRoute.put("/picking-orders/:external_id", async (c) => {
  const externalId = c.req.param("external_id");
  let body: PickingPutBody;
  try {
    body = await c.req.json<PickingPutBody>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const result = db.transaction((tx) => upsertPickingOrder(tx, externalId, body));
  if (result.changed) allocatePickingOrder(db, result.orderId);
  const res: IngestUpsertResponse = { id: result.orderId, external_id: externalId, created: result.created, changed: result.changed };
  return c.json(res, result.created ? 201 : 200);
});
