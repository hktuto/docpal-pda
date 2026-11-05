import { Hono } from "hono";
import { db } from "../db.js";
import { allocateAll } from "../db/allocate.js";

// POST /dev/reset was removed (audit 2026-11-06): dev runs now use a remote
// database with upstream sync, so a tokenless HTTP wipe is pure liability.
// Wipe + reseed stays available locally via the `db:seed` CLI.
export const devRoute = new Hono().post("/dev/allocate", async (c) => {
  const summary = await allocateAll(db);
  return c.json(summary);
});
