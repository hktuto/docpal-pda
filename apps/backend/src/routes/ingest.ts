import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import {
  upsertReceivingOrder,
  upsertPickingOrder,
  type IngestReceivingBody,
  type IngestPickingBody,
} from "../db/ingest.js";
import { allocateAll } from "../db/allocate.js";

async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const ingestRoute = new Hono();

// PUT /receiving-orders/:batchNo — idempotent ingest upsert keyed by the
// natural batch_no. 201 on create, 200 on reconcile (`changed` reports whether
// anything differed). Changed expected qtys on an order past pending move
// allocation demand → best-effort allocateAll after commit (a new pending
// order needs no trigger, plan phase 7).
ingestRoute.put("/receiving-orders/:batchNo", async (c) => {
  const body = await readJson<IngestReceivingBody>(c);
  const result = await upsertReceivingOrder(db, c.req.param("batchNo"), body);
  if (result.changed && result.orderStatus !== "pending") {
    try {
      await allocateAll(db);
    } catch (err) {
      console.error("allocateAll after receiving upsert failed", err);
    }
  }
  return c.json(
    { id: result.id, created: result.created, changed: result.changed },
    result.created ? 201 : 200
  );
});

// PUT /picking-orders/:orderNo — same upsert pattern for picking orders
// (order_no is the upstream sync/dedup key). Any change to an open
// (pending/picking) order → best-effort allocateAll after commit.
ingestRoute.put("/picking-orders/:orderNo", async (c) => {
  const body = await readJson<IngestPickingBody>(c);
  const result = await upsertPickingOrder(db, c.req.param("orderNo"), body);
  if (result.changed && (result.orderStatus === "pending" || result.orderStatus === "picking")) {
    try {
      await allocateAll(db);
    } catch (err) {
      console.error("allocateAll after picking upsert failed", err);
    }
  }
  return c.json(
    { id: result.id, created: result.created, changed: result.changed },
    result.created ? 201 : 200
  );
});
