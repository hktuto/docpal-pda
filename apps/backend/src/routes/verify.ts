import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.js";
import {
  completeVerifyTask,
  getVerifyTaskDetail,
  listVerifyTasks,
  lookupVerifyTaskByLabel,
  scanVerifyTaskLabel,
} from "../db/verify.js";
import { actorFrom } from "../auth/middleware.js";

export const verifyRoute = new Hono();

// Box-keyed list with per-box package/re-scan counts;
// `?status=` is a pass-through filter.
verifyRoute.get("/verify-tasks", async (c) => {
  return c.json(await listVerifyTasks(db, c.req.query("status")), 200);
});

// Box resolution by carton label: the raw scan matches a recorded carton
// print row for a pending/open box → {taskId, shippingBoxId} (stamps the
// box's carton_label_verified). 404 label_print_not_found on no match.
verifyRoute.get("/verify-tasks/lookup-by-label", async (c) => {
  const raw = c.req.query("raw")?.trim();
  if (!raw) throw new HTTPException(400, { message: "raw_required" });
  return c.json(await lookupVerifyTaskByLabel(db, { raw, actorId: actorFrom(c).id }), 200);
});

// Label-mode label scan within the task's box: carton print rows match first
// (stamps carton_label_verified), then item/item_box print rows (marks the
// package label_verified, returns its expectations). 404 label_print_not_found.
verifyRoute.post("/verify-tasks/:id/scan-label", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { raw?: string };
  const raw = body.raw?.trim();
  if (!raw) throw new HTTPException(400, { message: "raw_required" });
  return c.json(await scanVerifyTaskLabel(db, { taskId: c.req.param("id"), raw, actorId: actorFrom(c).id }), 200);
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
