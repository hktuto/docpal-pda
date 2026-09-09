import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../../db.js";
import { updatePickingDeliveryDate, updateReceivingDeliveryDate, updateReceivingItemFields } from "../../db/adminedits.js";
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

// Change the receiving order's delivery date. `null` clears it.
adminFlowEditsRoute.patch("/receiving-orders/:id", async (c) => {
  const body = await readJson(c);
  if (!("deliveryDate" in body)) throw new HTTPException(400, { message: "deliveryDate is required" });
  const v = body.deliveryDate;
  if (v !== null && typeof v !== "string") throw new HTTPException(400, { message: "deliveryDate must be YYYY-MM-DD" });
  return c.json(
    await updateReceivingDeliveryDate(db, {
      orderId: c.req.param("id"),
      deliveryDate: v === null || (v as string).trim() === "" ? null : (v as string).trim(),
      actorId: actorFrom(c).id,
    }),
    200
  );
});

// Change editable fields on one receiving invoice item (date code, lot code,
// COO, COW, CTN no). `null` or "" clears a field; absent keys stay unchanged.
const RECEIVING_ITEM_EDITABLE = ["dateCode", "lotCode", "coo", "cow", "ctnNo"] as const;

adminFlowEditsRoute.patch("/receiving-invoice-items/:id", async (c) => {
  const body = await readJson(c);
  const fields: Record<string, string | null> = {};
  for (const k of RECEIVING_ITEM_EDITABLE) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v !== null && typeof v !== "string") throw new HTTPException(400, { message: `${k} must be a string` });
    fields[k] = v === null || v.trim() === "" ? null : v.trim();
  }
  if (Object.keys(fields).length === 0)
    throw new HTTPException(400, { message: `at least one of ${RECEIVING_ITEM_EDITABLE.join(", ")} is required` });
  return c.json(
    await updateReceivingItemFields(db, {
      itemId: c.req.param("id"),
      fields,
      actorId: actorFrom(c).id,
    }),
    200
  );
});
