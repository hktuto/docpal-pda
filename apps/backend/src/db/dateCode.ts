// ---------------------------------------------------------------------------
// WWYY date codes (2-digit ISO week + 2-digit year, e.g. "3726" = week 37 of
// 2026) — the real-data format, mirrored by apps/admin/utils/dateCode.ts and
// apps/pda/utils/dateCode.ts.
// rank = year*100 + week orders codes correctly; a lexicographic string
// compare does NOT ("5221" = 2021w52 sorts after "0322" = 2022w03 as strings
// but is chronologically earlier).
// ---------------------------------------------------------------------------

/** Comparable rank (fullYear * 100 + week) for a WWYY code; null when
 *  invalid. The 2-digit year is windowed: 2000+YY, minus 100 when that lands
 *  more than a year in the future (date codes are never from the future —
 *  "3896" is 1996, not 2096). */
export function dateCodeRank(code: string | null | undefined, ref: Date = new Date()): number | null {
  if (!code || !/^\d{4}$/.test(code)) return null;
  const week = Number(code.slice(0, 2));
  if (week < 1 || week > 53) return null;
  let fullYear = 2000 + Number(code.slice(2));
  if (fullYear > ref.getUTCFullYear() + 1) fullYear -= 100;
  return fullYear * 100 + week;
}

/** ISO-8601 week of a UTC instant as a WWYY code. */
export function dateToDateCode(date: Date): string {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (thursday.getUTCDay() + 6) % 7; // Monday = 0
  thursday.setUTCDate(thursday.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${String(week).padStart(2, "0")}${String(thursday.getUTCFullYear() % 100).padStart(2, "0")}`;
}

/** Rank of the WWYY code exactly `years` before ref — the stock-search
 *  outdated threshold. */
export function outdatedThresholdRank(years: number, ref: Date = new Date()): number {
  const d = new Date(Date.UTC(ref.getUTCFullYear() - years, ref.getUTCMonth(), ref.getUTCDate()));
  return dateCodeRank(dateToDateCode(d))!;
}

/** Rank of the WWYY code exactly `months` before ref — the per-supplier
 *  outdated threshold (a scanned code ranking below it is outdated). */
export function outdatedThresholdRankMonths(months: number, ref: Date = new Date()): number {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - months, ref.getUTCDate()));
  return dateCodeRank(dateToDateCode(d))!;
}
