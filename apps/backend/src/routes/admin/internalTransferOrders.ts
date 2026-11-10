import { Hono } from "hono";
import { db } from "../../db.js";
import { listInternalTransferOrders, getInternalTransferOrder, assignTransferPickingOrder } from "../../db/internalTransfer.js";
import {
  allocateForInternalTransferOrder,
  addManualInternalTransferAllocation,
  removeInternalTransferAllocation,
} from "../../db/internalTransferAllocate.js";
import { awaitAllocationTask } from "../../db/allocate.js";
import { actorFrom } from "../../auth/middleware.js";

// Internal transfer orders — admin console view + the stage-1 mutations
// (spec 2026-11-10-internal-transfer-admin-allocate-design.md): per-order
// Re-allocate, delegated picking order assignment, manual allocation
// add/remove. Upstream sync writes the order/item rows; the flow itself is
// stage 2 (PDA picking, finish → put-away task or feed the delegated order).

export const adminInternalTransferRoute = new Hono();

// ?status=pending|allocated|picking|issue|finished  &search=<order no / customer>
// &page=1&pageSize=50 (1-based server paging)
adminInternalTransferRoute.get("/internal-transfer-orders", async (c) => {
  return c.json(
    await listInternalTransferOrders(db, {
      status: c.req.query("status") || undefined,
      search: c.req.query("search") || undefined,
      page: Number(c.req.query("page")) || undefined,
      pageSize: Number(c.req.query("pageSize")) || undefined,
    }),
    200
  );
});

adminInternalTransferRoute.get("/internal-transfer-orders/:id", async (c) => {
  const detail = await getInternalTransferOrder(db, c.req.param("id"));
  return detail ? c.json(detail, 200) : c.json({ error: "internal transfer order not found" }, 404);
});

// "Re-allocate" on the transfer detail — strictly single-order scope, the
// transfer mirror of POST /admin/picking-orders/:id/reallocate. Serialized
// through the allocation runner like every allocation mutation. 404
// transfer_order_not_found / 409 order_not_open / 409 lock_held.
adminInternalTransferRoute.post("/internal-transfer-orders/:id/reallocate", async (c) => {
  const allocation = await awaitAllocationTask(db, "admin re-allocate (internal transfer)", (runnerDb) =>
    allocateForInternalTransferOrder(runnerDb, c.req.param("id"))
  );
  return c.json({ allocation });
});

// Assign or clear the delegated picking order. Body {pickingOrderId: string | null}.
// 404 transfer_order_not_found / picking_order_not_found; 409
// transfer_not_editable / picking_order_not_open / org_mismatch.
adminInternalTransferRoute.put("/internal-transfer-orders/:id/picking-order", async (c) => {
  const body = await c.req.json<{ pickingOrderId?: string | null }>();
  const pickingOrderId =
    body.pickingOrderId === undefined || body.pickingOrderId === null ? null : String(body.pickingOrderId).trim() || null;
  const result = await assignTransferPickingOrder(db, c.req.param("id"), pickingOrderId, actorFrom(c).id);
  return c.json(result);
});

// "Allocate" in the availability modal: pin a manual allocation of `qty`
// against one stock lot or receiving invoice item (any location — the modal
// filters to the from_ pair, the API trusts the admin). Body
// `{qty, inventoryLotId?} | {qty, receivingInvoiceItemId?}`. 400 invalid_qty /
// source_required, 404 *_not_found, 409 lock_held / shelf_not_found /
// insufficient_available / over_allocation. No order-status check; no
// override-steal (remove the other order's allocation by hand instead).
adminInternalTransferRoute.post("/internal-transfer-orders/:id/items/:itemId/allocations", async (c) => {
  const body = await c.req.json<{ qty?: number; inventoryLotId?: string; receivingInvoiceItemId?: string }>();
  const result = await addManualInternalTransferAllocation(
    db,
    c.req.param("id"),
    c.req.param("itemId"),
    {
      qty: Number(body.qty),
      inventoryLotId: body.inventoryLotId,
      receivingInvoiceItemId: body.receivingInvoiceItemId,
    },
    actorFrom(c).id
  );
  return c.json(result);
});

// "Remove allocation" (x) on one allocation row of a transfer item:
// deletes that single row (transient — the next Re-allocate may re-create
// it). 404 transfer_order_not_found / transfer_item_not_found /
// allocation_not_found, 409 lock_held; no order-status check.
adminInternalTransferRoute.delete("/internal-transfer-orders/:id/items/:itemId/allocations/:allocationId", async (c) => {
  const result = await removeInternalTransferAllocation(
    db,
    c.req.param("id"),
    c.req.param("itemId"),
    c.req.param("allocationId"),
    actorFrom(c).id
  );
  return c.json(result);
});
