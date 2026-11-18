// Auto labeling machine endpoints (spec 2026-11-12). Authenticated with the
// fixed MACHINE_API_TOKEN bearer (accepted by the global auth middleware for
// /auto-labeling paths) — no user JWT, no actor. The machine's physical
// button triggers fetch; its completion report PATCHes the job status.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import { fetchAutoLabelingJob, reportAutoLabelingJob } from "../db/autoLabeling.js";

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid_json" });
  }
}

export const autoLabelingRoute = new Hono()
  // The machine's physical button: claim the newest pending job (or re-claim a
  // specific jobId it already knows, for retries). Optional machineId filter.
  .post("/auto-labeling/jobs/fetch", async (c) => {
    const body = await readJson<{ machineId?: string; jobId?: string }>(c);
    const result = await fetchAutoLabelingJob(db, {
      machineId: body.machineId?.trim() || undefined,
      jobId: body.jobId?.trim() || undefined,
    });
    return c.json(result, 200);
  })
  // Completion report: printing → completed | failed (with an optional note).
  .patch("/auto-labeling/jobs/:id", async (c) => {
    const body = await readJson<{ status?: string; note?: string }>(c);
    if (!body.status) throw new HTTPException(400, { message: "status_required" });
    const result = await reportAutoLabelingJob(db, {
      id: c.req.param("id"),
      status: body.status,
      note: body.note?.trim() || undefined,
    });
    return c.json(result, 200);
  });
