import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import { actorFrom, visibilityUsername } from "../auth/middleware.js";
import { completePutBackTask, getPutBackTaskDetail, listPutBackTasks } from "../db/putback.js";

// Thin routes over db/putback.ts — the PDA put-back queue for stock cancelled
// upstream (spec docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md).
// Allocation recompute is never scheduled here (manual-only policy).

async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const putbackRoute = new Hono();

// Put-back task queue, oldest first. ?status= pending|completed filters.
putbackRoute.get("/put-back-tasks", async (c) => {
  return c.json(await listPutBackTasks(db, c.req.query("status"), visibilityUsername(c)), 200);
});

putbackRoute.get("/put-back-tasks/:id", async (c) => {
  return c.json(await getPutBackTaskDetail(db, c.req.param("id"), visibilityUsername(c)), 200);
});

// Credit every pending item back onto a shelf and close the task.
// shelfCode = fallback for dock-sourced items without a source shelf.
putbackRoute.post("/put-back-tasks/:id/complete", async (c) => {
  const body = await readJson<{ shelfCode?: string | null }>(c);
  return c.json(
    await completePutBackTask(db, {
      taskId: c.req.param("id"),
      actorId: actorFrom(c).id,
      username: visibilityUsername(c),
      shelfCode: body.shelfCode ?? null,
    }),
    200
  );
});
