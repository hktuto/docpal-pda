/** A single barcode or QR code returned by the native scanner. */
export interface OcrBarcode {
  value: string;
  format: string;
}

/** Raw scan result from the native label scanner. */
export interface RawOcrCapture {
  text: string;
  barcodes: OcrBarcode[];
}

/** Best-guess parsed fields. `itemId` is the matched part number. */
export interface ParsedFields {
  itemId: string | null;
  qty?: number;
  coo?: string;
  dateCode?: string;
  lotCode?: string;
  cow?: string;
}

/**
 * All candidate values found in the scan.
 * Arrays are ordered by confidence; `parsed` uses the first item of each.
 */
export interface CandidateOptions {
  itemIds: string[];
  qtys: number[];
  coos: string[];
  dateCodes: string[];
  lotCodes: string[];
  cows: string[];
}

/** Result of parsing and identifying a scanned label. */
export interface OcrParseResult {
  matched: boolean;
  parsed: ParsedFields;
  options: CandidateOptions;
  raw: RawOcrCapture;
}

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  CHINA: 'CN',
  SLOVENIA: 'SI',
  JAPAN: 'JP',
  INDIA: 'IN',
  GERMANY: 'DE',
  KOREA: 'KR',
  MALAYSIA: 'MY',
  INDONESIA: 'ID',
  TAIWAN: 'TW',
  THAILAND: 'TH',
  VIETNAM: 'VN',
  USA: 'US',
  AMERICA: 'US',
  UNITEDSTATES: 'US',
  SINGAPORE: 'SG',
  PHILIPPINES: 'PH',
};

const OCR_SUBSTITUTIONS: Record<string, string[]> = {
  '0': ['0', 'O'],
  'O': ['O', '0'],
  '1': ['1', 'I', 'L'],
  'I': ['I', '1', 'L'],
  'L': ['L', '1', 'I'],
  '2': ['2', 'Z'],
  'Z': ['Z', '2'],
  '5': ['5', 'S'],
  'S': ['S', '5'],
  '8': ['8', 'B'],
  'B': ['B', '8'],
};

function normalizeText(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, '');
}

function generateVariants(value: string): string[] {
  const base = collapseSpaces(value.toUpperCase());
  const results = new Set<string>();

  function generate(index: number, current: string) {
    if (index >= base.length) {
      results.add(current);
      return;
    }

    const char = base[index];
    const replacements = OCR_SUBSTITUTIONS[char] ?? [char];
    for (const replacement of replacements) {
      generate(index + 1, current + replacement);
    }
  }

  generate(0, '');
  return Array.from(results);
}

function extractWithRegex(text: string, regex: RegExp): string[] {
  const results: string[] = [];
  const normalized = normalizeText(text);
  let match: RegExpExecArray | null;
  const localRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  while ((match = localRegex.exec(normalized)) !== null) {
    const value = match[1]?.trim();
    if (value) results.push(value);
  }
  return results;
}

function looksLikePartNumber(value: string): boolean {
  const collapsed = collapseSpaces(value);
  return /^[A-Z0-9\-]+$/.test(collapsed) && /[A-Z]/.test(collapsed) && /[0-9]/.test(collapsed) && collapsed.length >= 4;
}

function stripSupplierPrefixes(value: string): string {
  return value.replace(/^(KOA\+|ABLIC\+|DIOTEC\+|MMC\+|DAITO\+)/i, '');
}

interface BarcodeSegments {
  partNo: string[];
  qty: string[];
  dateCode: string[];
  lotCode: string[];
  coo: string[];
  cow: string[];
}

