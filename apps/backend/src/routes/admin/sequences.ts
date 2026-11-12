import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db.js";
import { nextSeqValues } from "../../db/sequences.js";

// Keyed sequence counters (plan docs/superpowers/plans/2026-11-12-seq-counters.md).
// Mounted under /admin (admin-group gate applies).

export const adminSequencesRoute = new Hono();

// POST /admin/sequences/next — {key, count} → {key, start, count}: one
// atomic contiguous block (serials start … start+count−1). 400
// invalid_payload, 404 unknown_seq_key.
adminSequencesRoute.post("/next", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid_payload: JSON body required" });
  }
  return c.json(await nextSeqValues(db, body.key, body.count));
});
