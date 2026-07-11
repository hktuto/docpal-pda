import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { ScanResponse } from "@warehouse/shared";
import { db } from "../db.js";
import {
  scanAllocation,
  removeScannedPackage,
  createShippingBox,
  cancelShippingBox,
  addPackageToBox,
  addAllUnboxedToBox,
  removePackageFromBox,
} from "../db/pickScan.js";

export const pickingExecutionRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

pickingExecutionRoute.post("/picking-orders/:id/scan", async (c) => {
  const orderId = c.req.param("id");
  const body = await readJson<{ allocation_id?: string; qty?: number; actor_id?: string | null }>(c);
  if (!body.allocation_id) throw new HTTPException(400, { message: "allocation_id is required" });
  const result = db.transaction((tx) => {
    const order = tx.get<{ id: string }>(sql`SELECT id FROM picking_orders WHERE id = ${orderId}`);
    if (!order) throw new HTTPException(404, { message: "picking order not found" });
    const owner = tx.get<{ ok: number }>(sql`
      SELECT 1 AS ok FROM allocations a
      JOIN picking_items pi ON pi.id = a.picking_item_id
      WHERE a.id = ${body.allocation_id} AND pi.picking_order_id = ${orderId}`);
    if (!owner) throw new HTTPException(404, { message: "allocation not found in this order" });
    return scanAllocation(tx, { allocationId: body.allocation_id!, qty: body.qty as number, actorId: body.actor_id ?? null });
  });
  const res: ScanResponse = { package_ids: result.packageIds };
  return c.json(res, 201);
});

pickingExecutionRoute.delete("/picking-orders/:id/packages/:package_id", async (c) => {
  const orderId = c.req.param("id");
  const packageId = c.req.param("package_id");
  const actorId = c.req.query("actor_id") ?? null;
  db.transaction((tx) => {
    const pkg = tx.get<{ pickingOrderId: string }>(sql`
      SELECT pi.picking_order_id AS pickingOrderId FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${packageId}`);
    if (!pkg || pkg.pickingOrderId !== orderId) throw new HTTPException(404, { message: "package not found in this order" });
    removeScannedPackage(tx, { packageId, actorId });
  });
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes", async (c) => {
  const orderId = c.req.param("id");
  const raw = await c.req.text();
  let actorId: string | null = null;
  if (raw.trim() !== "") {
    let body: { actor_id?: string | null };
    try { body = JSON.parse(raw); } catch { throw new HTTPException(400, { message: "invalid JSON body" }); }
    actorId = body.actor_id ?? null;
  }
  const boxId = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: orderId, actorId }));
  return c.json({ id: boxId }, 201);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes/:box_id/cancel", (c) => {
  const orderId = c.req.param("id");
  const boxId = c.req.param("box_id");
  const actorId = c.req.query("actor_id") ?? null;
  db.transaction((tx) => {
    const box = tx.get<{ pickingOrderId: string }>(sql`SELECT picking_order_id AS pickingOrderId FROM shipping_boxes WHERE id = ${boxId}`);
    if (!box || box.pickingOrderId !== orderId) throw new HTTPException(404, { message: "box not found in this order" });
    cancelShippingBox(tx, { shippingBoxId: boxId, actorId });
  });
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes/:box_id/packages", async (c) => {
  const boxId = c.req.param("box_id");
  const body = await readJson<{ package_id?: string; actor_id?: string | null }>(c);
  if (!body.package_id) throw new HTTPException(400, { message: "package_id is required" });
  db.transaction((tx) => addPackageToBox(tx, { packageId: body.package_id!, shippingBoxId: boxId, actorId: body.actor_id ?? null }));
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes/:box_id/add-all-unboxed", (c) => {
  const boxId = c.req.param("box_id");
  const n = db.transaction((tx) => addAllUnboxedToBox(tx, { shippingBoxId: boxId, actorId: null }));
  return c.json({ packed: n }, 200);
});

pickingExecutionRoute.delete("/picking-orders/:id/boxes/:box_id/packages/:package_id", (c) => {
  const packageId = c.req.param("package_id");
  db.transaction((tx) => removePackageFromBox(tx, { packageId, actorId: null }));
  return c.json({ ok: true }, 200);
});
