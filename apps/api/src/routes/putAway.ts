import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { CreateShelfBoxRequest } from "@warehouse/shared";
import { db } from "../db.js";
import { createShelfBox, cancelShelfBox } from "../db/putAway.js";

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
