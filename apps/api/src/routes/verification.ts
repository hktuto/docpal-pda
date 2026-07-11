import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { completeVerificationTask } from "../db/measure.js";

export const verificationRoute = new Hono();

verificationRoute.post("/verification-tasks/:id/complete", (c) => {
  const taskId = c.req.param("id");
  db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: taskId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});

verificationRoute.get("/verification-tasks", (c) => {
  const kind = c.req.query("kind");
  const status = c.req.query("status");
  const since = c.req.query("since");
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT id, kind, status, due_at, picking_order_id, shelf_box_id, created_at, updated_at
    FROM verification_tasks
    WHERE (${kind ?? null} IS NULL OR kind = ${kind ?? null})
      AND (${status ?? null} IS NULL OR status = ${status ?? null})
      AND (${since ?? null} IS NULL OR updated_at > ${since ?? null})
    ORDER BY updated_at ASC, id ASC LIMIT 200`);
  return c.json(rows, 200);
});

verificationRoute.get("/verification-tasks/:id", (c) => {
  const taskId = c.req.param("id");
  const task = db.get<Record<string, unknown>>(sql`
    SELECT id, kind, status, due_at, picking_order_id, shelf_box_id, created_at, updated_at
    FROM verification_tasks WHERE id = ${taskId}`);
  if (!task) throw new HTTPException(404, { message: "verification task not found" });
  const order = task.picking_order_id
    ? db.get<Record<string, unknown>>(sql`
        SELECT id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at
        FROM picking_orders WHERE id = ${task.picking_order_id}`) ?? null
    : null;
  const boxes = task.picking_order_id
    ? db.all<Record<string, unknown>>(sql`
        SELECT id, status, box_size, net_weight_g, gross_weight_g, destination_country, created_at, updated_at
        FROM shipping_boxes WHERE picking_order_id = ${task.picking_order_id} ORDER BY created_at ASC, id ASC`)
    : [];
  for (const b of boxes) {
    b.packages = db.all<Record<string, unknown>>(sql`
      SELECT pp.id, pp.picking_item_id, p.part_no, pp.qty, pp.date_code, pp.lot_code, pp.coo, pp.cow, pp.verified
      FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id JOIN parts p ON p.id = pi.part_id
      WHERE pp.shipping_box_id = ${b.id} ORDER BY pp.created_at ASC, pp.id ASC`);
  }
  return c.json({ task, order, boxes }, 200);
});
