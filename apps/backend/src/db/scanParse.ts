// ---------------------------------------------------------------------------
// Server-side scan parsing: supplier QR templates only (plan decision 5).
// Ported from apps/web/utils/parseOcrScan.ts — the `supplier_profiles.qr_template`
// regex (named groups) + `qty_encoding` ('koa_zeros') logic. Camera OCR fallback
// parsing stays client-side; clients send `raw` and/or explicit fields.
//
// Decode output (parseQrRaw / parseScanText) stays in the receiving enclave's
// label format by contract — no conversion inside the parser (spec
// 2026-10-22-datecode-format-config-design.md). Callers canonicalize at the
// in boundaries; the label-printing helpers below take a CANONICAL date code
// and convert it to the label format before KOA raw encoding.
// ---------------------------------------------------------------------------

import { toLabelDateCode, type DateCodeFormat } from "./dateCode.js";

const QTY_ENCODING_KOA_ZEROS = "koa_zeros";
export const DATE_CODE_ENCODING_KOA_MONTH_COUNTER = "koa_month_counter";
export const DATE_CODE_ENCODING_YYWW = "yyww";
export const DATE_CODE_ENCODING_YYWWD = "yywwd";
export const DATE_CODE_ENCODING_NCC_LOT_YMMDD = "ncc_lot_ymmdd";
export const DATE_CODE_ENCODING_YYYYMM_MIDMONTH = "yyyymm_midmonth";
const qrTemplateRegexCache = new Map<string, RegExp | null>();

/** Fields extracted from a raw scan by a supplier QR template. */
export interface ParsedScanFields {
  partNo?: string;
  qty?: number;
  dateCode?: string;
  lotCode?: string;
  coo?: string;
  cow?: string;
  serialNo?: string;
  wclItemNo?: string;
}

/** Decode a KOA qty field: last digit is the trailing-zero count ("253" → 25000). */
export function decodeKoaQty(encoded: string): number | undefined {
  if (!/^\d+$/.test(encoded)) return undefined;
  if (encoded.length < 2) return undefined;
  const zeroCount = Number(encoded.slice(-1));
  const prefix = encoded.slice(0, -1);
  if (!Number.isFinite(zeroCount) || zeroCount < 0) return undefined;
  const result = Number(prefix) * Math.pow(10, zeroCount);
  if (!Number.isFinite(result) || !Number.isInteger(result) || result <= 0) return undefined;
  return result;
}

/** Inverse of decodeKoaQty (for printing labels): 25000 → "253", 1234 → "12340". */
export function encodeKoaQty(qty: number): string | undefined {
  if (!Number.isInteger(qty) || qty <= 0) return undefined;
  let prefix = String(qty);
  let zeroCount = 0;
  while (prefix.endsWith("0") && zeroCount < 9) {
    prefix = prefix.slice(0, -1);
    zeroCount += 1;
  }
  return `${prefix}${zeroCount}`;
}

/** ISO-8601 week number for a Date. */
function getIsoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/** ISO-8601 year for a Date (may differ from calendar year at year boundaries). */
function getIsoYear(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Thursday of this week
  return d.getUTCFullYear();
}

/** A month-counter period row (date_code_counter_periods). A counter value
 *  may belong to several periods (rotation era) — the decoder picks the
 *  latest candidate not in the future relative to the scan date. */
export interface DateCodePeriod {
  encoding: string;
  direction: "forward" | "backward";
  counterFrom: number;
  counterTo: number;
  periodStart: string; // YYYY-MM-DD, always the first of a month
}

/** Built-in fallback periods, kept in sync with the seed rows in
 *  src/db/seed.ts (date_code_counter_periods). Used when no DB rows are at
 *  hand (unit tests, offline parsing); request paths pass the table rows.
 *
 *  KOA's counter rolls 10→99 and restarts at 10 — one row per 90-month cycle.
 *  User-confirmed anchors: 10 = 2025/12 (so 99 = 2033/05); the previous
 *  cycle 10 = 2018/06 … 99 = 2025/11; the one before 10 = 2010/12 … 99 =
 *  2018/05. A counter rotation is handled by inserting the next cycle's row,
 *  never by editing these. */
export const DEFAULT_KOA_PERIODS: DateCodePeriod[] = [
  { encoding: "koa_month_counter", direction: "forward", counterFrom: 10, counterTo: 99, periodStart: "2010-12-01" },
  { encoding: "koa_month_counter", direction: "forward", counterFrom: 10, counterTo: 99, periodStart: "2018-06-01" },
  { encoding: "koa_month_counter", direction: "forward", counterFrom: 10, counterTo: 99, periodStart: "2025-12-01" },
];

