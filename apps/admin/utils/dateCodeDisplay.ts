// Date-code display template (spec
// docs/superpowers/specs/2026-09-17-date-code-display-template-design.md):
// renders a lot's date code / lot code / COO / COW through the admin-configured
// template, e.g. "[date_code][coo]" → "3626cn". A placeholder whose field is
// empty renders as "" (no dangling separator); unknown [tokens] stay literal.

export interface DateCodeFields {
  dateCode?: string | null;
  lotCode?: string | null;
  coo?: string | null;
  cow?: string | null;
}

const PLACEHOLDERS: Record<string, keyof DateCodeFields> = {
  date_code: "dateCode",
  lot_code: "lotCode",
  coo: "coo",
  cow: "cow",
  coo_short: "coo",
  cow_short: "cow",
};

/** Tokens rendering the country_list.short_code lookup instead of the raw code. */
const SHORT_CODE = new Set(["coo_short", "cow_short"]);

// shortCodes maps a country code (any case) to its short char. A set field
// with no matching short code falls back to the raw code so an unmapped
// country never renders blank.
export function formatDateCodeDisplay(
  fields: DateCodeFields,
  template: string,
  shortCodes: Record<string, string> = {}
): string {
  return template.replace(/\[([^\]]*)\]/g, (whole, name: string) => {
    const key = PLACEHOLDERS[name];
    if (!key) return whole;
    const value = fields[key] ?? "";
    if (!SHORT_CODE.has(name) || value === "") return value;
    return shortCodes[value.toUpperCase()] || value;
  });
}
