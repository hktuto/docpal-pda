import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import {
  generateGoodsVerifyTasks,
  getGoodsVerifyTaskDetail,
  getGoodsVerifyTaskRow,
  listGoodsVerifyTasks,
  verifyGoodsVerifyTask,
} from "../db/goodsverify.js";
import { allocateAll } from "../db/allocate.js";

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

// An ADJUST changes available_qty → recalculate allocations after commit,
// best-effort, never roll back the verify (concept 5).
async function reallocateBestEffort(after: string): Promise<void> {
  try {
    await allocateAll(db);
  } catch (err) {
    console.error(`allocateAll after ${after} failed`, err);
  }
}

export const goodsVerifyRoute = new Hono();

// Day-end generation (concept 7): one pending task per lot moved in
// inventory_transactions that day; idempotent via the (task_date,
// inventory_lot_id) unique index. System job — actorId optional, body may be
// empty (date defaults to the DB server's CURRENT_DATE).
goodsVerifyRoute.post("/goods-verify-tasks/generate", async (c) => {
  let body: { date?: string; actorId?: string } = {};
  const text = await c.req.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new HTTPException(400, { message: "invalid JSON body" });
    }
  }
  return c.json(await generateGoodsVerifyTasks(db, body), 200);
});

// The work queue; ?date= / ?status= / ?shelfCode= pass through.
goodsVerifyRoute.get("/goods-verify-tasks", async (c) => {
  return c.json(
    await listGoodsVerifyTasks(db, {
      date: c.req.query("date"),
      status: c.req.query("status"),
      shelfCode: c.req.query("shelfCode"),
    }),
    200
  );
});

// Task + lot (batch + location fields) + the shelf box with its items.
goodsVerifyRoute.get("/goods-verify-tasks/:id", async (c) => {
  return c.json(await getGoodsVerifyTaskDetail(db, c.req.param("id")), 200);
});

// Verify a pending task: stamps verified_by/at (+ transition log), closes out
// the box when the task has one, and on a count mismatch corrects the lot and
// writes the ADJUST ledger row → best-effort allocateAll after commit.
goodsVerifyRoute.post("/goods-verify-tasks/:id/verify", async (c) => {
  const body = await readJson<{ actorId?: string; countedQty?: number }>(c);
  const actorId = requireActor(body);
  const { adjusted } = await verifyGoodsVerifyTask(db, {
    taskId: c.req.param("id"),
    actorId,
    countedQty: body.countedQty,
  });
  if (adjusted) await reallocateBestEffort("goods-verify adjust");
  return c.json(await getGoodsVerifyTaskRow(db, c.req.param("id")), 200);
});
