import { Hono } from "hono";
import { db } from "../db.js";
import { completeVerifyTask, getVerifyTaskDetail, listVerifyTasks } from "../db/verify.js";
import { actorFrom } from "../auth/middleware.js";

export const verifyRoute = new Hono();

// Box-keyed list with per-box package/re-scan counts;
// `?status=` is a pass-through filter.
verifyRoute.get("/verify-tasks", async (c) => {
  return c.json(await listVerifyTasks(db, c.req.query("status")), 200);
});

// Consolidated detail: task + its box + the box's packages (part identity
// embedded — no second request).
verifyRoute.get("/verify-tasks/:id", async (c) => {
  return c.json(await getVerifyTaskDetail(db, c.req.param("id")), 200);
});

// Complete: pending task + box closed + every package re-scanned → 'completed'
// (+ transition log; no stock movement).
verifyRoute.post("/verify-tasks/:id/complete", async (c) => {
  await completeVerifyTask(db, { taskId: c.req.param("id"), actorId: actorFrom(c).id });
  return c.json({ ok: true }, 200);
});
