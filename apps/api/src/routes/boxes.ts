import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { UpdateShippingBoxRequest } from "@warehouse/shared";
import { db } from "../db.js";
import { updateShippingBoxMeasurements } from "../db/measure.js";

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
