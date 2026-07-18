import { Hono } from "hono";
import { db } from "../db.js";
import { listScanTemplates } from "../db/scantemplates.js";

export const scanTemplatesRoute = new Hono();

// Public read: [{supplierCode, qrTemplate, qtyEncoding}] for every supplier
// profile (null templates included — clients filter). Used for client-side
// label validation on picking / put-away / measuring scans.
scanTemplatesRoute.get("/scan-templates", async (c) => {
  return c.json(await listScanTemplates(db), 200);
});
