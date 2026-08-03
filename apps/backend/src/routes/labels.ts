import { Hono } from "hono";
import { db } from "../db.js";
import { getLabelsData } from "../db/labels.js";

export const labelsRoute = new Hono();

// Everything the web /print-labels page renders: shelf box ids, shelf codes,
// receiving cartons, and part labels with supplier-template raw scan values.
// Read-only.
labelsRoute.get("/labels-data", async (c) => {
  return c.json(await getLabelsData(db), 200);
});
