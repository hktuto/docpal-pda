import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { VerifyShelfBoxItemRequest } from "@warehouse/shared";
import { db } from "../db.js";
import { verifyShelfBoxItem } from "../db/putAway.js";

export const goodsVerifyRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try { return await c.req.json<T>(); } catch { throw new HTTPException(400, { message: "invalid JSON body" }); }
}

goodsVerifyRoute.post("/shelf-boxes/:id/verify-item", async (c) => {
  const shelfBoxId = c.req.param("id");
  const body = await readJson<VerifyShelfBoxItemRequest>(c);
  if (!body.part_id) throw new HTTPException(400, { message: "part_id is required" });
  const result = db.transaction((tx) => verifyShelfBoxItem(tx, { shelfBoxId, partId: body.part_id, actorId: body.actor_id ?? null }));
  return c.json({ ok: true, verified_count: result.verifiedCount }, 200);
});
