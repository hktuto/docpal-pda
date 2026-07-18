import { Hono } from "hono";
import type { HealthResponse } from "@warehouse/shared";
import { sql } from "drizzle-orm";
import { db } from "../db.js";

export const healthRoute = new Hono().get("/health", async (c) => {
  let dbStatus: HealthResponse["db"] = "ok";
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    dbStatus = "error";
  }

  const body: HealthResponse = { ok: dbStatus === "ok", db: dbStatus };
  return c.json(body, dbStatus === "ok" ? 200 : 500);
});
