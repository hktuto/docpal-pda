import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db.js";
import { confirmCancelPutBack, listCancelRecords, setCancelReplacement } from "../../db/cancelInvoice.js";
import { actorFrom } from "../../auth/middleware.js";

// Cancel-invoice ingest log for the admin console (spec
// docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md).
// The cron writes cancel_records; admins read the outcomes and drive the
// confirm gate: a cancel's put-back tasks stay `awaiting` (invisible to the
// PDA) until an admin records the replacement invoice and confirms here.

export const adminCancelRecordsRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

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

// PATCH /admin/cancel-records/:id { replacementOrderNo } — the corrected
// invoice the office raised instead of the cancelled one. Empty clears it.
adminCancelRecordsRoute.patch("/cancel-records/:id", async (c) => {
  const body = await readJson<{ replacementOrderNo?: string | null }>(c);
  const result = await setCancelReplacement(db, {
    recordId: c.req.param("id"),
    replacementOrderNo: body.replacementOrderNo ?? null,
    actorId: actorFrom(c).id,
  });
  return c.json(result, 200);
});

// POST /admin/cancel-records/:id/confirm-putback — release this cancel's
// awaiting put-back tasks to the PDA queue. 409 `no_awaiting_putback_tasks`
// when there is nothing waiting (nothing was picked, or already confirmed).
adminCancelRecordsRoute.post("/cancel-records/:id/confirm-putback", async (c) => {
  const result = await confirmCancelPutBack(db, {
    recordId: c.req.param("id"),
    actorId: actorFrom(c).id,
  });
  return c.json(result, 200);
});
