import type { OcrInput } from "./useMockOcr";

export function parseRecognizedText(text: string): OcrInput {
  const lines = text.split(/\r?\n/);
  const full = lines.join(" ").toUpperCase();

  const partNo =
    extract(full, /\b(?:PN|PART\s+NO|PART\s+#|P\/N|MPN|TYPE)[:\s]+([A-Z0-9\-]+)/) ||
    extractPartNoFallback(full) ||
    "";

  const dateCode =
    extract(full, /\b(?:DT|DATE\s*CODE?)[:\s]*([A-Z0-9\-]+)/) ||
    extract(full, /\b(?:MFG\s*DATE|DATE)[:\s]*([A-Z0-9\-]+)/) ||
    "";

  const lotCode =
    extract(full, /\b(?:LOT|LOT\s*NO?|LOT#)[:\s]*([A-Z0-9\-]+)/) ||
    extract(full, /\b(?:BATCH)[:\s]*([A-Z0-9\-]+)/) ||
    "";

  const coo =
    extract(full, /\b(?:COO|COUNTRY\s+OF\s+ORIGIN)[:\s]+([A-Z]{2,3})\b/) ||
    extract(full, /\bMADE\s+IN\s+([A-Z]{2,3})\b/) ||
    "";

  const cow = extract(full, /\b(?:COW|COW\s*CODE?)[:\s]*([A-Z0-9\-]+)/) || "";

  const qtyStr =
    extract(full, /\b(?:QTY|QUANTITY)[:\s]+(\d+)\b/) ||
    extract(full, /\bQ[:\s]+(\d+)\b/) ||
    lines.find((l) => /^\d+$/.test(l.trim()));
  const qty = qtyStr ? Number(qtyStr) : 1;

  return { partNo, dateCode, lotCode, coo, cow, qty };
}

function extract(text: string, regex: RegExp): string | undefined {
  const m = text.match(regex);
  return m ? m[1].trim() : undefined;
}

function extractPartNoFallback(full: string): string | undefined {
  const m = full.match(/\b([A-Z]{2,}[A-Z0-9\-]*[0-9]+[A-Z0-9\-]*)\b/);
  if (!m) return undefined;

  const candidate = m[1];
  const forbiddenPrefixes = ["Q", "QTY", "QUANTITY", "LOT", "DATE", "MFG", "COO", "COW"];
  if (forbiddenPrefixes.some((p) => candidate.startsWith(p))) return undefined;

  const start = m.index ?? 0;
  const before = full.slice(0, start).trim();
  const lastToken = (before.split(/\s+/).pop() || "").replace(/[^A-Z]+$/i, "");
  if (forbiddenPrefixes.includes(lastToken)) return undefined;

  return candidate;
}
