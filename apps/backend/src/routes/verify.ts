import { Hono } from "hono";
import { db } from "../db.js";
import { completeVerifyTask, getVerifyTaskDetail, listVerifyTasks } from "../db/verify.js";
import { actorFrom } from "../auth/middleware.js";

export const verifyRoute = new Hono();

// List with per-task box counts (closed = any status but 'open');
// `?status=` is a pass-through filter.
verifyRoute.get("/verify-tasks", async (c) => {
  return c.json(await listVerifyTasks(db, c.req.query("status")), 200);
});

// Consolidated detail: task + order + boxes with packages (part identity
// embedded — no second request).
verifyRoute.get("/verify-tasks/:id", async (c) => {
  return c.json(await getVerifyTaskDetail(db, c.req.param("id")), 200);
});

// Complete: pending task + all boxes closed + nothing unboxed → 'completed'
// (+ transition log; no stock movement, picking order status untouched).
verifyRoute.post("/verify-tasks/:id/complete", async (c) => {
  await completeVerifyTask(db, { taskId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});
