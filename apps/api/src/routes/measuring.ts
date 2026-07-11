import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { completeMeasuringTask } from "../db/measure.js";

export const measuringRoute = new Hono();

measuringRoute.get("/measuring-tasks", (c) => {
  const status = c.req.query("status");
  const since = c.req.query("since");
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT id, picking_order_id, status, created_at, updated_at
    FROM measuring_tasks
    WHERE (${status ?? null} IS NULL OR status = ${status ?? null})
      AND (${since ?? null} IS NULL OR updated_at > ${since ?? null})
    ORDER BY updated_at ASC, id ASC LIMIT 200`);
  return c.json(rows, 200);
});

measuringRoute.post("/measuring-tasks/:id/complete", (c) => {
  const taskId = c.req.param("id");
  db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: taskId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});
