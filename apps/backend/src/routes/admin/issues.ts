import { Hono } from "hono";
import { db } from "../../db.js";
import { actorFrom } from "../../auth/middleware.js";
import { deleteReceivingInvoiceItem, listReceivingMismatches, listReceivingOrderLogs } from "../../db/receiving.js";
import { listPickingOrderLogs } from "../../db/picking.js";

// Admin issues console: cross-order views over flow-reported issues.
// Confirm/cancel of a listed mismatch reuse the existing flow routes
// (POST /receiving-invoice-items/:id/mismatch/confirm|cancel).

export const adminIssuesRoute = new Hono();

// Open receiving mismatches (reported_mismatch = true) joined to order +
// invoice, newest first.
adminIssuesRoute.get("/receiving-mismatches", async (c) => {
  return c.json(await listReceivingMismatches(db));
});

// Audit trail (transaction_logs) for one receiving order: order rows + its
// invoice-item rows, newest first.
adminIssuesRoute.get("/receiving-orders/:id/logs", async (c) => {
  return c.json(await listReceivingOrderLogs(db, c.req.param("id")));
});

// Audit trail for one picking order: order rows + item/package/shipping-box
// rows, newest first.
adminIssuesRoute.get("/picking-orders/:id/logs", async (c) => {
  return c.json(await listPickingOrderLogs(db, c.req.param("id")));
});

// Remove a wrong/unwanted receiving invoice item (409 item_work_started once
// the line has work). The audit trail survives on the order as 'item_removed'.
adminIssuesRoute.delete("/receiving-invoice-items/:id", async (c) => {
  return c.json(
    await deleteReceivingInvoiceItem(db, { itemId: c.req.param("id"), actorId: actorFrom(c).id }),
    200
  );
});
