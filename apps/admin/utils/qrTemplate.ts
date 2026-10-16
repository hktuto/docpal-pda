// QR-template editor model + regex generator.
//
// Storage stays a regex string (supplier_profiles.qr_template) — the runtime
// source of truth consumed by the PDA parsers (apps/pda parseOcrScan.ts,
// apps/backend scanParse.ts). This module builds that regex from the
// structured config the editor writes to supplier_profiles.qr_template_config.
// Spec: docs/superpowers/specs/2026-07-24-supplier-qr-template-editor-design.md

export type FieldRole =
  | "itemId"
  | "qty"
  | "lotCode"
  | "dateCode"
  | "coo"
  | "cow"
  | "serialNo"
  | "wclItemNo"
  | "ignore";

export interface DelimitedField {
  role: FieldRole;
}

export interface FixedField {
  role: FieldRole;
  start: number; // 0-based start index on the sample
  length: number;
}

export type QrTemplateConfig =
  | { version: 1; mode: "delimited"; delimiter: string; fields: DelimitedField[] }
  | { version: 1; mode: "fixed"; fields: FixedField[] }
  | { version: 1; mode: "advanced" };

export const FIELD_ROLES: { value: FieldRole; label: string }[] = [
  { value: "itemId", label: "Part number (required)" },
  { value: "qty", label: "Quantity" },
  { value: "lotCode", label: "Lot code" },
  { value: "dateCode", label: "Date code" },
  { value: "coo", label: "Country of origin" },
  { value: "cow", label: "Country of warehousing" },
  { value: "serialNo", label: "Serial number" },
  { value: "wclItemNo", label: "WCL item no" },
  { value: "ignore", label: "Ignore this piece" },
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build the qr_template regex from a structured config. Advanced mode has
 *  no generator — the user edits the regex directly. */
export function buildRegex(config: QrTemplateConfig): string {
  if (config.mode === "delimited") {
    const d = escapeRegex(config.delimiter);
    const segments = config.fields.map((f) =>
      f.role === "ignore" ? `[^${d}]*` : `(?<${f.role}>[^${d}]*)`
    );
    return `^${segments.join(d)}$`;
  }
  if (config.mode === "fixed") {
    const fields = [...config.fields].sort((a, b) => a.start - b.start);
    let out = "^";
    let pos = 0;
    for (const f of fields) {
      if (f.start > pos) out += `.{${f.start - pos}}`;
      out += f.role === "ignore" ? `.{${f.length}}` : `(?<${f.role}>.{${f.length}})`;
      pos = f.start + f.length;
    }
    return out + ".*$";
  }
  throw new Error("advanced mode has no generator");
}

/** Compile a template and return the named groups it extracts from a sample,
 *  or null when the regex is invalid or does not match. Mirrors the parser's
 *  semantics (new RegExp(template, "u")). */
export function parseWithRegex(
  template: string,
  sample: string
): Record<string, string> | null {
  let re: RegExp;
  try {
    re = new RegExp(template, "u");
  } catch {
    return null;
  }
  const m = re.exec(sample.trim());
  if (!m || !m.groups) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.groups)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** KOA qty encoding: last digit = trailing-zero count ("253" → 25000).
 *  Copy of decodeKoaQty in apps/pda/utils/parseOcrScan.ts for the preview. */
export function decodeKoaQty(qty: string): number | undefined {
  if (!/^\d+$/.test(qty) || qty.length < 2) return undefined;
  const zeros = Number(qty[qty.length - 1]);
  const base = Number(qty.slice(0, -1));
  if (!Number.isFinite(base) || base <= 0) return undefined;
  return base * 10 ** zeros;
}

/** One counter→month period from the date_code_counter_periods table
 *  (GET /date-code-periods). periodStart is "YYYY-MM-DD" (first of month). */
export interface DateCodePeriod {
  encoding?: string; // 'koa_month_counter' on backend rows; omitted on fallbacks
  direction: "forward" | "backward";
  counterFrom: number;
  counterTo: number;
  periodStart: string;
}

/** Fallback periods used when the table is empty/unreachable — KOA's counter
 *  rolls 10→99 and restarts; one row per 90-month cycle (keep in sync with the
 *  backend seed in apps/backend/src/db/seed.ts). A counter rotation is a new
 *  row, never an edit. */
export const DEFAULT_DATE_CODE_PERIODS: DateCodePeriod[] = [
  { direction: "forward", counterFrom: 10, counterTo: 99, periodStart: "2010-12-01" },
  { direction: "forward", counterFrom: 10, counterTo: 99, periodStart: "2018-06-01" },
  { direction: "forward", counterFrom: 10, counterTo: 99, periodStart: "2025-12-01" },
];

function isoWeekYear(date: Date): { week: number; year: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this ISO week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

/** KOA date-code encoding ('koa_month_counter'): leading digit run (>= 4
 *  digits) = 2-digit month counter + 2-digit DAY of month. The counter maps
 *  to a month through the configured periods (see DateCodePeriod); the result
 *  is rendered as WWYY = ISO-8601 week + ISO week-year of that date. */
export function decodeKoaDateCode(
  raw: string,
  periods: DateCodePeriod[] = DEFAULT_DATE_CODE_PERIODS,
  referenceDate: Date = new Date()
): string | undefined {
  const digits = raw.match(/^\d+/)?.[0];
  if (!digits || digits.length < 4) return undefined;
  const counter = Number(digits.slice(0, 2));
  const day = Number(digits.slice(2, 4));
  if (day < 1 || day > 31) return undefined;
  const refMonth = referenceDate.getUTCFullYear() * 12 + referenceDate.getUTCMonth(); // 0-based month index
  const candidates: number[] = [];
  for (const p of periods) {
    if (p.encoding !== undefined && p.encoding !== "koa_month_counter") continue;
    const lo = Math.min(p.counterFrom, p.counterTo);
    const hi = Math.max(p.counterFrom, p.counterTo);
    if (counter < lo || counter > hi) continue;
    const m = p.periodStart.match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (!m) continue;
    const offset = p.direction === "forward" ? counter - p.counterFrom : p.counterFrom - counter;
    candidates.push(Number(m[1]) * 12 + (Number(m[2]) - 1) + offset);
  }
  if (candidates.length === 0) return undefined;
  const past = candidates.filter((c) => c <= refMonth);
  const picked = past.length > 0 ? Math.max(...past) : Math.min(...candidates);
  const year = Math.floor(picked / 12);
  const month = picked % 12; // 0-based
  const monthLength = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (day > monthLength) return undefined;
  const { week, year: isoYear } = isoWeekYear(new Date(Date.UTC(year, month, day)));
  return `${String(week).padStart(2, "0")}${String(isoYear % 100).padStart(2, "0")}`;
}

/** Editor entry point: stored config if present and recognized, else advanced
 *  mode over the raw (possibly legacy hand-written) regex. */
export function detectMode(profile: {
  qrTemplate?: string | null;
  qrTemplateConfig?: unknown;
}): QrTemplateConfig {
  const c = profile.qrTemplateConfig as QrTemplateConfig | null | undefined;
  if (c && typeof c === "object" && c.version === 1 && c.mode) return c;
  return { version: 1, mode: "advanced" };
}
