import { Hono } from "hono";
import { resetAndReseed } from "../db/seed.js";
import { db, sqlite } from "../db.js";

export const devRoute = new Hono();

devRoute.post("/dev/reset", (c) => {
  resetAndReseed(sqlite, db);
  return c.json({ ok: true }, 200);
});
