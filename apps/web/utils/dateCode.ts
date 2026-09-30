// Date codes are WWYY strings (2-digit ISO week + 2-digit year, e.g. "3726"
// = ISO week 37 of 2026). The stock-search filter UI uses native calendar
// pickers, so this converts a calendar date to WWYY (same helper as the
// admin console's utils/dateCode.ts).

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
