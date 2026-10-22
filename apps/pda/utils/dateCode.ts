// ---------------------------------------------------------------------------
// Date codes. Canonical stored format downstream of receiving is YYWW
// (2-digit ISO year + 2-digit ISO week, e.g. "2637" = week 37 of 2026);
// plain lexicographic order on a canonical code IS chronological. The
// receiving flow (upstream receiving data + supplier-label scan decode
// output) stays in the label format — "wwyy" (default, e.g. HK / KOA) or
// "yyww" per the flow config dateCodeFormat — and converts at the boundaries
// via toCanonicalDateCode / toLabelDateCode (spec
// docs/superpowers/specs/2026-10-22-datecode-format-config-design.md).
// Mirrors apps/backend/src/db/dateCode.ts.
// ---------------------------------------------------------------------------

/** Label/upstream (receiving enclave) date-code format; canonical storage is
 *  always YYWW. */
export type DateCodeFormat = "wwyy" | "yyww";

/** ISO-8601 week of a calendar date as a canonical YYWW code. */
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
 *  identity). Applied right after label-scan decode, before scanned codes are
 *  compared against canonical lots/packages. Null-safe; non-4-digit codes pass
 *  through unchanged. */
export function toCanonicalDateCode(code: string | null | undefined, format: DateCodeFormat): string | null {
  return format === "wwyy" ? swapDateCode(code) : (code ?? null);
}

/** Canonical YYWW → enclave/label format (the inverse of
 *  toCanonicalDateCode). Applied where a system-generated canonical code is
 *  posted to a backend boundary that expects the label format. Null-safe;
 *  non-4-digit codes pass through unchanged. */
export function toLabelDateCode(code: string | null | undefined, format: DateCodeFormat): string | null {
  return format === "wwyy" ? swapDateCode(code) : (code ?? null);
}

export type DateCodeComparison = "equal" | "earlier" | "later" | null;

/** Parse a strict 4-digit canonical YYWW code (year = first pair, week =
 *  second pair; week 01–53). Two-digit years map to 2000+, but years before
 *  2015 are rejected as implausible: values like "0326" are almost certainly
 *  a different on-label convention (e.g. WWYY), and comparing across formats
 *  would order them nonsense — treat as unparseable so the caller SKIPS the
 *  check instead of mis-rejecting. */
export function parseDateCode(value: string | null | undefined): { year: number; week: number } | null {
  const v = (value ?? "").trim();
  if (!/^\d{4}$/.test(v)) return null;
  const year = 2000 + Number(v.slice(0, 2));
  const week = Number(v.slice(2, 4));
  if (week < 1 || week > 53 || year < 2015) return null;
  return { year, week };
}

/**
 * Compare two canonical YYWW date codes, year first then week. Returns null
 * when either side is not a valid YYWW code — callers treat that as "cannot
 * compare, do not reject" so an unknown label format never blocks a scan.
 */
export function compareDateCodes(scanned: string | null | undefined, target: string | null | undefined): DateCodeComparison {
  const a = parseDateCode(scanned);
  const b = parseDateCode(target);
  if (!a || !b) return null;
  if (a.year !== b.year) return a.year < b.year ? "earlier" : "later";
  if (a.week !== b.week) return a.week < b.week ? "earlier" : "later";
  return "equal";
}
