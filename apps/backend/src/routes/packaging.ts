import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.js";
import { confirmPackaging, getPackagingOrderDetail, listPackagingOrders } from "../db/packaging.js";
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

// Confirm: { weight (kg), palletCount? } → stamps packaged_at/by, box count is
// recomputed server-side. 409 packaging_not_ready when off-queue (covers
// double-confirm).
packagingRoute.post("/packaging-orders/:orderId/confirm", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { weight?: unknown; palletCount?: unknown };
  if (typeof body.weight !== "number") throw new HTTPException(400, { message: "weight_required" });
  if (body.palletCount !== undefined && body.palletCount !== null && typeof body.palletCount !== "number") {
    throw new HTTPException(400, { message: "invalid_pallet_count" });
  }
  const result = await confirmPackaging(db, {
    orderId: c.req.param("orderId"),
    weight: body.weight,
    palletCount: body.palletCount === undefined || body.palletCount === null ? null : body.palletCount,
    actorId: actorFrom(c).id,
  });
  return c.json(result, 200);
});
