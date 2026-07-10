import { Hono } from "hono";
import type { HealthResponse } from "@warehouse/shared";
import { sqlite } from "../db.js";

export const healthRoute = new Hono().get("/health", (c) => {
  let db: HealthResponse["db"] = "ok";
  try {
    sqlite.prepare("SELECT 1").get();
  } catch {
    db = "error";
  }

  const body: HealthResponse = { ok: db === "ok", db };
  return c.json(body, db === "ok" ? 200 : 500);
});
