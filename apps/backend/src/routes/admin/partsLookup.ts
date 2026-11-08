import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db.js";
import { lookupPartKeys } from "../../db/partsLookup.js";

// Batch parts-master existence/brand check for the CN excel upload — the
// verify table mounts one part-no combobox per item row (1xx+ rows) and the
// per-row GET /admin/parts sweep stalled the submit; the client batches all
// distinct keys into this one call and caches the answers
// (apps/admin/composables/usePartsBrandCheck.ts).
export const adminPartsLookupRoute = new Hono();

adminPartsLookupRoute.post("/parts-lookup", async (c) => {
  const text = await c.req.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const keys = (body as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new HTTPException(400, { message: "invalid_payload: keys must be a non-empty array" });
  }
  if (keys.length > 2000) {
    throw new HTTPException(400, { message: "invalid_payload: keys max 2000 per batch" });
  }
  for (const k of keys) {
    if (typeof k !== "string") throw new HTTPException(400, { message: "invalid_payload: keys must be strings" });
  }
  return c.json({ matches: await lookupPartKeys(db, keys as string[]) }, 200);
});
