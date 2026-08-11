import { Hono } from "hono";
import { db } from "../db.js";
import { getMeasuringBoxDetail, listMeasuringBoxes } from "../db/measuring.js";

export const measuringRoute = new Hono();

// Measuring work list (box-scoped): open boxes that contain packages.
measuringRoute.get("/measuring-boxes", async (c) => {
  return c.json(await listMeasuringBoxes(db), 200);
});

// Box detail: box fields + packages (part identity) + suggestedNetWeightKg.
measuringRoute.get("/measuring-boxes/:id", async (c) => {
  return c.json(await getMeasuringBoxDetail(db, c.req.param("id")), 200);
});
