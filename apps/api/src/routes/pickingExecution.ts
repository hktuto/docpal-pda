import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { ScanResponse } from "@warehouse/shared";
import { db } from "../db.js";
import { scanAllocation, removeScannedPackage, createShippingBox, cancelShippingBox } from "../db/pickScan.js";

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
  let actorId: string | null = null;
  try { actorId = (await c.req.json<{ actor_id?: string | null }>()).actor_id ?? null; } catch { /* empty body ok */ }
  const boxId = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: orderId, actorId }));
  return c.json({ id: boxId }, 201);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes/:box_id/cancel", (c) => {
  const boxId = c.req.param("box_id");
  db.transaction((tx) => cancelShippingBox(tx, { shippingBoxId: boxId, actorId: null }));
  return c.json({ ok: true }, 200);
});
