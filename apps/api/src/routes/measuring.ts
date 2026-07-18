import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { queryAll, queryGet } from "../db/query.js";
import { completeMeasuringTask } from "../db/measure.js";

export const measuringRoute = new Hono();

measuringRoute.get("/measuring-tasks", async (c) => {
  const status = c.req.query("status");
  const since = c.req.query("since");
  const rows = await queryAll<Record<string, unknown>>(db, sql`
    SELECT mt.id, mt.picking_order_id, mt.status, mt.created_at, mt.updated_at, po.ref_no,
      s.name AS supplier_name,
      (SELECT COALESCE(SUM(qty)::int, 0) FROM picking_items WHERE picking_order_id = mt.picking_order_id) AS total_items,
      (SELECT COALESCE(SUM(pp.qty)::int, 0) FROM picking_packages pp
        WHERE pp.shipping_box_id IS NOT NULL
          AND pp.picking_item_id IN (SELECT id FROM picking_items WHERE picking_order_id = mt.picking_order_id)) AS packed_items
    FROM measuring_tasks mt JOIN picking_orders po ON po.id = mt.picking_order_id
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE (${status ?? null}::text IS NULL OR mt.status = ${status ?? null}::text)
      AND (${since ?? null}::text IS NULL OR mt.updated_at > ${since ?? null}::text)
    ORDER BY mt.updated_at ASC, mt.id ASC LIMIT 200`);
  return c.json(rows, 200);
});

measuringRoute.get("/measuring-tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  const task = await queryGet<Record<string, unknown>>(db, sql`
    SELECT id, picking_order_id, status, created_at, updated_at FROM measuring_tasks WHERE id = ${taskId}`);
  if (!task) throw new HTTPException(404, { message: "measuring task not found" });
  const orderId = task.picking_order_id as string;
  const order = await queryGet<Record<string, unknown>>(db, sql`
    SELECT po.id, po.external_id, po.ref_no, po.status, po.ship_to, po.destination_country,
           po.delivery_date, po.po_no, po.required_date_code_notice, po.created_at, po.updated_at,
           s.id AS supplier_id, s.code AS supplier_code, s.name AS supplier_name,
           s.qr_template AS supplier_qr_template, s.qrcode_qty_encoding AS supplier_qrcode_qty_encoding
    FROM picking_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.id = ${orderId}`);
  const items = await queryAll<Record<string, unknown>>(db, sql`
    SELECT pi.id, pi.part_id, p.part_no, pi.qty, pi.picked_qty, pi.scanned_not_boxed_qty,
           pi.remaining_qty, pi.allocated_qty, pi.line_id
    FROM picking_items pi JOIN parts p ON p.id = pi.part_id
    WHERE pi.picking_order_id = ${orderId} ORDER BY pi.created_at ASC, pi.id ASC`);
  const boxes = await queryAll<Record<string, unknown>>(db, sql`
    SELECT id, status, box_size, net_weight_g, gross_weight_g, destination_country, created_at, updated_at
    FROM shipping_boxes WHERE picking_order_id = ${orderId} ORDER BY created_at ASC, id ASC`);
  for (const b of boxes) {
    b.packages = await queryAll<Record<string, unknown>>(db, sql`
      SELECT pp.id, pp.picking_item_id, p.part_no, pp.source_type, pp.source_id, pp.qty,
             pp.date_code, pp.lot_code, pp.coo, pp.cow, pp.verified
      FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id JOIN parts p ON p.id = pi.part_id
      WHERE pp.shipping_box_id = ${b.id} ORDER BY pp.created_at ASC, pp.id ASC`);
  }
  return c.json({ task, order, items, boxes }, 200);
});

measuringRoute.post("/measuring-tasks/:id/complete", async (c) => {
  const taskId = c.req.param("id");
  await db.transaction(async (tx) => {
    await completeMeasuringTask(tx, { measuringTaskId: taskId, actorId: c.req.query("actor_id") ?? null });
  });
  return c.json({ ok: true }, 200);
});
