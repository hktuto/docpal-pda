import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import {
  completeCnPutAwayTx,
  getCnPutAwayTaskDetail,
  listCnPutAwayTasks,
  type CompleteCnPutAwayItemInput,
} from "../db/putawayCn.js";
import { scheduleAllocateAll } from "../db/allocate.js";
import { actorFrom } from "../auth/middleware.js";
import { cnReceiving } from "../config.js";

// CN put-away routes (spec
// docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md) —
// parallel endpoints to the standard put-away task routes, reading the
// dedicated CN tables. Invisible unless the flow-config cnReceiving flag is
// on (a warehouse runs either the standard or the CN flow): every route 404s
// when the flag is off.

export const putawayCnRoute = new Hono();

// Empty bodies parse as {} (same convention as the standard put-away routes).
async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function assertCnEnabled(): void {
  if (!cnReceiving()) throw new HTTPException(404, { message: "not_found" });
}

// CN task queue (put_away_tasks_cn), oldest first. ?status= filters.
putawayCnRoute.get("/put-away-cn/tasks", async (c) => {
  assertCnEnabled();
  return c.json(await listCnPutAwayTasks(db, c.req.query("status")), 200);
});

// CN task detail: order + expected items (remaining + shelf suggestions) +
// the on-hand lots this order's put-away has created.
putawayCnRoute.get("/put-away-cn/tasks/:id", async (c) => {
  assertCnEnabled();
  return c.json(await getCnPutAwayTaskDetail(db, c.req.param("id")), 200);
});

// Complete CN put-away items in one tx: put_away_qty updates + on-hand lot
// upserts + PUT_AWAY ledger rows; the task completes when every item is fully
// put away. The allocation recompute is scheduled after commit.
putawayCnRoute.post("/put-away-cn/tasks/:id/complete", async (c) => {
  assertCnEnabled();
  const body = await readJson<{ items?: CompleteCnPutAwayItemInput[] }>(c);
  const result = await db.transaction(async (tx) =>
    completeCnPutAwayTx(tx, { taskId: c.req.param("id"), items: body.items ?? [], actorId: actorFrom(c).id })
  );
  scheduleAllocateAll(db, "cn put-away complete");
  return c.json(result, 200);
});
