import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db.js";
import { listInternalTransferOrders, getInternalTransferOrder, assignTransferPickingOrder } from "../../db/internalTransfer.js";
import {
  allocateForInternalTransferOrder,
  addManualInternalTransferAllocations,
  removeInternalTransferAllocation,
} from "../../db/internalTransferAllocate.js";
import { overrideInternalTransferStatus } from "../../db/internalTransferPicking.js";
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

// Admin status override, deliberately narrow (spec
// 2026-11-10-internal-transfer-pda-picking §lifecycle): `pending` ↔
// `allocated` (Confirm / Unconfirm) with work-lock steal on confirm —
// `finished` is a physical-world fact recorded by the PDA finish, never an
// admin keystroke. Body {status: "pending" | "allocated"}.
adminInternalTransferRoute.patch("/internal-transfer-orders/:id/status", async (c) => {
  const body = await c.req.json<{ status?: string }>();
  if (body.status !== "pending" && body.status !== "allocated") {
    throw new HTTPException(400, { message: "invalid_status" });
  }
  const result = await overrideInternalTransferStatus(db, {
    transferOrderId: c.req.param("id"),
    status: body.status,
    actorId: actorFrom(c).id,
  });
  return c.json(result);
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

// "Allocate" in the availability modal: pin manual allocations against stock
// lots or receiving invoice items (any location — the modal filters to the
// from_ pair, the API trusts the admin). Batch body
// `{allocations: [{qty, inventoryLotId?} | {qty, receivingInvoiceItemId?}, ...]}`
// — applied atomically (one transaction, all-or-nothing), 1..100 entries; the
// legacy single-source body `{qty, inventoryLotId?} | {qty, receivingInvoiceItemId?}`
// is still accepted as a 1-entry batch. 400 allocations_required /
// too_many_allocations / invalid_qty / source_required / duplicate_source,
// 404 *_not_found, 409 lock_held / shelf_not_found / insufficient_available /
// over_allocation — batch failures carry the failing entry's `index` in the
// JSON body. No order-status check; no override-steal (remove the other
// order's allocation by hand instead).
adminInternalTransferRoute.post("/internal-transfer-orders/:id/items/:itemId/allocations", async (c) => {
  const body = await c.req.json<{
    qty?: number;
    inventoryLotId?: string;
    receivingInvoiceItemId?: string;
    allocations?: { qty?: number; inventoryLotId?: string; receivingInvoiceItemId?: string }[];
  }>();
  const raw = Array.isArray(body.allocations) ? body.allocations : null;
  const entries = raw === null
    ? [{ qty: Number(body.qty), inventoryLotId: body.inventoryLotId, receivingInvoiceItemId: body.receivingInvoiceItemId }]
    : raw.map((e) => ({
        qty: Number(e?.qty),
        inventoryLotId: e?.inventoryLotId,
        receivingInvoiceItemId: e?.receivingInvoiceItemId,
      }));
  if (entries.length === 0) {
    throw new HTTPException(400, { message: "allocations_required" });
  }
  if (entries.length > 100) {
    throw new HTTPException(400, { message: "too_many_allocations" });
  }
  const result = await addManualInternalTransferAllocations(
    db,
    c.req.param("id"),
    c.req.param("itemId"),
    entries,
    actorFrom(c).id
  );
  // Legacy callers read the single {allocationId, qty} shape — keep it on top
  // of the batch payload for them.
  return c.json(raw === null ? { ...result.allocations[0], allocations: result.allocations } : result);
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
