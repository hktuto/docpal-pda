import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import { actorFrom } from "../auth/middleware.js";
import { cnReceiving } from "../config.js";
import { createCnManualReceipt, validateCnManualReceipt } from "../db/receivingCn.js";
import {
  finalizeCnScanTask,
  flagCnItem,
  getCnScanTaskDetail,
  listCnScanTasks,
  resetCnItemScan,
  scanCnItem,
  type CnScanInput,
} from "../db/receivingCnScan.js";

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

// --- receiving scan tasks (pdf path) ---------------------------------------
// Spec docs/superpowers/plans/2026-11-01-cn-receiving-scan.md: the admin
// confirm / workflow finalize moves a CN order to `scanning`; these endpoints
// are the PDA 收貨掃描 task that resolves each item against the physical
// goods and receives only the clean ones. Same cnReceiving() gate as above.

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HTTPException(400, { message: `invalid_payload: ${key} must be a string` });
  return v;
}

receivingCnRoute.get("/receiving-cn/scan-tasks", async (c) => {
  if (!cnReceiving()) throw new HTTPException(404, { message: "not_found" });
  return c.json(await listCnScanTasks(db, actorFrom(c).username), 200);
});

receivingCnRoute.get("/receiving-cn/scan-tasks/:id", async (c) => {
  if (!cnReceiving()) throw new HTTPException(404, { message: "not_found" });
  return c.json(await getCnScanTaskDetail(db, c.req.param("id"), actorFrom(c).username), 200);
});

// {qty, dateCode?, lotCode?, coo?, cow?, raw?} → updated item; qty ≠ line_qty
// → scanStatus 'warning' + scanReason 'qty_mismatch', else 'ok'.
receivingCnRoute.post("/receiving-cn/scan-tasks/:id/items/:itemId/scan", async (c) => {
  if (!cnReceiving()) throw new HTTPException(404, { message: "not_found" });
  const body = (await readJson(c)) as Record<string, unknown>;
  const qty = body.qty;
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0) {
    throw new HTTPException(400, { message: "invalid_payload: qty must be a positive integer" });
  }
  const input: CnScanInput = {
    qty,
    dateCode: optString(body, "dateCode"),
    lotCode: optString(body, "lotCode"),
    coo: optString(body, "coo"),
    cow: optString(body, "cow"),
    raw: optString(body, "raw"),
  };
  const actor = actorFrom(c);
  return c.json(await scanCnItem(db, c.req.param("id"), c.req.param("itemId"), input, actor), 200);
});

// {reason: missing|damaged|wrong_part|other, note?, wrongPartNo?} → updated
// item (scanStatus 'error' + mirrored mismatch columns).
receivingCnRoute.post("/receiving-cn/scan-tasks/:id/items/:itemId/flag", async (c) => {
  if (!cnReceiving()) throw new HTTPException(404, { message: "not_found" });
  const body = (await readJson(c)) as Record<string, unknown>;
  const actor = actorFrom(c);
  return c.json(
    await flagCnItem(
      db,
      c.req.param("id"),
      c.req.param("itemId"),
      {
        reason: body.reason as never,
        note: optString(body, "note"),
        wrongPartNo: optString(body, "wrongPartNo"),
      },
      actor
    ),
    200
  );
});

// Clear one item's scan state back to unresolved → updated item.
receivingCnRoute.post("/receiving-cn/scan-tasks/:id/items/:itemId/reset", async (c) => {
  if (!cnReceiving()) throw new HTTPException(404, { message: "not_found" });
  const actor = actorFrom(c);
  return c.json(await resetCnItemScan(db, c.req.param("id"), c.req.param("itemId"), actor), 200);
});

// {unresolvedAs?: 'missing'} → {id, batchNo, putAwayTaskId}; 409
// unresolved_items while unresolved items remain (unless unresolvedAs), 409
// order_not_scanning when the order is not scanning.
receivingCnRoute.post("/receiving-cn/scan-tasks/:id/finalize", async (c) => {
  if (!cnReceiving()) throw new HTTPException(404, { message: "not_found" });
  const body = (await readJson(c)) as Record<string, unknown>;
  const actor = actorFrom(c);
  return c.json(
    await finalizeCnScanTask(db, c.req.param("id"), { unresolvedAs: body.unresolvedAs as never }, actor),
    200
  );
});
