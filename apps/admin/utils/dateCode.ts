// Date codes are WWYY strings (2-digit ISO week + 2-digit year, e.g. "3726"
// = ISO week 37 of 2026). The filter UI uses native calendar pickers, so
// these convert between calendar dates and WWYY, and rank a code for range
// comparison.

/** ISO-8601 week of a calendar date as WWYY. */
export function dateToDateCode(date: Date): string {
  const thursday = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = (thursday.getUTCDay() + 6) % 7; // Monday = 0
  thursday.setUTCDate(thursday.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${String(week).padStart(2, "0")}${String(thursday.getUTCFullYear() % 100).padStart(2, "0")}`;
}

/** Comparable rank (year * 100 + week) for a WWYY code; null when not a valid code. */
export function dateCodeRank(code: string | null | undefined): number | null {
  if (!code || !/^\d{4}$/.test(code)) return null;
  const week = Number(code.slice(0, 2));
  if (week < 1 || week > 53) return null;
  return (2000 + Number(code.slice(2))) * 100 + week;
}

/** Whether a row's WWYY dateCode falls inside the [from, to] calendar dates (null date = unbounded). */
export function dateCodeInRange(code: string | null | undefined, from: Date | null, to: Date | null): boolean {
  if (!from && !to) return true;
  const rank = dateCodeRank(code);
  if (rank === null) return false;
  const fromRank = from ? dateCodeRank(dateToDateCode(from)) : null;
  const toRank = to ? dateCodeRank(dateToDateCode(to)) : null;
  const lo = fromRank !== null && toRank !== null ? Math.min(fromRank, toRank) : fromRank;
  const hi = fromRank !== null && toRank !== null ? Math.max(fromRank, toRank) : toRank;
  if (lo !== null && rank < lo) return false;
  if (hi !== null && rank > hi) return false;
  return true;
}