/** First-of-month Date `months` away from (year, month0 = 0-based). */
function monthAt(year: number, month0: number, months: number): Date {
  const total = year * 12 + month0 + months;
  return new Date(Math.floor(total / 12), ((total % 12) + 12) % 12, 1);
}

function parsePeriodStart(periodStart: string): { year: number; month0: number } | undefined {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(periodStart);
  if (!m) return undefined;
  return { year: Number(m[1]), month0: Number(m[2]) - 1 };
}

/**
 * Decode a KOA date-code field (template segment 5, e.g. "1625H713",
 * "5420Q156") to the label-format date code (WWYY under the default
 * dateCodeFormat="wwyy"; decode output stays label format by contract — spec
 * 2026-10-22-datecode-format-config-design.md). Take the leading digit run's
 * first 4 digits: the first 2 are a month counter that rolls 10→99 and
 * restarts (90-month cycles, each cycle = one date_code_counter_periods row:
 * 10 = 2025/12 … 99 = 2033/05 today, 10 = 2018/06 … 99 = 2025/11 before);
 * the last 2 are the day of month. The counter appears once per cycle, so a
 * value yields several candidate months — the latest one NOT in the future
 * relative to `referenceDate` (default: today) wins, so a rolled counter
 * resolves to the past label, never a future one ("54" scanned 2026-10 →
 * 2022, not 2029/2036). The raw value stays the lot code.
 */
export function decodeKoaDateCode(
  raw: string,
  periods: DateCodePeriod[] = DEFAULT_KOA_PERIODS,
  referenceDate: Date = new Date(),
  dateCodeFormat: DateCodeFormat = "wwyy"
): string | undefined {
  // An empty table (request paths pass the date_code_counter_periods rows
  // verbatim) means "no rows at hand" — same as omitting the argument.
  if (!periods.length) periods = DEFAULT_KOA_PERIODS;
  const digits = raw.match(/^\d+/)?.[0];
  if (!digits || digits.length < 4) return undefined;
  const counter = Number(digits.slice(0, 2));
  const day = Number(digits.slice(2, 4));
  if (day < 1 || day > 31) return undefined;

  const candidates: Date[] = [];
  for (const p of periods) {
    if (p.encoding !== DATE_CODE_ENCODING_KOA_MONTH_COUNTER) continue;
    const lo = Math.min(p.counterFrom, p.counterTo);
    const hi = Math.max(p.counterFrom, p.counterTo);
    if (counter < lo || counter > hi) continue;
    const start = parsePeriodStart(p.periodStart);
    if (!start) continue;
    const offset = p.direction === "forward" ? counter - p.counterFrom : p.counterFrom - counter;
    candidates.push(monthAt(start.year, start.month0, offset));
  }
  if (candidates.length === 0) return undefined;

  const ref = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
  const pastOrPresent = candidates.filter((d) => d <= ref);
  const picked = pastOrPresent.length
    ? new Date(Math.max(...pastOrPresent.map((d) => d.getTime())))
    : new Date(Math.min(...candidates.map((d) => d.getTime())));
  const daysInMonth = new Date(picked.getFullYear(), picked.getMonth() + 1, 0).getDate();
  if (day > daysInMonth) return undefined;
  const date = new Date(picked.getFullYear(), picked.getMonth(), day);
  const week = getIsoWeek(date);
  const isoYear = getIsoYear(date);
  // Canonical YYWW → label format at this out boundary (spec 2026-10-22).
  const canonical = `${String(isoYear % 100).padStart(2, "0")}${String(week).padStart(2, "0")}`;
  return toLabelDateCode(canonical, dateCodeFormat) ?? undefined;
}

/**
 * Build a raw label value matching the seeded KOA qr_template
 * ("^:(?<itemId>…):(?<subId>…):(?<qty>…):(?<ignore1>…):(?<dateCode>…):(?<serialNo>…):(?<wclItemNo>…)(?::…)*:?$"
 * with koa_zeros qty encoding and koa_month_counter date-code encoding) —
 * used to print scannable demo part labels. Round-trips through parseQrRaw
 * with that template (the tail lands in the `wclItemNo` group). `fullName`
 * defaults to the "KOA+<partNo>" marking style seen on older reels.
 * `dateCode` is a CANONICAL YYWW lot date code; it is converted to the label
 * format (`dateCodeFormat`, default "wwyy") and re-encoded into the KOA raw
 * form (month counter + week) with a mid-year counter so the year round-trips
 * for recent lots. Without it, `lotCode` text (or "-") fills the segment and
 * the parsed label simply yields no dateCode.
 */
