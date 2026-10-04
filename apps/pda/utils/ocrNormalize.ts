// OCR/label-field normalization shared by the scan matchers and label
// parsing. In apps/web these lived on the retired useMockOcr tester
// composable; they are pure helpers, so they sit in utils here.

export interface OcrInput {
  partNo: string;
  dateCode: string;
  lotCode: string;
  coo: string;
  cow: string;
  qty: number | "";
  /** WCL item no captured by the supplier template (e.g. KOA segment 7). */
  wclItemNo?: string;
}

/**
 * Base normalization: trim, uppercase, collapse whitespace.
 * Keeps dashes and letters intact so part numbers like KOA-103 stay valid.
 */
export function normalize(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * Code normalization: same as base plus common OCR digit substitutions.
 * Use only for fields that are known to be codes/dates/lots, not part numbers.
 */
export function normalizeCode(value: string): string {
  return normalize(value)
    .replace(/O/g, "0")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/Z/g, "2")
    .replace(/S/g, "5");
}
