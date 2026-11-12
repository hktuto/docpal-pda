import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db.js";
import { lookupCustItems, type CustItemLookupLine } from "../../db/custItemLookup.js";

// Batch CUST_ITEM_NUMBER + part-description enrichment for the Custom Print
// Label CSV confirm (apps/admin/pages/custom-print-label.vue →
// utils/customLabelCsv.ts convertToPrintData): per CSV line (單號, 物料號) the
// chain runs picking_orders → customer_accounts → mtl_cross_references for the
// cross_reference, plus parts for the description (src/db/custItemLookup.ts).
export const adminCustItemLookupRoute = new Hono();

adminCustItemLookupRoute.post("/cust-item-lookup", async (c) => {
  const text = await c.req.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const lines = (body as { lines?: unknown }).lines;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new HTTPException(400, { message: "invalid_payload: lines must be a non-empty array" });
  }
  if (lines.length > 2000) {
    throw new HTTPException(400, { message: "invalid_payload: lines max 2000 per batch" });
  }
  for (const l of lines) {
    if (
      typeof l !== "object" ||
      l === null ||
      typeof (l as CustItemLookupLine).orderNo !== "string" ||
      typeof (l as CustItemLookupLine).wclItemNo !== "string"
    ) {
      throw new HTTPException(400, { message: "invalid_payload: each line must have string orderNo and wclItemNo" });
    }
  }
  return c.json({ results: await lookupCustItems(db, lines as CustItemLookupLine[]) }, 200);
});