export function buildKoaLabelRaw(input: {
  partNo: string;
  qty: number;
  lotCode?: string | null;
  dateCode?: string | null;
  serialNo: string;
  fullName?: string;
  dateCodePeriods?: DateCodePeriod[];
  /** Label/upstream format for the canonical→label conversion; default "wwyy". */
  dateCodeFormat?: DateCodeFormat;
}): string | undefined {
  const qty = encodeKoaQty(input.qty);
  if (!qty) return undefined;
  const fullName = input.fullName ?? `KOA+${input.partNo}`;
  // Canonical YYWW → label format at this out boundary before KOA raw encoding.
  const labelDateCode = toLabelDateCode(input.dateCode, input.dateCodeFormat ?? "wwyy");
  const dateSegment = encodeKoaDateCodeRaw(labelDateCode, input.dateCodePeriods) ?? input.lotCode?.trim() ?? "-";
  // the template's dateCode/serialNo groups require 1+ chars — never emit empties
  return `:${input.partNo}::${qty}:X:${dateSegment || "-"}:${input.serialNo}:${fullName}`;
}

/** Monday of ISO-8601 week `week` of ISO year `year`. */
function getIsoWeekMonday(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7; // Mon=1 … Sun=7
  const mondayOfWeek1 = new Date(jan4);
  mondayOfWeek1.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1);
  const result = new Date(mondayOfWeek1);
  result.setUTCDate(mondayOfWeek1.getUTCDate() + (week - 1) * 7);
  return result;
}

/**
 * Inverse of decodeKoaDateCode for printing labels: a label-format (WWYY)
 * code "0822" → "5420" (Monday of ISO week 8 of 2022 = 2022-02-21; counter 54
 * of the 2018/06 cycle = 2022-02). Callers pass the canonical YYWW code
 * through toLabelDateCode first (buildKoaLabelRaw does). The target month
 * must be covered by one of the period rows; returns undefined when no period
 * represents it (e.g. before 2011/06).
 */
export function encodeKoaDateCodeRaw(
  dateCode: string | null | undefined,
  periods: DateCodePeriod[] = DEFAULT_KOA_PERIODS
): string | undefined {
  if (!dateCode || !/^\d{4}$/.test(dateCode)) return undefined;
  // Empty period row list (date_code_counter_periods) = "no rows at hand",
  // same as omitting the argument — fall back to the built-in defaults.
  if (!periods.length) periods = DEFAULT_KOA_PERIODS;
  const week = Number(dateCode.slice(0, 2));
  const yy = Number(dateCode.slice(2, 4));
  if (week < 1 || week > 53) return undefined;
  const monday = getIsoWeekMonday(2000 + yy, week);
  const calYear = monday.getUTCFullYear();
  const calMonth = monday.getUTCMonth(); // 0-based
  const day = monday.getUTCDate();
  const targetIndex = calYear * 12 + calMonth;
  for (const p of periods) {
    if (p.encoding !== DATE_CODE_ENCODING_KOA_MONTH_COUNTER) continue;
    const start = parsePeriodStart(p.periodStart);
    if (!start) continue;
    const offset = targetIndex - (start.year * 12 + start.month0);
    const span = Math.abs(p.counterTo - p.counterFrom);
    if (offset < 0 || offset > span) continue;
    const counter = p.direction === "forward" ? p.counterFrom + offset : p.counterFrom - offset;
    if (counter < 1 || counter > 99) continue;
    return `${String(counter).padStart(2, "0")}${String(day).padStart(2, "0")}`;
  }
  return undefined;
}

/**
 * Decode a YYWW date-code field (iC-Haus DC, e.g. "2337" = year 2023 week 37)
 * to the label date code (pair-swapped WWYY under the default "wwyy" label
 * format; identity under "yyww"). Returns undefined for non-4-digit input or
 * an invalid week.
 * Keep in sync with apps/pda/utils/parseOcrScan.ts decodeYywwDateCode.
 */
export function decodeYywwDateCode(raw: string, dateCodeFormat: DateCodeFormat = "wwyy"): string | undefined {
  if (!/^\d{4}$/.test(raw)) return undefined;
  const week = Number(raw.slice(2, 4));
  if (week < 1 || week > 53) return undefined;
  return toLabelDateCode(raw, dateCodeFormat) ?? undefined;
}

