import { Hono } from "hono";
import { db } from "../../db.js";
import { confirmGoodsVerifyTask, rejectGoodsVerifyTask } from "../../db/goodsverify.js";
import { actorFrom } from "../../auth/middleware.js";

// Goods-verify admin actions (spec 2026-11-18-goods-verify-count-mode-design.md):
// in "count" mode the operator blind-counts per line on the PDA and an admin
// compares the counts against LIVE shelf totals here — confirm completes the
// task only when every line matches; reject sends it back to pending with the
// counts cleared. Both no-op with 409 outside count mode. The admin-group
// guard comes from the mounting adminRoute middleware.
export const adminGoodsVerifyRoute = new Hono();

adminGoodsVerifyRoute.post("/goods-verify-tasks/:id/confirm", async (c) => {
  return c.json(
    await confirmGoodsVerifyTask(db, { taskId: c.req.param("id"), actorId: actorFrom(c).id }),
    200
  );
});

adminGoodsVerifyRoute.post("/goods-verify-tasks/:id/reject", async (c) => {
  return c.json(
    await rejectGoodsVerifyTask(db, { taskId: c.req.param("id"), actorId: actorFrom(c).id }),
    200
  );
});
