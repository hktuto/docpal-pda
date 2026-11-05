import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../../db.js";
import { actorFrom } from "../../auth/middleware.js";
import {
  listTaskAssignments,
  parseTaskAssignmentFlow,
  setTaskAssignee,
} from "../../db/taskAssignments.js";

// Thin routes over db/taskAssignments.ts — admin assignment of PDA task
// queues (spec 2026-11-01-task-assignee-design.md).

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const adminTaskAssignmentsRoute = new Hono();

// Open tasks of one flow for the picker UI (?flow=receiving-cn|picking|
// labeling|put-away|put-away-cn|measuring|verify) — includes every assignee.
adminTaskAssignmentsRoute.get("/task-assignments", async (c) => {
  const flow = parseTaskAssignmentFlow(c.req.query("flow"));
  return c.json(await listTaskAssignments(db, flow), 200);
});

// Set (or clear with null/"") one task's assignee. Body {flow, id, assignee};
// assignee is a username string — deliberately NOT validated against users
// (an assignment may pre-exist the user row, same as user_profiles).
adminTaskAssignmentsRoute.patch("/task-assignment", async (c) => {
  const body = await readJson(c);
  const flow = parseTaskAssignmentFlow(body.flow);
  if (typeof body.id !== "string" || body.id.trim() === "") {
    throw new HTTPException(400, { message: "id must be a non-empty string" });
  }
  const v = body.assignee;
  if (v !== null && v !== undefined && typeof v !== "string") {
    throw new HTTPException(400, { message: "assignee must be a string or null" });
  }
  const assignee = typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  return c.json(
    await setTaskAssignee(db, { flow, id: body.id, assignee, actorId: actorFrom(c).id }),
    200
  );
});