function parseBarcodeSegments(barcodes: OcrBarcode[]): BarcodeSegments {
  const segments: BarcodeSegments = {
    partNo: [],
    qty: [],
    dateCode: [],
    lotCode: [],
    coo: [],
    cow: [],
  };

  for (const barcode of barcodes) {
    const value = normalizeText(barcode.value);

    // GS1 / ANSI MH10.8.2 style identifiers: (P)VALUE (Q)VALUE etc.
    const segmentRegex = /\(([A-Z0-9]+)\)([^\(]+)/g;
    let match: RegExpExecArray | null;
    let foundSegments = false;
    while ((match = segmentRegex.exec(value)) !== null) {
      foundSegments = true;
      const key = match[1].trim().toUpperCase();
      const segmentValue = match[2].trim();

      if (key === 'P' || key === '1P') {
        segments.partNo.push(segmentValue);
      } else if (key === 'Q') {
        segments.qty.push(segmentValue);
      } else if (key === 'D') {
        segments.dateCode.push(segmentValue);
      } else if (key === 'L' || key === 'T' || key === '1T') {
        segments.lotCode.push(segmentValue);
      } else if (key === 'COO') {
        segments.coo.push(segmentValue);
      } else if (key === 'COW') {
        segments.cow.push(segmentValue);
      }
    }

    if (!foundSegments) {
      // Whole barcode may be a part number; try to interpret it below.
      segments.partNo.push(value);
    }
  }

  return segments;
}

export function extractPartNoCandidates(text: string, barcodes: OcrBarcode[]): string[] {
  const candidates: string[] = [];
  const barcodeSegments = parseBarcodeSegments(barcodes);

  // Barcode segments first (GS1-style part numbers)
  for (const value of barcodeSegments.partNo) {
    const stripped = stripSupplierPrefixes(value);
    if (looksLikePartNumber(stripped)) {
      candidates.push(stripped);
    }
  }

  const normalizedText = normalizeText(text);

  // Explicit labels
  const labelPatterns = [
    /\(P\)CUSTOMER\s+P\/N:\s*([A-Z0-9\- ]+)/,
    /\(1P\)MPN:\s*([A-Z0-9\- ]+)/,
    /\b(?:PN|PART\s+NO|PART\s+#|P\/N|MPN|TYPE|CODE)\s*[:\s]+([A-Z0-9\- ]+)/g,
  ];

  for (const pattern of labelPatterns) {
    const values = extractWithRegex(normalizedText, pattern);
    for (const value of values) {
      const stripped = stripSupplierPrefixes(value);
      if (looksLikePartNumber(stripped)) {
        candidates.push(stripped);
      }
    }
  }

  // Fallback: any token that looks like a part number
  const tokens = normalizedText.split(/[^A-Z0-9\-]+/);
  for (const token of tokens) {
    if (looksLikePartNumber(token)) {
      candidates.push(stripSupplierPrefixes(token));
    }
  }

  // Also try joining adjacent short tokens that may have been split (e.g. "RK73H1ETTP 1001F")
  const words = normalizedText.split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    const joined = words[i] + words[i + 1];
    if (looksLikePartNumber(joined)) {
      candidates.push(stripSupplierPrefixes(joined));
    }
  }

  return [...new Set(candidates.map(collapseSpaces))];
}

export function extractQtyCandidates(text: string, barcodes: OcrBarcode[]): number[] {
  const values: number[] = [];
  const barcodeSegments = parseBarcodeSegments(barcodes);
  const normalizedText = normalizeText(text);

  // Explicit quantity labels
  const explicit = extractWithRegex(
    normalizedText,
    /\b(?:QTY|QUANTITY|Q)\s*[:\s]+(\d+)/g
  );
  for (const v of explicit) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) values.push(n);
  }

  // Number followed by units
  const unitMatches = extractWithRegex(
    normalizedText,
    /\b(\d+)\s*(?:PCS|PC|EA|EA\.?|QTY|QUANTITY|Q)\b/g
  );
  for (const v of unitMatches) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !values.includes(n)) values.push(n);
  }

  // Barcode segments and whole-barcode values
  for (const segment of barcodeSegments.qty) {
    const n = Number(collapseSpaces(segment));
    if (Number.isInteger(n) && n > 0 && !values.includes(n)) values.push(n);
  }

  for (const barcode of barcodes) {
    const value = normalizeText(barcode.value);
    const pureMatch = value.match(/^\d+$/);
    if (pureMatch) {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0 && !values.includes(n)) values.push(n);
      continue;
    }
    const qMatch = value.match(/^Q(\d+)$/);
    if (qMatch) {
      const n = Number(qMatch[1]);
      if (Number.isInteger(n) && n > 0 && !values.includes(n)) values.push(n);
    }
  }

  // Fallback: any bare 2+ digit integer
  const bareMatches = extractWithRegex(normalizedText, /\b(\d{2,})\b/g);
  for (const v of bareMatches) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !values.includes(n)) values.push(n);
  }

  return values;
}

