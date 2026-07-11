import { Hono } from "hono";
import { db } from "../db.js";
import { completeVerificationTask } from "../db/measure.js";

export const verificationRoute = new Hono();

verificationRoute.post("/verification-tasks/:id/complete", (c) => {
  const taskId = c.req.param("id");
  db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: taskId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});
