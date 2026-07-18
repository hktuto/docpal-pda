import { Hono } from "hono";
import { resetAndReseed } from "../db/seed.js";
import { db, sql } from "../db.js";

export const devRoute = new Hono();

devRoute.post("/dev/reset", async (c) => {
  await resetAndReseed(sql, db);
  return c.json({ ok: true }, 200);
});
