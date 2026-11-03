import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import { decodeScan } from "../decode/index.js";

async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function optionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new HTTPException(400, { message: `invalid_payload: ${key} must be an array of strings` });
  }
  return value as string[];
}

export const scanDecodeRoute = new Hono();

// Server-side decode of a raw label scan value against the supplier QR
// templates (the decode that needs DB lookups — supplier_profiles +
// date_code_counter_periods + flow-config dateCodeFormat).
// Body: { raw, targets?, supplierCode?, brands? } (targets/supplierCode/brands
// carry the client's order context, same inputs as parseQrCapture).
// Response: the PDA `OcrParseResult` shape minus `raw` (parsed/options/
// supplier). matched=false when no template hits — the client then runs its
// own no-DB OCR heuristics. GET /scan-templates stays untouched until the
// PDA/admin cutover (spec 2026-11-03-backend-scan-decode-design.md).
scanDecodeRoute.post("/scan/decode", async (c) => {
  const body = await readJson<{
    raw?: unknown;
    targets?: unknown;
    supplierCode?: unknown;
    brands?: unknown;
  }>(c);
  if (typeof body.raw !== "string" || !body.raw.trim()) {
    throw new HTTPException(400, { message: "invalid_payload: raw must be a non-empty string" });
  }
  if (body.supplierCode !== undefined && body.supplierCode !== null && typeof body.supplierCode !== "string") {
    throw new HTTPException(400, { message: "invalid_payload: supplierCode must be a string" });
  }
  const result = await decodeScan(db, {
    raw: body.raw,
    targets: optionalStringArray(body.targets, "targets"),
    supplierCode: body.supplierCode as string | undefined,
    brands: optionalStringArray(body.brands, "brands"),
  });
  return c.json(result, 200);
});
