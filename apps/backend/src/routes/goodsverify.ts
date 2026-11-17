import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import {
  generateGoodsVerifyTasks,
  getGoodsVerifyTaskDetail,
  getGoodsVerifyTaskRow,
  listGoodsVerifyTasks,
  saveGoodsVerifyCount,
  verifyGoodsVerifyTask,
} from "../db/goodsverify.js";
import { actorFrom } from "../auth/middleware.js";

// Empty bodies parse as {} — after the auth migration the actor comes from
// the token, not the body.
async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

export const goodsVerifyRoute = new Hono();

// Day-end generation (redesigned): one pending task per shelf with net
// on-hand movement that day; idempotent via the (task_date, shelf_code)
// unique index. System job — body may be empty (date defaults to the DB
// server's CURRENT_DATE).
goodsVerifyRoute.post("/goods-verify-tasks/generate", async (c) => {
  const body = await readJson<{ date?: string }>(c);
  return c.json(await generateGoodsVerifyTasks(db, { date: body.date, actorId: actorFrom(c).id }), 200);
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

// Task with its full movement summary + count-mode lines/progress.
goodsVerifyRoute.get("/goods-verify-tasks/:id", async (c) => {
  return c.json(await getGoodsVerifyTaskDetail(db, c.req.param("id")), 200);
});

// Count mode (spec 2026-11-18-goods-verify-count-mode-design.md): per-line
// blind-count submission — {partNo, qty}, upsert keyed by (task_id, part_no);
// the first saved line flips pending → counted and the admin sees it live.
// Actor from the JWT; 409 when the flow runs in "confirm" mode.
goodsVerifyRoute.post("/goods-verify-tasks/:id/counts", async (c) => {
  const body = await readJson<{ partNo?: string; qty?: unknown }>(c);
  if (typeof body.partNo !== "string" || body.partNo.trim() === "") {
    throw new HTTPException(400, { message: "part_no_required" });
  }
  return c.json(
    await saveGoodsVerifyCount(db, {
      taskId: c.req.param("id"),
      partNo: body.partNo.trim(),
      qty: body.qty,
      actorId: actorFrom(c).id,
    }),
    200
  );
});

// Verify a pending task — pure confirmation. Stamps verified_by/at
// (+ transition log). No countedQty, no adjustment.
goodsVerifyRoute.post("/goods-verify-tasks/:id/verify", async (c) => {
  await verifyGoodsVerifyTask(db, {
    taskId: c.req.param("id"),
    actorId: actorFrom(c).id,
  });
  return c.json(await getGoodsVerifyTaskRow(db, c.req.param("id")), 200);
});
