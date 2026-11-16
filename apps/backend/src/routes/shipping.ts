import { Hono } from "hono";
import { db } from "../db.js";
import { getShippingOrderDetail, listShippingOrderGroups, listShippingOrders, shipShippingBox } from "../db/shipping.js";
import { actorFrom } from "../auth/middleware.js";

export const shippingRoute = new Hono();

// Per-box shipping feed (admin console): closed, unshipped boxes — gated on
// the box's completed verify task when the verify step is enabled.
shippingRoute.get("/shipping-orders", async (c) => {
  return c.json(await listShippingOrders(db), 200);
});

// Order-keyed view of the same feed (admin list ships per order): one row per
// picking order with its ready-to-ship box/cart counts. Registered before the
// /:boxId routes so "by-order" is not swallowed as a box id.
shippingRoute.get("/shipping-orders/by-order", async (c) => {
  return c.json(await listShippingOrderGroups(db), 200);
});

// Ship a fed box: stamps shipped_at/shipped_by, then derives order 'shipped'
// for every fully-boxed order with nothing left in unshipped boxes. 409
// box_not_ready_to_ship when not shippable under the current config.
shippingRoute.post("/shipping-orders/:boxId/ship", async (c) => {
  const result = await shipShippingBox(db, c.req.param("boxId"), actorFrom(c).id);
  return c.json(result, 200);
});

// Box detail: the box + its packages (part identity) + the orders involved.
shippingRoute.get("/shipping-orders/:boxId", async (c) => {
  return c.json(await getShippingOrderDetail(db, c.req.param("boxId")), 200);
});
