// QR-template editor model + regex generator.
//
// Storage stays a regex string (supplier_profiles.qr_template) — the runtime
// source of truth consumed by the PDA parsers (apps/web parseOcrScan.ts,
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
 *  Copy of decodeKoaQty in apps/web/utils/parseOcrScan.ts for the preview. */
export function decodeKoaQty(qty: string): number | undefined {
  if (!/^\d+$/.test(qty) || qty.length < 2) return undefined;
  const zeros = Number(qty[qty.length - 1]);
  const base = Number(qty.slice(0, -1));
  if (!Number.isFinite(base) || base <= 0) return undefined;
  return base * 10 ** zeros;
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
