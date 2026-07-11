import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { UpdateShippingBoxRequest, VerifyPackageRequest } from "@warehouse/shared";
import { db } from "../db.js";
import { updateShippingBoxMeasurements, verifyPackage, closeShippingBox, verifyShippingBox } from "../db/measure.js";

export const boxesRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

boxesRoute.patch("/shipping-boxes/:id", async (c) => {
  const boxId = c.req.param("id");
  const body = await readJson<UpdateShippingBoxRequest>(c);
  db.transaction((tx) => updateShippingBoxMeasurements(tx, {
    shippingBoxId: boxId,
    fields: { boxSize: body.box_size, netWeightG: body.net_weight_g, grossWeightG: body.gross_weight_g, destinationCountry: body.destination_country },
  }));
  return c.json({ ok: true }, 200);
});

boxesRoute.post("/shipping-boxes/:id/verify-package", async (c) => {
  const boxId = c.req.param("id");
  const body = await readJson<VerifyPackageRequest>(c);
  if (!body.package_id) throw new HTTPException(400, { message: "package_id is required" });
  db.transaction((tx) => {
    const pkg = tx.get<{ shippingBoxId: string | null }>(sql`SELECT shipping_box_id AS shippingBoxId FROM picking_packages WHERE id = ${body.package_id}`);
    if (!pkg || pkg.shippingBoxId !== boxId) throw new HTTPException(404, { message: "package not found in this box" });
    verifyPackage(tx, { packageId: body.package_id!, actorId: body.actor_id ?? null });
  });
  return c.json({ ok: true }, 200);
});

boxesRoute.post("/shipping-boxes/:id/close", (c) => {
  const boxId = c.req.param("id");
  db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: boxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});

boxesRoute.post("/shipping-boxes/:id/verify", (c) => {
  const boxId = c.req.param("id");
  db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: boxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});

boxesRoute.get("/shipping-boxes/:id/for-measuring", (c) => {
  const boxId = c.req.param("id");
  const box = db.get<Record<string, unknown>>(sql`
    SELECT id, picking_order_id, status, box_size, net_weight_g, gross_weight_g, destination_country, created_at, updated_at
    FROM shipping_boxes WHERE id = ${boxId}`);
  if (!box) throw new HTTPException(404, { message: "shipping box not found" });
  const order = db.get<Record<string, unknown>>(sql`
    SELECT id, ref_no, ship_to, destination_country, status FROM picking_orders WHERE id = ${box.picking_order_id}`);
  const task = db.get<Record<string, unknown>>(sql`
    SELECT id, status FROM measuring_tasks WHERE picking_order_id = ${box.picking_order_id}`) ?? null;
  const packages = db.all<Record<string, unknown>>(sql`
    SELECT pp.id, pp.picking_item_id, p.part_no, pp.qty, pp.date_code, pp.lot_code, pp.coo, pp.cow, pp.verified
    FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id JOIN parts p ON p.id = pi.part_id
    WHERE pp.shipping_box_id = ${boxId} ORDER BY pp.created_at ASC, pp.id ASC`);
  return c.json({ box, order, task, packages }, 200);
});