/**
 * Decode a TE Connectivity 5-digit YYWWD date code (DC field, e.g. "26374" =
 * year 2026 week 37 day 4) to the label date code — the trailing day digit is
 * dropped and the YYWW pair renders in the label format (pair-swapped WWYY
 * under the default "wwyy"; identity under "yyww"). Returns undefined for
 * non-5-digit input or an invalid week.
 * Keep in sync with apps/pda/utils/parseOcrScan.ts decodeYywwdDateCode.
 */
export function decodeYywwdDateCode(raw: string, dateCodeFormat: DateCodeFormat = "wwyy"): string | undefined {
  if (!/^\d{5}$/.test(raw)) return undefined;
  return decodeYywwDateCode(raw.slice(0, 4), dateCodeFormat);
}

/** Format a 13-digit NCC lot as its printed 5–7–2 digit groups. */
export function formatNccLotCode(raw: string): string {
  return /^\d{13}$/.test(raw) ? `${raw.slice(0, 5)}-0${raw.slice(5, 11)}-${raw.slice(11)}` : raw;
}

/**
 * Decode a YYYYMM month date code (ABLIC/SII $-reel labels, e.g. "202606")
 * to the label date code (WWYY under the default "wwyy" label format). The
 * label carries no day — the convention anchors the month on the 15th
 * ("202606" → 2026-06-15 → ISO week 25 → WWYY "2526"). Returns undefined for
 * non-6-digit input or an invalid month.
 * Keep in sync with apps/pda/utils/parseOcrScan.ts decodeYyyymmMidmonthDateCode.
 */
export function decodeYyyymmMidmonthDateCode(raw: string, dateCodeFormat: DateCodeFormat = "wwyy"): string | undefined {
  if (!/^\d{6}$/.test(raw)) return undefined;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  if (month < 1 || month > 12) return undefined;
  const date = new Date(year, month - 1, 15);
  const canonical = `${String(getIsoYear(date) % 100).padStart(2, "0")}${String(getIsoWeek(date)).padStart(2, "0")}`;
  return toLabelDateCode(canonical, dateCodeFormat) ?? undefined;
}

/** Decode the 13-digit NCC lot's YMMDD prefix to an ISO week date code.
 *  The one-digit year resolves to the latest matching year not after the scan
 *  year. Keep in sync with apps/pda/utils/parseOcrScan.ts decodeNccDateCode. */
export function decodeNccDateCode(
  raw: string,
  referenceDate: Date = new Date(),
  dateCodeFormat: DateCodeFormat = "wwyy"
): string | undefined {
  if (!/^\d{13}$/.test(raw)) return undefined;
  const referenceYear = referenceDate.getFullYear();
  let year = Math.floor(referenceYear / 10) * 10 + Number(raw[0]);
  if (year > referenceYear) year -= 10;
  const month = Number(raw.slice(1, 3));
  const day = Number(raw.slice(3, 5));
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  const canonical = `${String(getIsoYear(date) % 100).padStart(2, "0")}${String(getIsoWeek(date)).padStart(2, "0")}`;
  return toLabelDateCode(canonical, dateCodeFormat) ?? undefined;
}

/** Part-number comparison key: uppercase with all whitespace collapsed out.
 *  TE Connectivity: the parts master wraps the bare label PN in "AMP(...)"
 *  (legacy rows "TE-AMP(...)") — unwrap the wrapper so a scanned bare PN
 *  matches, e.g. scanned "640385-8" == stored "AMP(640385-8)". */
export function normalizePartNo(value: string): string {
  const collapsed = value.toUpperCase().replace(/\s+/g, "");
  const wrapped = /^(?:TE-)?AMP\((.+)\)$/.exec(collapsed);
  return wrapped ? wrapped[1] : collapsed;
}

function getQrTemplateRegex(template: string): RegExp | null {
  if (qrTemplateRegexCache.has(template)) {
    return qrTemplateRegexCache.get(template)!;
  }

  try {
    const regex = new RegExp(template, "u");
    qrTemplateRegexCache.set(template, regex);
    return regex;
  } catch (error) {
    console.warn(`Invalid QR code template regex: ${template}`, error);
    qrTemplateRegexCache.set(template, null);
    return null;
  }
}

/** Labels that print only the bare MPN (no WCL item no segment — ABLIC/SII
 *  $-reel QRs) still reach parts.wcl_item_no when the supplier profile covers
 *  exactly one brand: the WCL item no is "<brand>/<mpn>" (ABLIC parts are
 *  stored as "ABLIC/S-812C33AMC-C2NT2U"). Multi-brand or unknown-brand
 *  profiles skip the derivation — the bare partNo stays the only match key.
 *  Keep in sync with apps/pda/utils/parseOcrScan.ts parseQrCapture. */
