import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../../db.js";
import { reqConditions, optInt } from "./crud.js";
import { testLabelPrintRuleMatch } from "../../db/labelPrint.js";

// ---------------------------------------------------------------------------
// Label print rules extras alongside the generic CRUD router (mounted at the
// same /label-print-rules prefix): POST /test-match evaluates draft rule
// conditions against picking_orders for the edit-page match preview (spec
// 2026-09-16-label-print-rules-design).
// ---------------------------------------------------------------------------

export const adminLabelPrintRulesRoute = new Hono();

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

adminLabelPrintRulesRoute.post("/test-match", async (c) => {
  const body = await readJson(c);
  const conditions = reqConditions(body, "conditions");
  const kw = body.keyword;
  if (kw !== undefined && kw !== null && typeof kw !== "string") {
    throw new HTTPException(400, { message: "keyword must be a string" });
  }
  const limit = optInt(body, "limit") ?? undefined;
  const result = await testLabelPrintRuleMatch(
    db,
    conditions,
    typeof kw === "string" ? kw : undefined,
    limit
  );
  return c.json(result);
});
