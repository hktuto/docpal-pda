import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import { completeMeasuringTask, getMeasuringTaskDetail, listMeasuringTasks } from "../db/measuring.js";

async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function requireActor(body: { actorId?: string }): string {
  if (!body.actorId) throw new HTTPException(400, { message: "actorId is required" });
  return body.actorId;
}

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
  const body = await readJson<{ actorId?: string }>(c);
  const actorId = requireActor(body);
  await completeMeasuringTask(db, { taskId: c.req.param("id"), actorId });
  return c.json({ ok: true }, 200);
});
