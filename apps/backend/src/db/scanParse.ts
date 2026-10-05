// ---------------------------------------------------------------------------
// Server-side scan parsing: supplier QR templates only (plan decision 5).
// Ported from apps/web/utils/parseOcrScan.ts — the `supplier_profiles.qr_template`
// regex (named groups) + `qty_encoding` ('koa_zeros') logic. Camera OCR fallback
// parsing stays client-side; clients send `raw` and/or explicit fields.
// ---------------------------------------------------------------------------

const QTY_ENCODING_KOA_ZEROS = "koa_zeros";
export const DATE_CODE_ENCODING_KOA_MONTH_COUNTER = "koa_month_counter";
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

/**
 * Decode a KOA date-code field (template segment 5, e.g. "1723L789",
 * "1114T232", "19077387") to the system's WWYY date code. Take the leading
 * digit run's first 4 digits: the last 2 are the week, the first 2 are a
 * month counter (1–99) that increments monthly with 17 = 2026-07
 * (16 = 2026-06, 18 = 2026-08, …); the counter's month resolves the year.
 * "1723L789" → week 23, counter 17 → 2026 → "2326".
 */
export function decodeKoaDateCode(raw: string): string | undefined {
  const digits = raw.match(/^\d+/)?.[0];
  if (!digits || digits.length < 4) return undefined;
  const counter = Number(digits.slice(0, 2));
  const week = Number(digits.slice(2, 4));
  if (counter < 1 || counter > 99 || week < 1 || week > 53) return undefined;
  const totalMonths = 2026 * 12 + 6 + (counter - 17); // 0-based month index, 2026-07 = counter 17
  const year = Math.floor(totalMonths / 12);
  return `${digits.slice(2, 4)}${String(year % 100).padStart(2, "0")}`;
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

/**
 * Inverse of decodeKoaDateCode for printing labels: WWYY "2326" → "1223"
 * (counter 12 = 2026-02, a mid-mapping counter that decodes back to 2026).
 * Returns undefined for non-WWYY input or years the counter range can't
 * represent (counter clamps to 1–99 ≈ 2025-03 … 2033-05).
 */
export function encodeKoaDateCodeRaw(dateCode: string | null | undefined): string | undefined {
  if (!dateCode || !/^\d{4}$/.test(dateCode)) return undefined;
  const week = dateCode.slice(0, 2);
  const yy = Number(dateCode.slice(2, 4));
  const year = 2000 + yy;
  const counter = 17 + (year - 2026) * 12 - 5;
  if (counter < 1 || counter > 99) return undefined;
  return `${String(counter).padStart(2, "0")}${week}`;
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
 * ('koa_month_counter' → decodeKoaDateCode; otherwise passed through raw).
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

  let dateCode: string | undefined = groups.dateCode ?? undefined;
  if (dateCode && dateCodeEncoding === DATE_CODE_ENCODING_KOA_MONTH_COUNTER) {
    dateCode = decodeKoaDateCode(dateCode);
  }

  return {
    partNo: normalizePartNo(groups.itemId),
    qty,
    dateCode,
    lotCode: groups.lotCode ?? undefined,
    coo: groups.coo ?? undefined,
    cow: groups.cow ?? undefined,
    serialNo: groups.serialNo ?? undefined,
    wclItemNo: groups.wclItemNo ?? undefined,
  };
}
