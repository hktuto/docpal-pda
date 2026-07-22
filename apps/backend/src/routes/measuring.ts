import { Hono } from "hono";
import { db } from "../db.js";
import { completeMeasuringTask, getMeasuringTaskDetail, listMeasuringTasks } from "../db/measuring.js";
import { actorFrom } from "../auth/middleware.js";

export const measuringRoute = new Hono();

// List with per-task box counts (closed = any status but 'open');
// `?status=` is a pass-through filter.
measuringRoute.get("/measuring-tasks", async (c) => {
  return c.json(await listMeasuringTasks(db, c.req.query("status")), 200);
});

// Consolidated detail: task + order + boxes with packages (part identity
// embedded — no second request).
measuringRoute.get("/measuring-tasks/:id", async (c) => {
  return c.json(await getMeasuringTaskDetail(db, c.req.param("id")), 200);
});

// Complete: pending task + all boxes closed + nothing unboxed → 'completed'
// (+ transition log; no stock movement, picking order status untouched).
measuringRoute.post("/measuring-tasks/:id/complete", async (c) => {
  await completeMeasuringTask(db, { taskId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});
