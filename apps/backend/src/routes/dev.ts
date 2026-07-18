import { Hono } from "hono";
import { sql, db } from "../db.js";
import { resetAndReseed } from "../db/seed.js";
import { allocateAll } from "../db/allocate.js";

export const devRoute = new Hono()
  .post("/dev/reset", async (c) => {
    await resetAndReseed(sql, db);
    return c.json({ ok: true });
  })
  .post("/dev/allocate", async (c) => {
    const summary = await allocateAll(db);
    return c.json(summary);
  });
