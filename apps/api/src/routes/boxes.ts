import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { UpdateShippingBoxRequest, VerifyPackageRequest } from "@warehouse/shared";
import { db } from "../db.js";
import { updateShippingBoxMeasurements, verifyPackage } from "../db/measure.js";

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
