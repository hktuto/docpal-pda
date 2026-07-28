import { Hono } from "hono";
import { db } from "../db.js";
import { getShippingOrderDetail, listShippingOrders } from "../db/shipping.js";

export const shippingRoute = new Hono();

// Config-aware shipping feed (admin console): completed verify tasks when the
// verify step is on, else completed measuring tasks, else finished picking
// orders with no tasks.
shippingRoute.get("/shipping-orders", async (c) => {
  return c.json(await listShippingOrders(db), 200);
});

// Task-agnostic detail: order + boxes with packages (same shape as the
// measuring/verify detail).
shippingRoute.get("/shipping-orders/:pickingOrderId", async (c) => {
  return c.json(await getShippingOrderDetail(db, c.req.param("pickingOrderId")), 200);
});