export function deriveWclItemNo(itemId: string, brands?: string[] | null): string | undefined {
  return brands?.length === 1 ? `${brands[0]}/${itemId}` : undefined;
}

/**
 * Apply a supplier QR template to a raw scan value. The template is a regex
 * with named groups: `itemId` (required), `qty`, `dateCode`, `lotCode`,
 * `coo`, `cow`, `serialNo`, `wclItemNo`. Returns {} when there is no template, the regex
 * is invalid, or the raw value does not match. `qty` is decoded per
 * `qtyEncoding` ('koa_zeros' → decodeKoaQty; otherwise a plain positive
 * integer); `dateCode` is decoded per `dateCodeEncoding`
 * ('koa_month_counter' → decodeKoaDateCode, 'yyww' → decodeYywwDateCode,
 * 'ncc_lot_ymmdd' → decodeNccDateCode; otherwise passed through raw).
 * Templates without a `serialNo` group simply yield no serial
 * (older templates, other suppliers) — unknown groups are ignored.
 * When the template has no `wclItemNo` group, `brands` (the supplier
 * profile's brand list) drives the single-brand derivation — see
 * deriveWclItemNo.
 */
export function parseQrRaw(
  raw: string,
  template: string | null | undefined,
  qtyEncoding: string | null | undefined,
  dateCodeEncoding?: string | null,
  dateCodePeriods?: DateCodePeriod[],
  dateCodeFormat: DateCodeFormat = "wwyy",
  brands?: string[] | null
): ParsedScanFields {
  if (!template) return {};
  const regex = getQrTemplateRegex(template);
  if (!regex) return {};

  const match = regex.exec(raw.trim());
  const groups = match?.groups;
  if (!groups || !groups.itemId) return {};

  let qty: number | undefined;
  if (groups.qty) {
    if (qtyEncoding === QTY_ENCODING_KOA_ZEROS) {
      qty = decodeKoaQty(groups.qty);
    } else {
      const n = Number(groups.qty);
      if (Number.isInteger(n) && n > 0) qty = n;
    }
  }

  // KOA and NCC derive the date from the raw lot. Older templates may still
  // name KOA's segment dateCode — treat that as the lot code too. When both
  // groups exist (iC-Haus: AC = lot, DC = date), the date decodes from the
  // dateCode group. Without an encoding the dateCode group passes through.
  const rawLotCode = (groups.lotCode || groups.dateCode) ?? undefined;
  const rawDateCode = groups.dateCode || undefined;
  let dateCode: string | undefined;
  if (dateCodeEncoding === DATE_CODE_ENCODING_KOA_MONTH_COUNTER) {
    dateCode = rawLotCode ? decodeKoaDateCode(rawLotCode, dateCodePeriods, new Date(), dateCodeFormat) : undefined;
  } else if (dateCodeEncoding === DATE_CODE_ENCODING_YYWW) {
    dateCode = rawDateCode ? decodeYywwDateCode(rawDateCode, dateCodeFormat) : undefined;
  } else if (dateCodeEncoding === DATE_CODE_ENCODING_YYWWD) {
    dateCode = rawDateCode ? decodeYywwdDateCode(rawDateCode, dateCodeFormat) : undefined;
  } else if (dateCodeEncoding === DATE_CODE_ENCODING_NCC_LOT_YMMDD) {
    dateCode = rawLotCode ? decodeNccDateCode(rawLotCode, new Date(), dateCodeFormat) : undefined;
  } else if (dateCodeEncoding === DATE_CODE_ENCODING_YYYYMM_MIDMONTH) {
    dateCode = rawDateCode ? decodeYyyymmMidmonthDateCode(rawDateCode, dateCodeFormat) : undefined;
  } else {
    dateCode = rawDateCode;
  }

  return {
    partNo: normalizePartNo(groups.itemId),
    qty,
    dateCode,
    lotCode: dateCodeEncoding === DATE_CODE_ENCODING_NCC_LOT_YMMDD && rawLotCode
      ? formatNccLotCode(rawLotCode)
      : rawLotCode,
    coo: groups.coo ?? undefined,
    cow: groups.cow ?? undefined,
    serialNo: groups.serialNo ?? undefined,
    wclItemNo: groups.wclItemNo || deriveWclItemNo(groups.itemId, brands),
  };
}
