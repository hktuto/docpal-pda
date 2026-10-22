// ---------------------------------------------------------------------------
// Date codes. Canonical stored format is YYWW (2-digit ISO year + 2-digit ISO
// week, e.g. "2637" = week 37 of 2026) everywhere downstream of receiving;
// plain lexicographic order on a canonical code IS chronological. The
// receiving flow (receiving_orders / receiving_invoice_items + supplier-label
// scan decode output) stays in the label format — "wwyy" (default, e.g. HK /
// KOA) or "yyww" per the flow config dateCodeFormat — and converts at the
// boundaries via toCanonicalDateCode / toLabelDateCode (spec
// docs/superpowers/specs/2026-10-22-datecode-format-config-design.md).
// Mirrored by apps/admin/utils/dateCode.ts and apps/pda/utils/dateCode.ts.
// ---------------------------------------------------------------------------

/** Label/upstream (receiving enclave) date-code format; canonical storage is
 *  always YYWW. */
export type DateCodeFormat = "wwyy" | "yyww";

/** Comparable rank (fullYear * 100 + week) for a canonical YYWW code; null
 *  when invalid. The 2-digit year is windowed: 2000+YY, minus 100 when that
 *  lands more than a year in the future (date codes are never from the future —
 *  "9637" is 1996, not 2096). */
export function dateCodeRank(code: string | null | undefined, ref: Date = new Date()): number | null {
  if (!code || !/^\d{4}$/.test(code)) return null;
  const week = Number(code.slice(2, 4));
  if (week < 1 || week > 53) return null;
  let fullYear = 2000 + Number(code.slice(0, 2));
  if (fullYear > ref.getUTCFullYear() + 1) fullYear -= 100;
  return fullYear * 100 + week;
}

/** ISO-8601 week of a UTC instant as a canonical YYWW code. */
export function dateToDateCode(date: Date): string {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (thursday.getUTCDay() + 6) % 7; // Monday = 0
  thursday.setUTCDate(thursday.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${String(thursday.getUTCFullYear() % 100).padStart(2, "0")}${String(week).padStart(2, "0")}`;
}

/** Guarded WWYY↔YYWW pair swap ("3726" ↔ "2637"). Returns the input unchanged
 *  when it is not a 4-digit string; null-safe. */
export function swapDateCode(code: string | null | undefined): string | null {
  if (!code || !/^\d{4}$/.test(code)) return code ?? null;
  return `${code.slice(2, 4)}${code.slice(0, 2)}`;
}

/** Enclave/label format → canonical YYWW ("wwyy" → pair swap, "yyww" →
 *  identity). Applied at in boundaries (label scans, lot creation). Null-safe;
 *  non-4-digit codes pass through unchanged. */
export function toCanonicalDateCode(code: string | null | undefined, format: DateCodeFormat): string | null {
  return format === "wwyy" ? swapDateCode(code) : (code ?? null);
}

/** Canonical YYWW → enclave/label format (the inverse of
 *  toCanonicalDateCode). Applied at out boundaries (label printing).
 *  Null-safe; non-4-digit codes pass through unchanged. */
export function toLabelDateCode(code: string | null | undefined, format: DateCodeFormat): string | null {
  return format === "wwyy" ? swapDateCode(code) : (code ?? null);
}

/** Rank of the YYWW code exactly `years` before ref — the stock-search
 *  outdated threshold. */
export function outdatedThresholdRank(years: number, ref: Date = new Date()): number {
  const d = new Date(Date.UTC(ref.getUTCFullYear() - years, ref.getUTCMonth(), ref.getUTCDate()));
  return dateCodeRank(dateToDateCode(d))!;
}

/** True when `rank` (dateCodeRank of a code) is valid and below the outdated
 *  threshold rank; null ranks never flag. */
export function isOutdatedRank(rank: number | null, thresholdRank: number): boolean {
  return rank !== null && rank < thresholdRank;
}

/** Rank of the YYWW code exactly `months` before ref — the per-supplier
 *  outdated threshold (a scanned code ranking below it is outdated). */
export function outdatedThresholdRankMonths(months: number, ref: Date = new Date()): number {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - months, ref.getUTCDate()));
  return dateCodeRank(dateToDateCode(d))!;
}
