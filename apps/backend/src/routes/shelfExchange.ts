import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import {
  previewShelfExchange,
  commitShelfExchange,
  scheduleAllocateAll,
} from "../db/shelfExchange.js";
import { actorFrom } from "../auth/middleware.js";

async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const shelfExchangeRoute = new Hono();

// Preview a shelf exchange: resolve the lot on the source shelf for a
// scanned label (spec 2026-10-12-shelf-exchange-design.md). The PDA calls
// this right after the item scan so mismatches surface before the target
// shelf is scanned.
shelfExchangeRoute.post("/shelf-exchange/preview", async (c) => {
  const body = await readJson<{
    sourceShelfCode?: string;
    partNo?: string;
    wclItemNo?: string | null;
    qty?: number;
    dateCode?: string | null;
    lotCode?: string | null;
    coo?: string | null;
    cow?: string | null;
  }>(c);

  if (!body.sourceShelfCode) {
    throw new HTTPException(400, { message: "sourceShelfCode is required" });
  }
  if (typeof body.qty !== "number") {
    throw new HTTPException(400, { message: "qty is required" });
  }

  return c.json(
    await previewShelfExchange(db, {
      sourceShelfCode: body.sourceShelfCode,
      partNo: body.partNo,
      wclItemNo: body.wclItemNo ?? null,
      qty: body.qty,
      dateCode: body.dateCode ?? null,
      lotCode: body.lotCode ?? null,
      coo: body.coo ?? null,
      cow: body.cow ?? null,
    }),
    200
  );
});

// Commit a shelf exchange (spec 2026-10-12-shelf-exchange-design.md).
shelfExchangeRoute.post("/shelf-exchange", async (c) => {
  const body = await readJson<{
    sourceShelfCode?: string;
    targetShelfCode?: string;
    lotId?: string;
    qty?: number;
  }>(c);

  if (!body.sourceShelfCode) {
    throw new HTTPException(400, { message: "sourceShelfCode is required" });
  }
  if (!body.targetShelfCode) {
    throw new HTTPException(400, { message: "targetShelfCode is required" });
  }
  if (!body.lotId) {
    throw new HTTPException(400, { message: "lotId is required" });
  }
  if (typeof body.qty !== "number") {
    throw new HTTPException(400, { message: "qty is required" });
  }

  const result = await commitShelfExchange(db, {
    sourceShelfCode: body.sourceShelfCode,
    targetShelfCode: body.targetShelfCode,
    lotId: body.lotId,
    qty: body.qty,
    actorId: actorFrom(c).id,
  });
  // The stock moved location — re-run allocation in the background.
  scheduleAllocateAll(db, "shelf exchange");
  return c.json(result, 201);
});
