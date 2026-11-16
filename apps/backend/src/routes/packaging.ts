import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.js";
import { confirmPackaging, getPackagingOrderDetail, listPackagingOrders, parseConfirmPackagingInput } from "../db/packaging.js";
import { getUserScope } from "../db/user-scope.js";
import { actorFrom, visibilityUsername } from "../auth/middleware.js";

export const packagingRoute = new Hono();

// Packaging queue (打包, spec 2026-11-10-packaging-shipping-steps-design.md):
// picking-complete, fully boxed + verified orders awaiting the weight/count
// confirm; ?status=completed lists the packaged history. Scoped like the
// labeling queue (org + user scope + assignee visibility).
packagingRoute.get("/packaging-orders", async (c) => {
  const scope = await getUserScope(db, actorFrom(c).username);
  return c.json(
    await listPackagingOrders(db, {
      status: c.req.query("status"),
      search: c.req.query("search"),
      scope,
      username: visibilityUsername(c),
    }),
    200
  );
});

// Consolidated detail: queue row + the order's boxes (the auto-count source).
packagingRoute.get("/packaging-orders/:orderId", async (c) => {
  const scope = await getUserScope(db, actorFrom(c).username);
  return c.json(await getPackagingOrderDetail(db, c.req.param("orderId"), { scope, username: visibilityUsername(c) }), 200);
});

// Confirm payload (spec 2026-11-16-packaging-box-cart-modes-design.md):
// { mode: "box", weight, boxCount } or { mode: "pallet", pallets: [...] }.
// Legacy shim (pre-2026-11-16 clients): { weight, palletCount? } without a
// mode maps to box mode with no 打包記錄 box count; palletCount rides through
// as the stored pallet count. 409 packaging_not_ready covers double-confirm.
packagingRoute.post("/packaging-orders/:orderId/confirm", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.mode === undefined) {
    // Legacy: single weight + optional pallet count.
    if (typeof body.weight !== "number") throw new HTTPException(400, { message: "weight_required" });
    if (body.palletCount !== undefined && body.palletCount !== null && typeof body.palletCount !== "number") {
      throw new HTTPException(400, { message: "invalid_pallet_count" });
    }
    const result = await confirmPackaging(db, {
      orderId: c.req.param("orderId"),
      input: {
        mode: "box",
        weight: body.weight,
        boxCount: null,
        palletCount:
          body.palletCount === undefined || body.palletCount === null ? null : (body.palletCount as number),
      },
      actorId: actorFrom(c).id,
    });
    return c.json(result, 200);
  }
  const input = parseConfirmPackagingInput(body);
  const result = await confirmPackaging(db, {
    orderId: c.req.param("orderId"),
    input,
    actorId: actorFrom(c).id,
  });
  return c.json(result, 200);
});
