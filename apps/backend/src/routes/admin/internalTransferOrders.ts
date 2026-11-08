import { Hono } from "hono";
import { db } from "../../db.js";
import { listInternalTransferOrders, getInternalTransferOrder } from "../../db/internalTransfer.js";

// Internal transfer orders for the admin console — read-only view of the
// upstream-synced internal_transfer_orders / internal_transfer_items tables
// (flow itself per spec 2026-09-28-internal-transfer-order-design.md is not
// built yet).

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
