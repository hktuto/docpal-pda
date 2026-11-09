import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { db } from "../../db.js";
import { queryAll, queryGet } from "../../db/query.js";
import { allocateForPickingOrder, allocateForReceivingOrder, addManualPickingAllocation, removePickingAllocation, transferPickingAllocation, awaitAllocationTask } from "../../db/allocate.js";
import { overridePickingOrderStatus } from "../../db/picking.js";
import { actorFrom } from "../../auth/middleware.js";
import { reallocateReceivingItemDemand } from "../../db/receivingReallocate.js";
import { allocatePickingItemFromSources, allocatePickingGroupFromSources, type AllocateFormRow } from "../../db/pickingAllocateForm.js";
import { captureAllocationSnapshot, restoreLatestAllocationSnapshot } from "../../db/allocationSnapshot.js";

// Manual allocation triggers for the admin console (spec
// docs/superpowers/specs/2026-09-14-admin-allocation-buttons-design.md).
// These await the recompute in the request — an admin clicked a button and
// wants the result now. The scoped runs emit the usual allocation.computed /
// allocation.finished SSE events inside their tx, so other open pages converge
// via their change notices. There is no fleet-wide "Allocate all" run any
// more: allocation is manual-only, order by order.

export const adminAllocationRoute = new Hono();

adminAllocationRoute.post("/allocation/snapshot", async (c) => {
  const summary = await captureAllocationSnapshot(db, actorFrom(c).id);
  return c.json(summary);
});

adminAllocationRoute.post("/allocation/restore", async (c) => {
  const summary = await restoreLatestAllocationSnapshot(db, actorFrom(c).id);
  return c.json(summary);
});

// "Re-allocate" on the picking order detail: strictly single-order scope —
// only this order's items are wiped/rebuilt; other orders sharing part
// numbers keep their rows (404 picking_order_not_found / 409 order_not_open /
// 409 lock_held). Spec 2026-11-05-picking-reallocate-single-order-design.md.
adminAllocationRoute.post("/picking-orders/:id/reallocate", async (c) => {
  const httpStartedAt = Date.now();
  const allocation = await awaitAllocationTask(db, "admin re-allocate (picking)", (runnerDb) =>
    allocateForPickingOrder(runnerDb, c.req.param("id"))
  );
  console.log(
    `[alloc-timing] POST /admin/picking-orders/${c.req.param("id")}/reallocate http=${Date.now() - httpStartedAt}ms ` +
      `engine=${allocation.durationMs}ms queueWait≈${Date.now() - httpStartedAt - allocation.durationMs}ms`
  );
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
  const httpStartedAt = Date.now();
  const allocation = await awaitAllocationTask(db, "admin re-allocate (receiving)", (runnerDb) =>
    allocateForReceivingOrder(runnerDb, id)
  );
  console.log(
    `[alloc-timing] POST /admin/receiving-orders/${id}/reallocate http=${Date.now() - httpStartedAt}ms ` +
      `engine=${allocation.durationMs}ms queueWait≈${Date.now() - httpStartedAt - allocation.durationMs}ms`
  );
  return c.json({ allocation });
});

