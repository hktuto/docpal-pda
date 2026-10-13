// ---------------------------------------------------------------------------
// Server-side scan parsing: supplier QR templates only (plan decision 5).
// Ported from apps/web/utils/parseOcrScan.ts — the `supplier_profiles.qr_template`
// regex (named groups) + `qty_encoding` ('koa_zeros') logic. Camera OCR fallback
// parsing stays client-side; clients send `raw` and/or explicit fields.
// ---------------------------------------------------------------------------

const QTY_ENCODING_KOA_ZEROS = "koa_zeros";
export const DATE_CODE_ENCODING_KOA_MONTH_COUNTER = "koa_month_counter";
export const DATE_CODE_ENCODING_YYWW = "yyww";
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

/**
 * Decode a KOA date-code field (template segment 5, e.g. "1625H713",
 * "1723L789", "1114T232") to the system's WWYY date code. Take the leading
 * digit run's first 4 digits: the first 2 are a month counter (1–99) that
 * increments monthly with 17 = 2026-07 (16 = 2026-06, 18 = 2026-08, …);
 * the last 2 are the day of month. Resolve counter → year-month, add the day
 * to get a calendar date, then convert to ISO week. "1625H713" → counter 16
 * (2026-06) + day 25 → 2026-06-25 → ISO week 26 → "2626".
 */
export function decodeKoaDateCode(raw: string): string | undefined {
  const digits = raw.match(/^\d+/)?.[0];
  if (!digits || digits.length < 4) return undefined;
  const counter = Number(digits.slice(0, 2));
  const day = Number(digits.slice(2, 4));
  if (counter < 1 || counter > 99 || day < 1 || day > 31) return undefined;
  const totalMonths = 2026 * 12 + 6 + (counter - 17); // 0-based month index, 2026-07 = counter 17
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths % 12; // 0-based
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  if (day > daysInMonth) return undefined;
  const date = new Date(year, month, day);
  const week = getIsoWeek(date);
  const isoYear = getIsoYear(date);
  return `${String(week).padStart(2, "0")}${String(isoYear % 100).padStart(2, "0")}`;
}

/**
 * Build a raw label value matching the seeded KOA qr_template
 * ("^:(?<itemId>…):(?<subId>…):(?<qty>…):(?<ignore1>…):(?<dateCode>…):(?<serialNo>…):(?<wclItemNo>…)(?::…)*:?$"
 * with koa_zeros qty encoding and koa_month_counter date-code encoding) —
 * used to print scannable demo part labels. Round-trips through parseQrRaw
 * with that template (the tail lands in the `wclItemNo` group). `fullName`
 * defaults to the "KOA+<partNo>" marking style seen on older reels.
 * `dateCode` is a WWYY lot date code; it is re-encoded into the KOA raw
 * form (month counter + week) with a mid-year counter so the year
 * round-trips for recent lots. Without it, `lotCode` text (or "-") fills
 * the segment and the parsed label simply yields no dateCode.
 */
export function buildKoaLabelRaw(input: {
  partNo: string;
  qty: number;
  lotCode?: string | null;
  dateCode?: string | null;
  serialNo: string;
  fullName?: string;
}): string | undefined {
  const qty = encodeKoaQty(input.qty);
  if (!qty) return undefined;
  const fullName = input.fullName ?? `KOA+${input.partNo}`;
  const dateSegment = encodeKoaDateCodeRaw(input.dateCode) ?? input.lotCode?.trim() ?? "-";
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
 * Inverse of decodeKoaDateCode for printing labels: WWYY "2626" → "1622"
 * (Monday of ISO week 26 = 2026-06-22; counter 16 = 2026-06, day 22).
 * Returns undefined for non-WWYY input or years the counter range can't
 * represent (counter clamps to 1–99 ≈ 2025-03 … 2033-05).
 */
export function encodeKoaDateCodeRaw(dateCode: string | null | undefined): string | undefined {
  if (!dateCode || !/^\d{4}$/.test(dateCode)) return undefined;
  const week = Number(dateCode.slice(0, 2));
  const yy = Number(dateCode.slice(2, 4));
  if (week < 1 || week > 53) return undefined;
  const year = 2000 + yy;
  const monday = getIsoWeekMonday(year, week);
  const calYear = monday.getUTCFullYear();
  const calMonth = monday.getUTCMonth(); // 0-based
  const day = monday.getUTCDate();
  const totalMonths = calYear * 12 + calMonth;
  const counter = 17 + totalMonths - (2026 * 12 + 6);
  if (counter < 1 || counter > 99) return undefined;
  return `${String(counter).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

/**
 * Decode a YYWW date-code field (iC-Haus DC, e.g. "2337" = year 2023 week 37)
 * to the system's WWYY date code by swapping the digit pairs ("2337" →
 * "3723"). Returns undefined for non-4-digit input or an invalid week.
 * Keep in sync with apps/pda/utils/parseOcrScan.ts decodeYywwDateCode.
 */
export function decodeYywwDateCode(raw: string): string | undefined {
  if (!/^\d{4}$/.test(raw)) return undefined;
  const week = Number(raw.slice(2, 4));
  if (week < 1 || week > 53) return undefined;
  return `${raw.slice(2, 4)}${raw.slice(0, 2)}`;
}

/** Part-number comparison key: uppercase with all whitespace collapsed out. */
export function normalizePartNo(value: string): string {
  return value.toUpperCase().replace(/\s+/g, "");
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

/**
 * Apply a supplier QR template to a raw scan value. The template is a regex
 * with named groups: `itemId` (required), `qty`, `dateCode`, `lotCode`,
 * `coo`, `cow`, `serialNo`, `wclItemNo`. Returns {} when there is no template, the regex
 * is invalid, or the raw value does not match. `qty` is decoded per
 * `qtyEncoding` ('koa_zeros' → decodeKoaQty; otherwise a plain positive
 * integer); `dateCode` is decoded per `dateCodeEncoding`
 * ('koa_month_counter' → decodeKoaDateCode, 'yyww' → decodeYywwDateCode;
 * otherwise passed through raw).
 * Templates without a `serialNo` group simply yield no serial
 * (older templates, other suppliers) — unknown groups are ignored.
 */
export function parseQrRaw(
  raw: string,
  template: string | null | undefined,
  qtyEncoding: string | null | undefined,
  dateCodeEncoding?: string | null
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

  // KOA: segment 5 is the raw lot code (e.g. "1625H713"); the WWYY date code
  // is derived from it via koa_month_counter. Older templates may still name
  // the same segment dateCode — treat that as the lot code too.
  // Empty segment (::) yields "" — normalize to undefined.
  const rawLotCode = (groups.lotCode || groups.dateCode) ?? undefined;
  let dateCode: string | undefined = undefined;
  if (rawLotCode && dateCodeEncoding === DATE_CODE_ENCODING_KOA_MONTH_COUNTER) {
    dateCode = decodeKoaDateCode(rawLotCode);
  } else if (rawLotCode && dateCodeEncoding === DATE_CODE_ENCODING_YYWW) {
    dateCode = decodeYywwDateCode(rawLotCode);
  }

  return {
    partNo: normalizePartNo(groups.itemId),
    qty,
    dateCode,
    lotCode: rawLotCode,
    coo: groups.coo ?? undefined,
    cow: groups.cow ?? undefined,
    serialNo: groups.serialNo ?? undefined,
    wclItemNo: groups.wclItemNo ?? undefined,
  };
}
