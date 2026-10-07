import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../../db.js";
import { actorFrom } from "../../auth/middleware.js";
import { listOutdatedWarnings, resolveOrderOutdatedWarnings } from "../../db/outdated.js";
import { retryAutoFinishPickingOrder } from "../../db/picking.js";
import { retryReceivingOrderClear } from "../../db/putaway.js";

// Supplier outdated date-code scan warnings (spec
// docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md):
// the admin console's warnings list + whole-order resolution. Live updates
// ride the outdated.warning.created / outdated.warning.resolved SSE events
// (topics: /admin/outdated-warnings + the order's list topic).

export const adminOutdatedWarningsRoute = new Hono();

// Empty bodies parse as {} (same convention as the flow routes).
async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

// Warnings list, newest first, with order no / part / supplier / actor names
// joined for display. ?resolved=true|false (absent = all), ?orderKind=picking|putaway.
adminOutdatedWarningsRoute.get("/outdated-warnings", async (c) => {
  const resolvedParam = c.req.query("resolved");
  if (resolvedParam !== undefined && resolvedParam !== "true" && resolvedParam !== "false") {
    throw new HTTPException(400, { message: "invalid_resolved_param" });
  }
  const orderKind = c.req.query("orderKind");
  if (orderKind !== undefined && orderKind !== "picking" && orderKind !== "putaway") {
    throw new HTTPException(400, { message: "invalid_order_kind" });
  }
  return c.json(
    await listOutdatedWarnings(db, {
      resolved: resolvedParam === undefined ? undefined : resolvedParam === "true",
      orderKind,
    })
  );
});

// Whole-order resolution: stamp every unresolved warning of the order with
// resolved_at/resolved_by/resolution_note (tx) + outdated.warning.resolved
// event. Idempotent — { resolved: 0 } when nothing is pending. A resolution
// that clears pending warnings completes a held order: the picking auto-
// finish / receiving auto-clear check is re-run from here (route layer —
// outdated.ts must not import the flow modules).
adminOutdatedWarningsRoute.post("/outdated-warnings/resolve-order", async (c) => {
  const body = await readJson<{ orderKind?: string; orderId?: string; note?: string }>(c);
  if (!body.orderKind) throw new HTTPException(400, { message: "orderKind is required" });
  if (!body.orderId) throw new HTTPException(400, { message: "orderId is required" });
  const actorId = actorFrom(c).id;
  const result = await resolveOrderOutdatedWarnings(db, {
    orderKind: body.orderKind,
    orderId: body.orderId,
    note: body.note ?? null,
    actorId,
  });
  if (result.resolved > 0) {
    if (body.orderKind === "picking") {
      await retryAutoFinishPickingOrder(db, { pickingOrderId: body.orderId, actorId });
    } else {
      await retryReceivingOrderClear(db, { receivingOrderId: body.orderId, actorId });
    }
  }
  return c.json(result, 200);
});
