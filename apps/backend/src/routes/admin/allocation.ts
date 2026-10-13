import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { queryGet } from "../../db/query.js";
import { allocateAll, allocateForPickingOrder, allocateForReceivingOrder, addManualPickingAllocation, removePickingAllocation } from "../../db/allocate.js";
import { actorFrom } from "../../auth/middleware.js";
import { reallocateReceivingItemDemand } from "../../db/receivingReallocate.js";
import { allocatePickingItemFromSources, type AllocateFormRow } from "../../db/pickingAllocateForm.js";

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
// `{qty, inventoryLotId?, override?} | {qty, receivingInvoiceItemId?, override?}`.
// 400 invalid_qty / source_required, 404 *_not_found, 409 lock_held /
// shelf_not_found (the lot's shelf_code is missing from `shelves`) /
// insufficient_available / over_allocation. No order-status check. With
// `override: true` the shortfall above the source's availability is reclaimed
// from other orders' non-manual allocations on that source.
adminAllocationRoute.post("/picking-orders/:id/items/:itemId/allocations", async (c) => {
  const body = await c.req.json<{ qty?: number; inventoryLotId?: string; receivingInvoiceItemId?: string; override?: boolean }>();
  const result = await addManualPickingAllocation(
    db,
    c.req.param("id"),
    c.req.param("itemId"),
    {
      qty: Number(body.qty),
      inventoryLotId: body.inventoryLotId,
      receivingInvoiceItemId: body.receivingInvoiceItemId,
      override: body.override === true,
    },
    actorFrom(c).id
  );
  return c.json(result);
});

// "Confirm" on the availability modal: apply EVERY row of the picking-item
// allocate form in one all-or-nothing transaction. Body
// `{rows: [{inventoryLotId? | receivingInvoiceItemId?, qty, override?}]}`
// where each `qty` is the DESIRED FINAL total from that source (0 releases
// it); sources absent from the body keep their current value (the dialog
// filters rows by date code and location match, so an invisible source must
// never be released). 400 invalid_qty / source_required / duplicate_source,
// 404 *_not_found, 409 lock_held / over_allocation / allocate_rejected
// (per-row `key` = `l:<lotId>` | `r:<receivingItemId>`, reasons:
// insufficient_available, shelf_not_found — a lot whose shelf_code is missing
// from `shelves` cannot take new pins). `override: true` on a row reclaims
// the shortfall above the source's availability from other orders'
// non-manual allocations.
adminAllocationRoute.post("/picking-orders/:id/items/:itemId/allocate-form", async (c) => {
  const body = await c.req.json<{ rows?: AllocateFormRow[] }>();
  const rows = (body.rows ?? []).map((r) => ({
    inventoryLotId: r.inventoryLotId ?? null,
    receivingInvoiceItemId: r.receivingInvoiceItemId ?? null,
    qty: Number(r.qty),
    override: r.override === true,
  }));
  const result = await allocatePickingItemFromSources(
    db,
    c.req.param("id"),
    c.req.param("itemId"),
    rows,
    actorFrom(c).id
  );
  return c.json(result);
});

// "Re-allocate this item" form in the receiving-detail search dialog:
// redistribute the receiving item's dock stock across open picking demand in
// one all-or-nothing transaction. Body `{rows: [{pickingItemId, qty}]}` where
// each `qty` is the DESIRED FINAL total from this receiving item (0 releases
// the row); rows absent from the body keep their current value.
// 400 invalid_qty / duplicate_picking_item, 404 receiving_invoice_item_not_found,
// 409 reallocate_rejected (per-row reasons: order_not_open / lock_held /
// over_allocation / picking_item_not_found) / insufficient_available.
adminAllocationRoute.post("/receiving-orders/:id/items/:itemId/reallocate-demand", async (c) => {
  const body = await c.req.json<{ rows?: { pickingItemId?: string; qty?: number }[] }>();
  const rows = (body.rows ?? []).map((r) => ({
    pickingItemId: String(r.pickingItemId ?? ""),
    qty: Number(r.qty),
  }));
  const result = await reallocateReceivingItemDemand(
    db,
    c.req.param("id"),
    c.req.param("itemId"),
    rows,
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
