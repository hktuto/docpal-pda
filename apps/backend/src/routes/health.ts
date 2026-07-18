import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db.js";

export const healthRoute = new Hono().get("/health", async (c) => {
  let dbStatus: "ok" | "error" = "ok";
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    dbStatus = "error";
  }

  return c.json({ ok: dbStatus === "ok", db: dbStatus }, dbStatus === "ok" ? 200 : 500);
});
