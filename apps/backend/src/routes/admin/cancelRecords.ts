import { Hono } from "hono";
import { db } from "../../db.js";
import { listCancelRecords } from "../../db/cancelInvoice.js";

// Cancel-invoice ingest log for the admin console (spec
// docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md).
// Read-only — the cron writes cancel_records; admins watch outcomes here.

export const adminCancelRecordsRoute = new Hono();

// ?source=cancel_invoice|cancel_invoice_tn  &outcome=cancelled|... filters.
adminCancelRecordsRoute.get("/cancel-records", async (c) => {
  return c.json(
    await listCancelRecords(db, {
      source: c.req.query("source") || undefined,
      outcome: c.req.query("outcome") || undefined,
    }),
    200
  );
});
