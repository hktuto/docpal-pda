import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../../db.js";
import { updatePickingDeliveryDate, updatePickingOrderFields, updateReceivingDeliveryDate, updateReceivingItemFields } from "../../db/adminedits.js";
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

// Change the picking order's delivery date (TOC 4.2), ship-to text, and/or
// ship-from location pair (orgId + subInventoryCode, set together; both null
// clears the pair). `null` clears a field; absent keys stay unchanged.
adminFlowEditsRoute.patch("/picking-orders/:id", async (c) => {
  const body = await readJson(c);
  const orderId = c.req.param("id");
  const actorId = actorFrom(c).id;
  const hasDate = "deliveryDate" in body;
  const hasShipTo = "shipTo" in body;
  const hasLocation = "orgId" in body || "subInventoryCode" in body;
  if (!hasDate && !hasShipTo && !hasLocation)
    throw new HTTPException(400, { message: "at least one of deliveryDate, shipTo, orgId/subInventoryCode is required" });
  let result: Record<string, unknown> = { id: orderId };
  if (hasDate) {
    const v = body.deliveryDate;
    if (v !== null && typeof v !== "string") throw new HTTPException(400, { message: "deliveryDate must be YYYY-MM-DD" });
    result = await updatePickingDeliveryDate(db, {
      orderId,
      deliveryDate: v === null || (v as string).trim() === "" ? null : (v as string).trim(),
      actorId,
    });
  }
  if (hasShipTo || hasLocation) {
    const fields: { orderId: string; shipTo?: string | null; orgId?: number | null; subInventoryCode?: string | null; actorId: string | null } = { orderId, actorId };
    if (hasShipTo) {
      const v = body.shipTo;
      if (v !== null && typeof v !== "string") throw new HTTPException(400, { message: "shipTo must be a string" });
      fields.shipTo = v === null || (v as string).trim() === "" ? null : (v as string).trim();
    }
    if ("orgId" in body) {
      const v = body.orgId;
      if (v !== null && !Number.isInteger(v)) throw new HTTPException(400, { message: "orgId must be an integer" });
      fields.orgId = v as number | null;
    }
    if ("subInventoryCode" in body) {
      const v = body.subInventoryCode;
      if (v !== null && typeof v !== "string") throw new HTTPException(400, { message: "subInventoryCode must be a string" });
      fields.subInventoryCode = v === null || (v as string).trim() === "" ? null : (v as string).trim();
    }
    result = { ...result, ...(await updatePickingOrderFields(db, fields)) };
  }
  return c.json(result, 200);
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