export function extractDateCodeCandidates(text: string, barcodes: OcrBarcode[]): string[] {
  const values: string[] = [];
  const barcodeSegments = parseBarcodeSegments(barcodes);
  const normalizedText = normalizeText(text);

  // Explicit labels
  const explicit = extractWithRegex(
    normalizedText,
    /\b(?:DATE\s*CODE?|DT|MFG\s*DATE|DATE)\s*[:\s]*([A-Z0-9\-]+)/g
  );
  for (const v of explicit) {
    const cleaned = collapseSpaces(v);
    if (cleaned.length >= 2 && cleaned.length <= 12) values.push(cleaned);
  }

  // Barcode date identifiers
  for (const segment of barcodeSegments.dateCode) {
    const cleaned = collapseSpaces(segment);
    if (cleaned.length >= 2 && cleaned.length <= 12 && !values.includes(cleaned)) {
      values.push(cleaned);
    }
  }

  // ISO-like dates: 2025-10-29
  const isoMatches = extractWithRegex(normalizedText, /\b(\d{4}-\d{2}-\d{2})\b/g);
  for (const v of isoMatches) {
    const cleaned = collapseSpaces(v);
    if (!values.includes(cleaned)) values.push(cleaned);
  }

  // Bare 4-8 digit sequences that could be date codes
  const bareMatches = extractWithRegex(normalizedText, /\b(\d{4,8})\b/g);
  for (const v of bareMatches) {
    if (!values.includes(v)) values.push(v);
  }

  return values;
}

function isPartNumberToken(token: string, partNo: string): boolean {
  const normalizedToken = collapseSpaces(token);
  const normalizedPartNo = collapseSpaces(normalizeText(partNo));
  return (
    normalizedToken === normalizedPartNo ||
    normalizedPartNo.includes(normalizedToken) ||
    normalizedToken.includes(normalizedPartNo)
  );
}

