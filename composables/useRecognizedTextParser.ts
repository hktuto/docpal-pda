import type { OcrInput } from "./useMockOcr";

export function useRecognizedTextParser() {
  function parseRecognizedText(text: string): OcrInput {
    const lines = text.split(/\r?\n/);
    const full = lines.join(" ").toUpperCase();

    const partNo =
      extract(full, /\b(?:PN|PART\s*NO?)[:\s]*([A-Z0-9\-]+)/i) ||
      extract(full, /\b([A-Z]{2,4}[-]?[0-9]{3,})\b/) ||
      "";

    const dateCode =
      extract(full, /\b(?:DT|DATE\s*CODE?)[:\s]*([A-Z0-9]+)/i) ||
      extract(full, /\b(?:MFG\s*DATE|DATE)[:\s]*([A-Z0-9]+)/i) ||
      "";

    const lotCode =
      extract(full, /\b(?:LOT|LOT\s*NO?)[:\s]*([A-Z0-9]+)/i) ||
      extract(full, /\b(?:BATCH)[:\s]*([A-Z0-9]+)/i) ||
      "";

    const coo =
      extract(full, /\b(?:COO|ORIGIN|MADE\s+IN)[:\s]*([A-Z]{2,3})/i) || "";

    const cow =
      extract(full, /\b(?:COW|COW\s*CODE?)[:\s]*([A-Z0-9]+)/i) || "";

    const qtyMatch =
      full.match(/\b(?:QTY|QTY\s*\(?\d+\)?|QUANTITY)[:\s]*(\d+)/i) ||
      full.match(/\bQ[:\s]*(\d+)\b/i);
    const qty = qtyMatch ? Number(qtyMatch[1]) : 1;

    return { partNo, dateCode, lotCode, coo, cow, qty };
  }

  function extract(text: string, regex: RegExp): string | undefined {
    const m = text.match(regex);
    return m ? m[1].trim() : undefined;
  }

  return { parseRecognizedText };
}
