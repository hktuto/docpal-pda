// ---------------------------------------------------------------------------
// Date codes. Canonical storage format is YYWW (2-digit ISO year + 2-digit
// ISO week, e.g. "2637" = week 37 of 2026) everywhere downstream of
// receiving, so plain lexicographic order on a canonical code IS
// chronological. The receiving flow (receiving orders/items + supplier-label
// scan decode output) stays in the label format — "wwyy" (default, e.g. HK /
// KOA) or "yyww" per the flow config dateCodeFormat — and converts at the
// boundaries via toCanonicalDateCode / toLabelDateCode (spec
// docs/superpowers/specs/2026-10-22-datecode-format-config-design.md).
// Mirrored by apps/backend/src/db/dateCode.ts.
// ---------------------------------------------------------------------------

/** Label/upstream (receiving enclave) date-code format; canonical storage is
 *  always YYWW. */
export type DateCodeFormat = "wwyy" | "yyww";

/** ISO-8601 week of a calendar date as a canonical YYWW code. */
export function dateToDateCode(date: Date): string {
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = (thursday.getUTCDay() + 6) % 7; // Monday = 0
  thursday.setUTCDate(thursday.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${String(thursday.getUTCFullYear() % 100).padStart(2, "0")}${String(week).padStart(2, "0")}`;
}

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

/** Whether a row's canonical YYWW dateCode falls inside the [from, to]
 *  calendar dates (null date = unbounded). For valid YYWW codes
 *  lexicographic order is chronological, so this is a plain string-range
 *  compare; invalid codes never match when a bound is set. */
export function dateCodeInRange(code: string | null | undefined, from: Date | null, to: Date | null): boolean {
  if (!from && !to) return true;
  if (dateCodeRank(code) === null) return false;
  const c = code as string;
  const fromCode = from ? dateToDateCode(from) : null;
  const toCode = to ? dateToDateCode(to) : null;
  const lo = fromCode !== null && toCode !== null ? (fromCode < toCode ? fromCode : toCode) : fromCode;
  const hi = fromCode !== null && toCode !== null ? (fromCode < toCode ? toCode : fromCode) : toCode;
  if (lo !== null && c < lo) return false;
  if (hi !== null && c > hi) return false;
  return true;
}
