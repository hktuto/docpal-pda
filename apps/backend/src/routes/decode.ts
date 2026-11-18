import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../db.js";
import { dateCodeFormat } from "../config.js";
import { decodeScan } from "../decode/index.js";
import { getDecodeData } from "../decode/cache.js";
import { formatKoaLotDateCodes, resolveKoaLotDate, encodeKoaLotDate, getIsoWeekMonday } from "../decode/codecs.js";
import { lookupPartDetails } from "../db/partDetails.js";

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
// PUBLIC endpoint (no bearer token) since 2026-11-18 — external systems call
// it to decode supplier labels; see docs/backend/scan-decode-api.md.
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

// Public KOA lot-code → date-code helper (same openness rationale as
// /scan/decode): a KOA reel LOT NO leads with a 2-digit month counter + 2-digit
// day that only resolve to a real date against the date_code_counter_periods
// cycles — external systems should not reimplement that. Body:
// { lotCode, asOf? } — asOf (YYYY-MM-DD) pins the counter-era pick for
// historical lots (the counter rolls 10→99 and restarts every 90 months, so
// the same value recurs per cycle; default reference is today, latest
// not-in-future cycle wins). Response: { yyww, yymmdd, wwyy } — canonical
// YYWW, the exact calendar date YYMMDD, and the label-format code per this
// warehouse's dateCodeFormat. Unresolvable codes return 200 with nulls +
// a reason (mirroring /scan/decode's matched:false philosophy); usage doc
// docs/backend/scan-decode-api.md.
scanDecodeRoute.post("/scan/koa-date-code", async (c) => {
  const body = await readJson<{ lotCode?: unknown; asOf?: unknown }>(c);
  if (typeof body.lotCode !== "string" || !body.lotCode.trim()) {
    throw new HTTPException(400, { message: "invalid_payload: lotCode must be a non-empty string" });
  }
  let asOf: Date | undefined;
  if (body.asOf !== undefined && body.asOf !== null) {
    if (typeof body.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.asOf)) {
      throw new HTTPException(400, { message: "invalid_payload: asOf must be a YYYY-MM-DD date string" });
    }
    asOf = new Date(`${body.asOf}T00:00:00`);
    if (Number.isNaN(asOf.getTime())) {
      throw new HTTPException(400, { message: "invalid_payload: asOf is not a real calendar date" });
    }
  }
  const { periods } = await getDecodeData(db);
  const resolution = resolveKoaLotDate(body.lotCode.trim(), periods, asOf ?? new Date());
  if (!resolution) {
    return c.json({ yyww: null, yymmdd: null, wwyy: null, reason: "unresolvable_lot_code" }, 200);
  }
  return c.json(formatKoaLotDateCodes(resolution, dateCodeFormat()), 200);
});

// Public reverse helper (2026-11-18): date code → KOA lot-code digits, for
// external systems that hold a date code (e.g. from our receiving data) and
// need the counter+day digits printed at the head of a KOA LOT NO. Body:
// exactly one of { yyww, yymmdd, wwyy } — the same fields the forward helper
// /scan/koa-date-code returns, so its response round-trips. The week-based
// inputs encode the Monday of the ISO week (same rule as label printing);
// yymmdd encodes the exact date (20yy always meant literally). Response:
// { lotCodeDigits, counter, day }; a month no seeded cycle covers → 200 with
// nulls + reason. Note lotCodeDigits is the leading digits only — the LOT
// NO's trailing suffix (e.g. "Q156") is not derived from the date.
scanDecodeRoute.post("/scan/koa-lot-code", async (c) => {
  const body = await readJson<{ yyww?: unknown; yymmdd?: unknown; wwyy?: unknown }>(c);
  const provided = (["yyww", "yymmdd", "wwyy"] as const).filter(
    (k) => body[k] !== undefined && body[k] !== null
  );
  if (provided.length !== 1) {
    throw new HTTPException(400, { message: "invalid_payload: exactly one of yyww, yymmdd, wwyy is required" });
  }
  const key = provided[0];
  const value = body[key];
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: `invalid_payload: ${key} must be a string` });
  }
  let date: Date;
  if (key === "yymmdd") {
    if (!/^\d{6}$/.test(value)) {
      throw new HTTPException(400, { message: "invalid_payload: yymmdd must be a 6-digit YYMMDD string" });
    }
    const yy = Number(value.slice(0, 2));
    const mm = Number(value.slice(2, 4));
    const dd = Number(value.slice(4, 6));
    date = new Date(Date.UTC(2000 + yy, mm - 1, dd));
    if (date.getUTCFullYear() !== 2000 + yy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) {
      throw new HTTPException(400, { message: "invalid_payload: yymmdd is not a real calendar date" });
    }
  } else {
    if (!/^\d{4}$/.test(value)) {
      throw new HTTPException(400, { message: `invalid_payload: ${key} must be a 4-digit string` });
    }
    const week = key === "yyww" ? Number(value.slice(2, 4)) : Number(value.slice(0, 2));
    const yy = key === "yyww" ? Number(value.slice(0, 2)) : Number(value.slice(2, 4));
    if (week < 1 || week > 53) {
      throw new HTTPException(400, { message: `invalid_payload: ${key} week must be 01-53` });
    }
    date = getIsoWeekMonday(2000 + yy, week);
  }
  const { periods } = await getDecodeData(db);
  const encoding = encodeKoaLotDate(date, periods);
  if (!encoding) {
    return c.json({ lotCodeDigits: null, counter: null, day: null, reason: "date_outside_counter_periods" }, 200);
  }
  const { lotCodeDigits, counter, day } = encoding;
  return c.json({ lotCodeDigits, counter, day }, 200);
});

// Public parts-master lookup (2026-11-18): an external system holding a
// part_no / wcl_item_no (e.g. from our receiving data) fetches the master
// row(s) — identity, brand, description, MOQ. Body: exactly one of
// { partNo, wclItemNo }. part_no is NOT unique, so a partNo query can return
// several rows (the same part stored under several wcl keys); wcl_item_no is
// the unique business key. The match is exact + normalized (whitespace/case,
// TE "AMP(...)" unwrap — the scan-time canonical rule, idx_parts_norm_*);
// there is deliberately NO substring fallback: a detail API must never return
// sibling parts. Unknown keys → 200 with found:false + reason (same
// philosophy as matched:false). Usage doc: docs/backend/scan-decode-api.md.
scanDecodeRoute.post("/scan/part-details", async (c) => {
  const body = await readJson<{ partNo?: unknown; wclItemNo?: unknown }>(c);
  const provided = (["partNo", "wclItemNo"] as const).filter(
    (k) => body[k] !== undefined && body[k] !== null
  );
  if (provided.length !== 1) {
    throw new HTTPException(400, { message: "invalid_payload: exactly one of partNo, wclItemNo is required" });
  }
  const key = provided[0];
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new HTTPException(400, { message: `invalid_payload: ${key} must be a non-empty string` });
  }
  const rows = await lookupPartDetails(
    db,
    key === "partNo" ? { partNo: value } : { wclItemNo: value }
  );
  if (rows.length === 0) {
    return c.json({ found: false, parts: [], reason: "part_not_found" }, 200);
  }
  return c.json({ found: true, parts: rows }, 200);
});
