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
};

export function formatDateCodeDisplay(fields: DateCodeFields, template: string): string {
  return template.replace(/\[([^\]]*)\]/g, (whole, name: string) => {
    const key = PLACEHOLDERS[name];
    if (!key) return whole;
    return fields[key] ?? "";
  });
}
