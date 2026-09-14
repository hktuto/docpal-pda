import { Hono } from "hono";
import { db } from "../../db.js";
import { allocateAll, allocateForPickingOrder } from "../../db/allocate.js";

// Manual allocation triggers for the admin console (spec
// docs/superpowers/specs/2026-09-14-admin-allocation-buttons-design.md).
// Unlike mutation routes (which schedule the recompute in the background),
// these await it in the request — an admin clicked a button and wants the
// result now. allocateAll / allocateForPickingOrder emit the usual
// allocation.computed / allocation.finished SSE events inside their tx, so
// other open pages converge via their change notices.

export const adminAllocationRoute = new Hono();

// "Allocate all" on the picking order list: full-fleet recompute.
adminAllocationRoute.post("/allocation/run", async (c) => {
  const summary = await allocateAll(db);
  return c.json(summary);
});

// "Re-allocate" on the picking order detail: scoped to the order's part
// keys (404 picking_order_not_found / 409 order_not_open / 409 lock_held).
adminAllocationRoute.post("/picking-orders/:id/reallocate", async (c) => {
  const allocation = await allocateForPickingOrder(db, c.req.param("id"));
  return c.json({ allocation });
});
