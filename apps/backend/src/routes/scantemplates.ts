import { Hono } from "hono";
import { db } from "../db.js";
import { listScanTemplates } from "../db/scantemplates.js";
import { listDateCodePeriods } from "../db/dateCodePeriods.js";

export const scanTemplatesRoute = new Hono();

// Public read: [{supplierCode, qrTemplate, qtyEncoding}] for every supplier
// profile (null templates included — clients filter). Used for client-side
// label validation on picking / put-away / measuring scans.
scanTemplatesRoute.get("/scan-templates", async (c) => {
  return c.json(await listScanTemplates(db), 200);
});

// Public read: label date-code month-counter periods (date_code_counter_periods).
// Clients (PDA) need these to decode rolling month counters (KOA reel labels)
// identically to the server; the admin CRUD lives at /admin/date-code-periods.
scanTemplatesRoute.get("/date-code-periods", async (c) => {
  return c.json(await listDateCodePeriods(db), 200);
});
