import type { OcrParseResult } from "~/db/ocrPicking";

export interface OcrInput {
  partNo: string;
  dateCode: string;
  lotCode: string;
  originCountry: string;
  qty: number | "";
}

export function useMockOcr() {
  /**
   * Turn a manual tester input into a parsed OCR result.
   * Empty date/lot/origin are stored as null so they act as wildcards.
   */
  function parseManual(input: OcrInput): OcrParseResult {
    const qty = typeof input.qty === "number" ? input.qty : Number(input.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error("Qty must be a positive integer");
    }

    return {
      partNo: normalize(input.partNo),
      dateCode: input.dateCode ? normalizeCode(input.dateCode) : null,
      lotCode: input.lotCode ? normalizeCode(input.lotCode) : null,
      originCountry: input.originCountry ? normalize(input.originCountry) : null,
      qty,
    };
  }

  /**
   * Base normalization: trim, uppercase, collapse whitespace.
   * Keeps dashes and letters intact so part numbers like KOA-103 stay valid.
   */
  function normalize(value: string): string {
    return value.trim().toUpperCase().replace(/\s+/g, " ");
  }

  /**
   * Code normalization: same as base plus common OCR digit substitutions.
   * Use only for fields that are known to be codes/dates/lots, not part numbers.
   */
  function normalizeCode(value: string): string {
    return normalize(value)
      .replace(/O/g, "0")
      .replace(/I/g, "1")
      .replace(/L/g, "1")
      .replace(/Z/g, "2")
      .replace(/S/g, "5");
  }

  return { parseManual, normalize, normalizeCode };
}
