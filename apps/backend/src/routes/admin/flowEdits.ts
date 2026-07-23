import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../../db.js";
import { updatePickingDeliveryDate, updateReceivingItemDateCode } from "../../db/adminedits.js";
import { actorFrom } from "../../auth/middleware.js";

// Thin routes over db/adminedits.ts — admin console edits to flow data.

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const adminFlowEditsRoute = new Hono();

// Change the picking order's delivery date (TOC 4.2). `null` clears it.
adminFlowEditsRoute.patch("/picking-orders/:id", async (c) => {
  const body = await readJson(c);
  if (!("deliveryDate" in body)) throw new HTTPException(400, { message: "deliveryDate is required" });
  const v = body.deliveryDate;
  if (v !== null && typeof v !== "string") throw new HTTPException(400, { message: "deliveryDate must be YYYY-MM-DD" });
  return c.json(
    await updatePickingDeliveryDate(db, {
      orderId: c.req.param("id"),
      deliveryDate: v === null || (v as string).trim() === "" ? null : (v as string).trim(),
      actorId: actorFrom(c).id,
    }),
    200
  );
});

// Change one receiving invoice item's date code (TOC 4.1). `null` clears it.
adminFlowEditsRoute.patch("/receiving-invoice-items/:id", async (c) => {
  const body = await readJson(c);
  if (!("dateCode" in body)) throw new HTTPException(400, { message: "dateCode is required" });
  const v = body.dateCode;
  if (v !== null && typeof v !== "string") throw new HTTPException(400, { message: "dateCode must be a string" });
  return c.json(
    await updateReceivingItemDateCode(db, {
      itemId: c.req.param("id"),
      dateCode: v === null || (v as string).trim() === "" ? null : (v as string).trim(),
      actorId: actorFrom(c).id,
    }),
    200
  );
});