// "Confirm all allocations" on the receiving order detail: every pending
// picking order holding allocations sourced from this receiving order
// (whole-order rows or per invoice item) is flipped to `allocated` — the
// same admin-confirmed lock as the picking detail's per-order "Confirm
// allocation". Attempts every order and reports per-order failures instead
// of failing the request; 404 receiving_order_not_found. No recompute —
// allocated orders leave the demand pool, so their rows survive wipes.
adminAllocationRoute.post("/receiving-orders/:id/confirm-picking-allocations", async (c) => {
  const id = c.req.param("id");
  const head = await queryGet<{ id: string }>(db, sql`SELECT id FROM receiving_orders WHERE id = ${id}`);
  if (!head) throw new HTTPException(404, { message: "receiving_order_not_found" });
  const body = await c.req.json<{ reason?: string }>();
  const orders = await queryAll<{ id: string; orderNo: string }>(
    db,
    sql`
      SELECT DISTINCT po.id, po.order_no AS "orderNo"
      FROM picking_orders po
      JOIN picking_items pi ON pi.picking_order_id = po.id
      JOIN allocations a ON a.picking_item_id = pi.id
      LEFT JOIN receiving_invoice_items rii ON rii.id = a.receiving_invoice_item_id
      LEFT JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE po.status = 'pending'
        AND (a.receiving_order_id = ${id} OR ri.receiving_order_id = ${id})
      ORDER BY po.order_no
    `
  );
  const actorId = actorFrom(c).id;
  const confirmed: string[] = [];
  const failed: { orderNo: string; message: string }[] = [];
  for (const o of orders) {
    try {
      await overridePickingOrderStatus(db, {
        orderId: o.id,
        status: "allocated",
        reason: body.reason ?? null,
        actorId,
      });
      confirmed.push(o.orderNo);
    } catch (e) {
      failed.push({ orderNo: o.orderNo, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return c.json({ confirmed, failed, total: orders.length });
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
  // Serialized through the allocation runner like every other allocation
  // mutation: the tx ends with a fleet-wide picking_orders status refresh
  // that deadlocks against a concurrent recompute's picking_items updates.
  const result = await awaitAllocationTask(db, "admin allocate form (picking item)", (runnerDb) =>
    allocatePickingItemFromSources(
      runnerDb,
      c.req.param("id"),
      c.req.param("itemId"),
      rows,
      actorFrom(c).id
    )
  );
  return c.json(result);
});

// "Confirm" on the availability modal opened from the GROUPED items view
// (spec docs/superpowers/specs/2026-10-14-admin-picking-group-allocate-design.md):
// the same final-state form as allocate-form, but each `qty` is the desired
// final GROUP total from that source for every line sharing `partNo` on this
// order — the backend splits it across the lines (growth fills lines in line
// order up to each line's headroom, shrink releases from the last line
// backwards). Body `{partNo, rows: [{inventoryLotId? | receivingInvoiceItemId?,
// qty, override?}]}`; same validation and error codes as allocate-form, with
// over_allocation / openQty reported as group sums and 404
// picking_item_not_found when no line carries the part.
adminAllocationRoute.post("/picking-orders/:id/allocate-group", async (c) => {
  const body = await c.req.json<{ partNo?: string; rows?: AllocateFormRow[] }>();
  const rows = (body.rows ?? []).map((r) => ({
    inventoryLotId: r.inventoryLotId ?? null,
    receivingInvoiceItemId: r.receivingInvoiceItemId ?? null,
    qty: Number(r.qty),
    override: r.override === true,
  }));
  const result = await awaitAllocationTask(db, "admin allocate form (picking group)", (runnerDb) =>
    allocatePickingGroupFromSources(
      runnerDb,
      c.req.param("id"),
      String(body.partNo ?? ""),
      rows,
      actorFrom(c).id
    )
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

// "Transfer to this order" in the availability modal: move qty from ANOTHER
// order's allocation onto this item as a manual pin (spec
// docs/superpowers/specs/2026-10-14-admin-cross-order-allocation-control-design.md).
// Body `{allocationId, qty?}` — qty defaults to the source row's full qty.
// 404 picking_order_not_found / picking_item_not_found / allocation_not_found,
// 409 same_item / lock_held (either order, holder info included) /
// location_mismatch (source outside the order's org/sub-inventory partition) /
// over_allocation, 400 invalid_qty. No order-status check; no recompute is
// scheduled — the destination pin survives every wipe/rebuild and the source
// item's residual demand is left for the next engine run.
adminAllocationRoute.post("/picking-orders/:id/items/:itemId/allocations/transfer", async (c) => {
  const body = await c.req.json<{ allocationId?: string; qty?: number }>();
  const result = await transferPickingAllocation(
    db,
    c.req.param("id"),
    c.req.param("itemId"),
    { allocationId: String(body.allocationId ?? ""), qty: body.qty === undefined ? undefined : Number(body.qty) },
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
