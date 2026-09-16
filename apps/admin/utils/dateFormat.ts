// Unicode-token date formatter (date-fns semantics, zero dependencies) for
// table cells and detail rows. Tokens: yyyy yy MMM MM M dd d HH H hh mm m ss a.
// Defaults come from the per-user profile (datePreferences); this module only
// exposes the pure pattern formatter plus value-driven entry points.

export const DEFAULT_DATE_FORMAT = "dd/MMM/yyyy";
export const DEFAULT_DATE_TIME_FORMAT = "dd/MMM/yyyy HH:mm";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TOKEN_RE = /yyyy|yy|MMM|MM|M|dd|d|HH|H|hh|mm|m|ss|a/g;

const pad = (n: number) => String(n).padStart(2, "0");

/** Render `date` with a Unicode-token pattern, e.g.
 *  formatWithPattern(d, "dd/MMM/yyyy HH:mm") → "16/Sep/2026 15:09". */
export function formatWithPattern(date: Date, pattern: string): string {
  const h24 = date.getHours();
  const replacements: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    yy: pad(date.getFullYear() % 100),
    MMM: MONTHS[date.getMonth()],
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    dd: pad(date.getDate()),
    d: String(date.getDate()),
    HH: pad(h24),
    H: String(h24),
    hh: pad(h24 % 12 || 12),
    mm: pad(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad(date.getSeconds()),
    a: h24 < 12 ? "AM" : "PM",
  };
  return pattern.replace(TOKEN_RE, (token) => replacements[token]);
}

export function isDateOnlyString(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function toValidDate(value: unknown): Date | null {
  const d = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
}
