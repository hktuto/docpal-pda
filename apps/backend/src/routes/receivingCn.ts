import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import { actorFrom } from "../auth/middleware.js";
import { cnReceiving } from "../config.js";
import { createCnManualReceipt, validateCnManualReceipt } from "../db/receivingCn.js";

// CN manual receiving (手動收貨) — spec
// docs/superpowers/specs/2026-10-27-manual-receiving-pda-design.md. The PDA
// stages the task locally and commits it here in one call (no DocPal
// workflow). Invisible unless the flow-config cnReceiving flag is on: every
// route 404s when off (same gating as /put-away-cn/*).

export const receivingCnRoute = new Hono();

// Empty bodies parse as {} (same convention as the other flow routes).
async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

// POST /receiving-cn/manual-receipts — commit one manual-receiving task:
// {orders: [{orderNo, items: [{partNo, qty, dateCode?, lotCode?, coo?, cow?,
// ctnNo?, supplierCode?, raw?}]}]} → 201 {id, batchNo, putAwayTaskId}. One tx
// writes the _cn order (in_hand) + invoices + items + the CN put-away task.
// 400 invalid_payload on shape errors.
receivingCnRoute.post("/receiving-cn/manual-receipts", async (c) => {
  if (!cnReceiving()) throw new HTTPException(404, { message: "not_found" });
  const orders = validateCnManualReceipt(await readJson(c));
  const result = await createCnManualReceipt(db, { orders, actor: actorFrom(c) });
  return c.json(result, 201);
});
