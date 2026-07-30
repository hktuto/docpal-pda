import { Hono } from "hono";
import { db } from "../db.js";
import { getShippingOrderDetail, listShippingOrders, shipOrder } from "../db/shipping.js";
import { actorFrom } from "../auth/middleware.js";

export const shippingRoute = new Hono();

// Config-aware shipping feed (admin console): completed verify tasks when the
// verify step is on, else completed measuring tasks, else finished picking
// orders with no tasks.
shippingRoute.get("/shipping-orders", async (c) => {
  return c.json(await listShippingOrders(db), 200);
});

// Ship a fed order: status → 'shipped' (leaves the feed). 409
// order_not_ready_to_ship when not shippable under the current config.
shippingRoute.post("/shipping-orders/:pickingOrderId/ship", async (c) => {
  const result = await shipOrder(db, c.req.param("pickingOrderId"), actorFrom(c).id);
  return c.json(result, 200);
});

// Task-agnostic detail: order + boxes with packages (same shape as the
// measuring/verify detail).
shippingRoute.get("/shipping-orders/:pickingOrderId", async (c) => {
  return c.json(await getShippingOrderDetail(db, c.req.param("pickingOrderId")), 200);
});
