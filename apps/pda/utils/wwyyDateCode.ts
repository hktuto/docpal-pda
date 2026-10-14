// WWYY date-code comparison for the picking scan batch validation
// (spec 2026-10-14): the scanned label's date code must be equal to or earlier
// than the source's — a reel older than stock records say is tolerable, a
// newer one is the suspicious direction.

export type WwyyComparison = "equal" | "earlier" | "later" | null;

/** Parse a strict 4-digit WWYY code (week 01–53). Two-digit years map to
 *  2000+, but years before 2015 are rejected as implausible: values like
 *  "2603" are almost certainly a different on-label convention (e.g. YYWW),
 *  and comparing across formats would order them nonsense — treat as
 *  unparseable so the caller SKIPS the check instead of mis-rejecting. */
export function parseWwyy(value: string | null | undefined): { week: number; year: number } | null {
  const v = (value ?? "").trim();
  if (!/^\d{4}$/.test(v)) return null;
  const week = Number(v.slice(0, 2));
  const year = 2000 + Number(v.slice(2, 4));
  if (week < 1 || week > 53 || year < 2015) return null;
  return { week, year };
}

/**
 * Compare two WWYY date codes, year first then week. Returns null when either
 * side is not a valid WWYY code — callers treat that as "cannot compare, do
 * not reject" so an unknown label format never blocks a scan.
 */
export function compareWwyyDateCodes(scanned: string | null | undefined, target: string | null | undefined): WwyyComparison {
  const a = parseWwyy(scanned);
  const b = parseWwyy(target);
  if (!a || !b) return null;
  if (a.year !== b.year) return a.year < b.year ? "earlier" : "later";
  if (a.week !== b.week) return a.week < b.week ? "earlier" : "later";
  return "equal";
}
