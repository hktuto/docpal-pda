import { Hono } from "hono";
import { db } from "../db.js";
import { getLabelsData, searchLabelPrintParts } from "../db/labels.js";

export const labelsRoute = new Hono();

// Everything the web /print-labels page renders: shelf box ids, shelf codes,
// receiving cartons, and part labels with supplier-template raw scan values.
// Read-only.
labelsRoute.get("/labels-data", async (c) => {
  return c.json(await getLabelsData(db), 200);
});

// Parts master search for the PDA /print-product-label dropdowns
// (?search= term, ?brand= narrowing; capped at 50 rows — the full table is
// too big to ship to the PDA).
labelsRoute.get("/parts", async (c) => {
  return c.json(
    {
      parts: await searchLabelPrintParts(db, {
        search: c.req.query("search"),
        brand: c.req.query("brand"),
      }),
    },
    200
  );
});
