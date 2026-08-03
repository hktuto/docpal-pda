// ---------------------------------------------------------------------------
// Server-side scan parsing: supplier QR templates only (plan decision 5).
// Ported from apps/web/utils/parseOcrScan.ts — the `supplier_profiles.qr_template`
// regex (named groups) + `qty_encoding` ('koa_zeros') logic. Camera OCR fallback
// parsing stays client-side; clients send `raw` and/or explicit fields.
// ---------------------------------------------------------------------------

const QTY_ENCODING_KOA_ZEROS = "koa_zeros";
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
 * Build a raw label value matching the seeded KOA qr_template
 * ("^:(?<itemId>…):(?<subId>…):(?<qty>…):(?<ignore1>…):(?<lotCode>…):(?<serialNo>…):(?<fullName>.+)$"
 * with koa_zeros qty encoding) — used to print scannable demo part labels.
 * Round-trips through parseQrRaw with that template. `fullName` defaults to
 * the "KOA+<partNo>" marking style seen on real reels.
 */
export function buildKoaLabelRaw(input: {
  partNo: string;
  qty: number;
  lotCode?: string | null;
  serialNo: string;
  fullName?: string;
}): string | undefined {
  const qty = encodeKoaQty(input.qty);
  if (!qty) return undefined;
  const fullName = input.fullName ?? `KOA+${input.partNo}`;
  // the template's lotCode/serialNo groups require 1+ chars — never emit empties
  return `:${input.partNo}::${qty}:X:${input.lotCode?.trim() || "-"}:${input.serialNo}:${fullName}`;
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
 * `coo`, `cow`, `serialNo`. Returns {} when there is no template, the regex
 * is invalid, or the raw value does not match. `qty` is decoded per
 * `qtyEncoding` ('koa_zeros' → decodeKoaQty; otherwise a plain positive
 * integer). Templates without a `serialNo` group simply yield no serial
 * (older templates, other suppliers) — unknown groups are ignored.
 */
export function parseQrRaw(
  raw: string,
  template: string | null | undefined,
  qtyEncoding: string | null | undefined
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

  return {
    partNo: normalizePartNo(groups.itemId),
    qty,
    dateCode: groups.dateCode ?? undefined,
    lotCode: groups.lotCode ?? undefined,
    coo: groups.coo ?? undefined,
    cow: groups.cow ?? undefined,
    serialNo: groups.serialNo ?? undefined,
  };
}
