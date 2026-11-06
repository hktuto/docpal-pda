import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db.js";

export const healthRoute = new Hono()
  .get("/health", async (c) => {
  let dbStatus: "ok" | "error" = "ok";
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    dbStatus = "error";
  }

  return c.json({ ok: dbStatus === "ok", db: dbStatus }, dbStatus === "ok" ? 200 : 500);
})
  // Tiny tokenless endpoint for the admin latency-test page: round trip =
  // client-measured fetch time, the server just echoes its clock.
  .get("/latency-ping", (c) => c.json({ ok: true, serverTime: Date.now() }));
