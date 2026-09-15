import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { queryGet } from "../../db/query.js";
import { allocateAll, allocateForPickingOrder, allocateForReceivingOrder, addManualPickingAllocation, removePickingAllocation } from "../../db/allocate.js";
import { actorFrom } from "../../auth/middleware.js";

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

// "Re-allocate" on the receiving order detail: scoped to the order's part
// keys (same core as confirm-arrival). 404 receiving_order_not_found; 409
// order_not_in_hand unless the order has arrived (re-allocation is only
// meaningful once in-hand). allocateForReceivingOrder doesn't throw on
// unknown orders, so existence/status are checked here first.
adminAllocationRoute.post("/receiving-orders/:id/reallocate", async (c) => {
  const id = c.req.param("id");
  const head = await queryGet<{ status: string }>(
    db,
    sql`SELECT status FROM receiving_orders WHERE id = ${id}`
  );
  if (!head) throw new HTTPException(404, { message: "receiving_order_not_found" });
  if (head.status !== "in_hand") throw new HTTPException(409, { message: "order_not_in_hand" });
  const allocation = await allocateForReceivingOrder(db, id);
  return c.json({ allocation });
});

// "Allocate" in the availability modal: pin a manual allocation of `qty`
// against one stock lot or receiving invoice item (any location). Body
// `{qty, inventoryLotId?} | {qty, receivingInvoiceItemId?}`. 400 invalid_qty
// / source_required, 404 *_not_found, 409 lock_held / insufficient_available
// / over_allocation. No order-status check.
adminAllocationRoute.post("/picking-orders/:id/items/:itemId/allocations", async (c) => {
  const body = await c.req.json<{ qty?: number; inventoryLotId?: string; receivingInvoiceItemId?: string }>();
  const result = await addManualPickingAllocation(
    db,
    c.req.param("id"),
    c.req.param("itemId"),
    { qty: Number(body.qty), inventoryLotId: body.inventoryLotId, receivingInvoiceItemId: body.receivingInvoiceItemId },
    actorFrom(c).id
  );
  return c.json(result);
});

// "Remove allocation" (x) on one allocation row of a picking item: deletes
// that single allocation (transient — the next recompute may re-allocate it).
// 404 picking_order_not_found / picking_item_not_found / allocation_not_found,
// 409 lock_held; no order-status check.
adminAllocationRoute.delete("/picking-orders/:id/items/:itemId/allocations/:allocationId", async (c) => {
  const result = await removePickingAllocation(
    db,
    c.req.param("id"),
    c.req.param("itemId"),
    c.req.param("allocationId"),
    actorFrom(c).id
  );
  return c.json(result);
});
