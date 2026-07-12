const CONFUSABLES: Record<string, string> = { O: "0", I: "1", L: "1", Z: "2", S: "5" };

export function collapseUpper(s: string): string {
  return s.trim().replace(/\s+/g, " ").toUpperCase();
}

function applyConfusables(s: string): string {
  return s.replace(/[OILZS]/g, (c) => CONFUSABLES[c] ?? c);
}

/** part_no / date_code / lot_code: confusable map + collapse + upper */
export function normalizeCode(s: string | null | undefined): string | null {
  if (s == null) return null;
  return applyConfusables(collapseUpper(s));
}

/** coo / cow: collapse + upper, no confusable map */
export function normalizePlain(s: string | null | undefined): string | null {
  if (s == null) return null;
  return collapseUpper(s);
}

/** part number uses the confusable mapping (identical to normalizeCode). */
export const normalizePartNo = normalizeCode;