export function extractLotCodeCandidates(
  text: string,
  barcodes: OcrBarcode[],
  excludeItemId?: string
): string[] {
  const values: string[] = [];
  const barcodeSegments = parseBarcodeSegments(barcodes);
  const normalizedText = normalizeText(text);

  const explicit = extractWithRegex(
    normalizedText,
    /\b(?:LOT\s*NO?|LOT#|LOT|BATCH|TRACE\s*CODE)\s*[:\s]*([A-Z0-9\-]+)/g
  );
  for (const v of explicit) {
    const cleaned = collapseSpaces(v);
    if (cleaned.length >= 2) values.push(cleaned);
  }

  // KOA-style (1T) trace code
  const traceMatches = extractWithRegex(normalizedText, /\(1T\)\s*TRACE\s*CODE\s*[:\s]*([A-Z0-9\-]+)/g);
  for (const v of traceMatches) {
    const cleaned = collapseSpaces(v);
    if (cleaned.length >= 2 && !values.includes(cleaned)) values.push(cleaned);
  }

  // Barcode lot identifiers
  for (const segment of barcodeSegments.lotCode) {
    const cleaned = collapseSpaces(segment);
    if (cleaned.length >= 2 && !values.includes(cleaned)) values.push(cleaned);
  }

  // Fallback: alphanumeric tokens that are not substrings of the matched part number
  const tokens = normalizedText.split(/[^A-Z0-9\-]+/);
  for (const token of tokens) {
    const cleaned = collapseSpaces(token);
    if (
      cleaned.length >= 4 &&
      cleaned.length <= 30 &&
      /[A-Z]/.test(cleaned) &&
      /[0-9]/.test(cleaned) &&
      (!excludeItemId || !isPartNumberToken(cleaned, excludeItemId)) &&
      !values.includes(cleaned)
    ) {
      values.push(cleaned);
    }
  }

  return values;
}

export function extractCooCandidates(text: string, barcodes: OcrBarcode[]): string[] {
  const values: string[] = [];
  const barcodeSegments = parseBarcodeSegments(barcodes);
  const normalizedText = normalizeText(text);

  // 2-3 letter code
  const codeMatches = extractWithRegex(
    normalizedText,
    /\b(?:COO|COUNTRY\s+OF\s+ORIGIN)\s*[:\s]+([A-Z]{2,3})\b/g
  );
  for (const v of codeMatches) {
    if (!values.includes(v)) values.push(v);
  }

  // Made in ...
  const madeInMatches = extractWithRegex(
    normalizedText,
    /\bMADE\s+IN\s+([A-Z]{2,}|CHINA|SLOVENIA|JAPAN|INDIA|GERMANY|KOREA|MALAYSIA|INDONESIA|TAIWAN|THAILAND|VIETNAM|USA|AMERICA|SINGAPORE|PHILIPPINES)/g
  );
  for (const v of madeInMatches) {
    const upper = v.toUpperCase();
    const code = COUNTRY_NAME_TO_CODE[collapseSpaces(upper)];
    if (code && !values.includes(code)) values.push(code);
    if (!values.includes(upper)) values.push(upper);
  }

  // Barcode COO identifiers
  for (const segment of barcodeSegments.coo) {
    const cleaned = collapseSpaces(segment);
    if (cleaned.length >= 2 && !values.includes(cleaned)) values.push(cleaned);
  }

  return values;
}

export function extractCowCandidates(text: string, barcodes: OcrBarcode[]): string[] {
  const values: string[] = [];
  const barcodeSegments = parseBarcodeSegments(barcodes);
  const normalizedText = normalizeText(text);

  const explicit = extractWithRegex(normalizedText, /\b(?:COW|COW\s*CODE?)\s*[:\s]*([A-Z0-9\-]+)/g);
  for (const v of explicit) {
    const cleaned = collapseSpaces(v);
    if (cleaned.length >= 1) values.push(cleaned);
  }

  for (const segment of barcodeSegments.cow) {
    const cleaned = collapseSpaces(segment);
    if (cleaned.length >= 1 && !values.includes(cleaned)) values.push(cleaned);
  }

  return values;
}

interface ScoredTarget {
  target: string;
  score: number;
}

export function scoreTargetMatch(target: string, candidates: string[]): number {
  const normalizedTarget = collapseSpaces(normalizeText(target));
  const targetVariants = generateVariants(normalizedTarget);

  let bestScore = 0;

  for (const candidate of candidates) {
    const normalizedCandidate = collapseSpaces(normalizeText(candidate));

    // Exact match
    if (normalizedCandidate === normalizedTarget) {
      bestScore = Math.max(bestScore, 100);
      continue;
    }

    // Match after stripping common prefixes
    const strippedCandidate = stripSupplierPrefixes(normalizedCandidate);
    if (strippedCandidate === normalizedTarget) {
      bestScore = Math.max(bestScore, 95);
      continue;
    }

    // Variant match (O/0, I/1, etc.)
    const candidateVariants = generateVariants(normalizedCandidate);
    const variantMatch = candidateVariants.some((cv) =>
      targetVariants.some((tv) => cv === tv)
    );
    if (variantMatch) {
      bestScore = Math.max(bestScore, 80);
      continue;
    }

    // Contains / contained
    if (
      normalizedCandidate.includes(normalizedTarget) ||
      normalizedTarget.includes(normalizedCandidate)
    ) {
      bestScore = Math.max(bestScore, 50);
    }
  }

  return bestScore;
}

export function findBestItemMatches(targets: string[], candidates: string[]): string[] {
  const scored: ScoredTarget[] = targets.map((target) => ({
    target,
    score: scoreTargetMatch(target, candidates),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).map((s) => s.target);
}

/**
 * Parse a scanned label and identify which target part number it most likely represents.
 *
 * Matching priority:
 * 1. Barcodes / QR codes (exact, then stripped of supplier prefixes).
 * 2. OCR text (explicit labels, then token fallback, with OCR-error variants).
 *
 * When a part number is found, qty / COO / date code / lot code / COW candidates are
 * extracted from both barcodes and OCR text. Every candidate is returned in `options`;
 * `parsed` contains the best single guess for each field.
 *
 * @param capture - raw OCR text and barcodes from the native scanner
 * @param targets - one or more part numbers to match against
 */
export function parseAndIdentify(
  capture: RawOcrCapture,
  targets: string | string[]
): OcrParseResult {
  const targetArray = Array.isArray(targets) ? targets : [targets];
  const normalizedTargets = targetArray.map(normalizeText);

  const partNoCandidates = extractPartNoCandidates(capture.text, capture.barcodes);
  const rankedItemIds = findBestItemMatches(normalizedTargets, partNoCandidates);

  const matched = rankedItemIds.length > 0;
  const bestItemId = matched ? rankedItemIds[0] : null;

  const qtys = extractQtyCandidates(capture.text, capture.barcodes);
  const coos = extractCooCandidates(capture.text, capture.barcodes);
  const dateCodes = extractDateCodeCandidates(capture.text, capture.barcodes);
  const lotCodes = extractLotCodeCandidates(capture.text, capture.barcodes, bestItemId ?? undefined);
  const cows = extractCowCandidates(capture.text, capture.barcodes);

  return {
    matched,
    parsed: {
      itemId: bestItemId,
      qty: qtys[0],
      coo: coos[0],
      dateCode: dateCodes[0],
      lotCode: lotCodes[0],
      cow: cows[0],
    },
    options: {
      itemIds: rankedItemIds,
      qtys,
      coos,
      dateCodes,
      lotCodes,
      cows,
    },
    raw: capture,
  };
}
