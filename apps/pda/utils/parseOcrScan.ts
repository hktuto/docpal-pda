import type { SupplierQrcodeTemplate } from "~/services/types";
import { toLabelDateCode, type DateCodeFormat } from "~/utils/dateCode";

const QTY_ENCODING_KOA_ZEROS = "koa_zeros";
const DATE_CODE_ENCODING_KOA_MONTH_COUNTER = "koa_month_counter";
const DATE_CODE_ENCODING_YYWW = "yyww";
const DATE_CODE_ENCODING_YYWWD = "yywwd";
const DATE_CODE_ENCODING_NCC_LOT_YMMDD = "ncc_lot_ymmdd";
const DATE_CODE_ENCODING_YMMDD = "ymmdd";
const DATE_CODE_ENCODING_YYYYMM_MIDMONTH = "yyyymm_midmonth";
const qrTemplateRegexCache = new Map<string, RegExp | null>();

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
  wclItemNo?: string;
  /** Supplier-template serial (e.g. iC-Haus LTS) — put-away duplicate check. */
  serialNo?: string;
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
  /** The supplier template that matched (QR path only) — manual receiving
   *  derives the task's single brand from it. */
  supplier?: { code: string; brands?: string[] };
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
  // Substitution branching is exponential in the number of replaceable chars;
  // cap it so long tokens (e.g. OCR lines joining two part numbers) cannot
  // blow up. Realistic part numbers stay far below this bound.
  const MAX_VARIANTS = 4096;

  function generate(index: number, current: string) {
    if (results.size >= MAX_VARIANTS) return;
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

  // Also try joining adjacent short tokens that may have been split (e.g. 'RK73H1ETTP 1001F')
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

export interface MultiItemRow {
  partNo: string;
  qty?: number;
}

/** One editable item row in the shared multi-item scan review table. */
export interface ScanMultiRow {
  partNo: string;
  qty: number | null;
}

/** Per-row result of a multi-row apply attempt, keyed by row index. */
export interface ScanMultiRowResult {
  index: number;
  ok: boolean;
  message?: string;
}

/**
 * Extract one row per item from a multi-item label (e.g. a carton label whose
 * items table lists several parts). Line-based: each OCR line containing a
 * candidate that matches one of `targets` contributes a row; the row's qty is
 * the first plausible quantity on the same line. Rows are merged by part
 * number, so a part repeated on a second line (e.g. "KOA/<partNo>") yields a
 * single row. The result is a best-effort starting point — the operator can
 * edit every row before applying.
 */
export function extractMultiItemRows(
  text: string,
  targets: string[],
  minMatchScore = 0
): MultiItemRow[] {
  // Thousands separators would split "36,000" into useless tokens.
  const cleaned = text.replace(/(\d),(\d{3})\b/g, "$1$2");
  const normalizedTargets = targets.map(normalizeText);
  const rows = new Map<string, MultiItemRow>();

  for (const line of cleaned.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const partNoCandidates = extractPartNoCandidates(line, []);
    const matches = findBestItemMatches(normalizedTargets, partNoCandidates)
      .filter((target) => scoreTargetMatch(target, partNoCandidates) >= minMatchScore);
    const partNo = matches[0];
    if (!partNo || rows.has(partNo)) continue;

    const qtys = extractQtyCandidates(line, []);
    rows.set(partNo, { partNo, qty: qtys[0] });
  }

  return [...rows.values()];
}

export interface PickingScanDraft {
  parsed: ParsedFields;
  options: CandidateOptions;
}

function mergeCandidateOptions(
  primary: CandidateOptions,
  fallback: CandidateOptions,
  partNo: string
): CandidateOptions {
  const merge = <T>(values: T[], fallbackValues: T[]) => [...new Set([...values, ...fallbackValues])];
  return {
    itemIds: merge([partNo, ...primary.itemIds], fallback.itemIds),
    qtys: merge(primary.qtys, fallback.qtys),
    coos: merge(primary.coos, fallback.coos),
    dateCodes: merge(primary.dateCodes, fallback.dateCodes),
    lotCodes: merge(primary.lotCodes, fallback.lotCodes),
    cows: merge(primary.cows, fallback.cows),
  };
}

/** Build the full-form picking review drafts. Strong line matches become
 * separate items; line fields are defaults and whole-label fields are only
 * fallback candidates. Fewer than two strong rows keeps whole-label parsing. */
export function extractPickingScanDrafts(
  capture: RawOcrCapture,
  targets: string[]
): PickingScanDraft[] {
  const whole = parseAndIdentify(capture, targets);
  const strongRows = extractMultiItemRows(capture.text, targets, 80);
  if (strongRows.length < 2) return [{ parsed: whole.parsed, options: whole.options }];

  const cleaned = capture.text.replace(/(\d),(\d{3})\b/g, "$1$2");
  const normalizedTargets = targets.map(normalizeText);
  const seen = new Set<string>();
  const drafts: PickingScanDraft[] = [];

  for (const line of cleaned.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const partNoCandidates = extractPartNoCandidates(line, []);
    const matches = findBestItemMatches(normalizedTargets, partNoCandidates)
      .filter((target) => scoreTargetMatch(target, partNoCandidates) >= 80);
    const partNo = matches[0];
    if (!partNo || seen.has(partNo)) continue;
    seen.add(partNo);

    const lineResult = parseAndIdentify({ text: line, barcodes: [] }, targets);
    const lineOptions = {
      ...lineResult.options,
      dateCodes: lineResult.options.dateCodes.filter(
        (code) => code !== String(lineResult.parsed.qty)
      ),
    };
    drafts.push({
      parsed: {
        ...lineResult.parsed,
        itemId: partNo,
        dateCode: lineOptions.dateCodes[0],
      },
      options: mergeCandidateOptions(lineOptions, whole.options, partNo),
    });
  }

  return drafts;
}

export function decodeKoaQty(encoded: string): number | undefined {
  if (!/^\d+$/.test(encoded)) return undefined;
  if (encoded.length < 2) return undefined;
  const zeroCount = Number(encoded.slice(-1));
  const prefix = encoded.slice(0, -1);
  if (!Number.isFinite(zeroCount) || zeroCount < 0) return undefined;
  const result = Number(prefix) * Math.pow(10, zeroCount);
  if (!Number.isFinite(result) || !Number.isInteger(result) || result <= 0) return undefined;
  return result;
}

/** ISO-8601 week number for a Date. */
function getIsoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/** ISO-8601 year for a Date (may differ from calendar year at year boundaries). */
function getIsoYear(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  return d.getUTCFullYear();
}

/** A month-counter period row (date_code_counter_periods). A counter value
 *  may belong to several periods (rotation era) — the decoder picks the
 *  latest candidate not in the future relative to the scan date.
 *  Keep in sync with apps/backend/src/db/scanParse.ts DateCodePeriod. */
export interface DateCodePeriod {
  encoding: string;
  direction: "forward" | "backward";
  counterFrom: number;
  counterTo: number;
  periodStart: string; // YYYY-MM-DD, always the first of a month
}

/** Built-in fallback periods (used when no fetched rows are at hand — unit
 *  tests, offline parsing); request paths pass the rows from
 *  GET /date-code-periods. The rolling counter 10→99 restarts every 90
 *  months, one row per cycle (anchors: 10 = 2025-12 … 99 = 2033-05; previous
 *  cycles 10 = 2018-06 … 99 = 2025-11 and 10 = 2010-12 … 99 = 2018-05); a
 *  rotation inserts the next cycle row. Keep in sync with
 *  apps/backend/src/db/scanParse.ts DEFAULT_KOA_PERIODS and the
 *  date_code_counter_periods seed rows. */
export const DEFAULT_KOA_PERIODS: DateCodePeriod[] = [
  { encoding: "koa_month_counter", direction: "forward", counterFrom: 10, counterTo: 99, periodStart: "2010-12-01" },
  { encoding: "koa_month_counter", direction: "forward", counterFrom: 10, counterTo: 99, periodStart: "2018-06-01" },
  { encoding: "koa_month_counter", direction: "forward", counterFrom: 10, counterTo: 99, periodStart: "2025-12-01" },
];

/** First-of-month Date `months` away from (year, month0 = 0-based). */
function monthAt(year: number, month0: number, months: number): Date {
  const total = year * 12 + month0 + months;
  return new Date(Math.floor(total / 12), ((total % 12) + 12) % 12, 1);
}

function parsePeriodStart(periodStart: string): { year: number; month0: number } | undefined {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(periodStart);
  if (!m) return undefined;
  return { year: Number(m[1]), month0: Number(m[2]) - 1 };
}

/**
 * Decode a KOA date-code field (template segment 5, e.g. "1625H713",
 * "5420Q156") to the label date code (per the flow config `dateCodeFormat` —
 * WWYY under the default "wwyy"; the YYWW pair swap under "yyww"). Take the leading digit run's
 * first 4 digits: the first 2 are a month counter mapped to a year/month
 * through the date_code_counter_periods rows (the rolling counter 10→99
 * restarts every 90 months — one forward row per cycle, e.g. 10 = 2025-12
 * … 99 = 2033-05); the last 2 are the day of month. A counter covered by
 * several cycle rows yields one candidate month per row — the latest one
 * not in the future relative to `referenceDate` (default: today) wins,
 * falling back to the earliest candidate when all are in the future. The raw
 * value stays the lot code.
 * Keep in sync with apps/backend/src/db/scanParse.ts decodeKoaDateCode.
 */
export function decodeKoaDateCode(
  raw: string,
  periods: DateCodePeriod[] = DEFAULT_KOA_PERIODS,
  referenceDate: Date = new Date(),
  dateCodeFormat: DateCodeFormat = "wwyy"
): string | undefined {
  // An empty fetched row list (GET /date-code-periods on a DB seeded before
  // the table existed) means "no rows at hand" — same as omitting the argument.
  if (!periods.length) periods = DEFAULT_KOA_PERIODS;
  const digits = raw.match(/^\d+/)?.[0];
  if (!digits || digits.length < 4) return undefined;
  const counter = Number(digits.slice(0, 2));
  const day = Number(digits.slice(2, 4));
  if (day < 1 || day > 31) return undefined;

  const candidates: Date[] = [];
  for (const p of periods) {
    if (p.encoding !== DATE_CODE_ENCODING_KOA_MONTH_COUNTER) continue;
    const lo = Math.min(p.counterFrom, p.counterTo);
    const hi = Math.max(p.counterFrom, p.counterTo);
    if (counter < lo || counter > hi) continue;
    const start = parsePeriodStart(p.periodStart);
    if (!start) continue;
    const offset = p.direction === "forward" ? counter - p.counterFrom : p.counterFrom - counter;
    candidates.push(monthAt(start.year, start.month0, offset));
  }
  if (candidates.length === 0) return undefined;

  const ref = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
  const pastOrPresent = candidates.filter((d) => d <= ref);
  const picked = pastOrPresent.length
    ? new Date(Math.max(...pastOrPresent.map((d) => d.getTime())))
    : new Date(Math.min(...candidates.map((d) => d.getTime())));
  const daysInMonth = new Date(picked.getFullYear(), picked.getMonth() + 1, 0).getDate();
  if (day > daysInMonth) return undefined;
  const date = new Date(picked.getFullYear(), picked.getMonth(), day);
  const week = getIsoWeek(date);
  const isoYear = getIsoYear(date);
  // Canonical YYWW → label format at this out boundary (spec 2026-10-22).
  const canonical = `${String(isoYear % 100).padStart(2, "0")}${String(week).padStart(2, "0")}`;
  return toLabelDateCode(canonical, dateCodeFormat) ?? undefined;
}

/**
 * Decode a YYWW date-code field (iC-Haus DC, e.g. "2337" = year 2023 week 37)
 * to the label date code (pair-swapped WWYY under the default "wwyy" label
 * format; identity under "yyww"). Returns undefined for non-4-digit input or
 * an invalid week.
 * Keep in sync with apps/backend/src/db/scanParse.ts decodeYywwDateCode.
 */
export function decodeYywwDateCode(raw: string, dateCodeFormat: DateCodeFormat = "wwyy"): string | undefined {
  if (!/^\d{4}$/.test(raw)) return undefined;
  const week = Number(raw.slice(2, 4));
  if (week < 1 || week > 53) return undefined;
  return toLabelDateCode(raw, dateCodeFormat) ?? undefined;
}

/**
 * Decode a TE Connectivity 5-digit YYWWD date code (DC field, e.g. "26374" =
 * year 2026 week 37 day 4) to the label date code — the trailing day digit is
 * dropped and the YYWW pair renders in the label format (pair-swapped WWYY
 * under the default "wwyy"; identity under "yyww"). Returns undefined for
 * non-5-digit input or an invalid week.
 * Keep in sync with apps/backend/src/db/scanParse.ts decodeYywwdDateCode.
 */
export function decodeYywwdDateCode(raw: string, dateCodeFormat: DateCodeFormat = "wwyy"): string | undefined {
  if (!/^\d{5}$/.test(raw)) return undefined;
  return decodeYywwDateCode(raw.slice(0, 4), dateCodeFormat);
}

/** Format a 13-digit NCC lot as its printed 5–7–2 digit groups. */
export function formatNccLotCode(raw: string): string {
  return /^\d{13}$/.test(raw) ? `${raw.slice(0, 5)}-0${raw.slice(5, 11)}-${raw.slice(11)}` : raw;
}

/**
 * Decode a YYYYMM month date code (ABLIC/SII $-reel labels, e.g. "202606")
 * to the label date code (WWYY under the default "wwyy" label format). The
 * label carries no day — the convention anchors the month on the 15th
 * ("202606" → 2026-06-15 → ISO week 25 → WWYY "2526"). Returns undefined for
 * non-6-digit input or an invalid month.
 * Keep in sync with apps/backend/src/db/scanParse.ts decodeYyyymmMidmonthDateCode.
 */
export function decodeYyyymmMidmonthDateCode(raw: string, dateCodeFormat: DateCodeFormat = "wwyy"): string | undefined {
  if (!/^\d{6}$/.test(raw)) return undefined;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  if (month < 1 || month > 12) return undefined;
  const date = new Date(year, month - 1, 15);
  const canonical = `${String(getIsoYear(date) % 100).padStart(2, "0")}${String(getIsoWeek(date)).padStart(2, "0")}`;
  return toLabelDateCode(canonical, dateCodeFormat) ?? undefined;
}

/** Decode the 13-digit NCC lot's YMMDD prefix to an ISO week date code.
 *  The one-digit year resolves to the latest matching year not after the scan
 *  year. Keep in sync with apps/backend/src/db/scanParse.ts decodeNccDateCode. */
export function decodeNccDateCode(
  raw: string,
  referenceDate: Date = new Date(),
  dateCodeFormat: DateCodeFormat = "wwyy"
): string | undefined {
  if (!/^\d{13}$/.test(raw)) return undefined;
  const referenceYear = referenceDate.getFullYear();
  let year = Math.floor(referenceYear / 10) * 10 + Number(raw[0]);
  if (year > referenceYear) year -= 10;
  const month = Number(raw.slice(1, 3));
  const day = Number(raw.slice(3, 5));
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  const canonical = `${String(getIsoYear(date) % 100).padStart(2, "0")}${String(getIsoWeek(date)).padStart(2, "0")}`;
  return toLabelDateCode(canonical, dateCodeFormat) ?? undefined;
}

/** Decode a 5-digit YMMDD date code (COPAL reel label: the leading digits of
 *  the serial field, e.g. "61013" = 2026-10-13) to an ISO week date code.
 *  The one-digit year resolves to the latest matching year not after the scan
 *  year (same rule as the NCC lot prefix). Keep in sync with
 *  apps/backend/src/db/scanParse.ts decodeYmmddDateCode. */
export function decodeYmmddDateCode(
  raw: string,
  referenceDate: Date = new Date(),
  dateCodeFormat: DateCodeFormat = "wwyy"
): string | undefined {
  if (!/^\d{5}$/.test(raw)) return undefined;
  const referenceYear = referenceDate.getFullYear();
  let year = Math.floor(referenceYear / 10) * 10 + Number(raw[0]);
  if (year > referenceYear) year -= 10;
  const month = Number(raw.slice(1, 3));
  const day = Number(raw.slice(3, 5));
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  const canonical = `${String(getIsoYear(date) % 100).padStart(2, "0")}${String(getIsoWeek(date)).padStart(2, "0")}`;
  return toLabelDateCode(canonical, dateCodeFormat) ?? undefined;
}

function getQrTemplateRegex(template: string): RegExp | null {
  if (qrTemplateRegexCache.has(template)) {
    return qrTemplateRegexCache.get(template)!;
  }

  try {
    const regex = new RegExp(template, "u");
    qrTemplateRegexCache.set(template, regex);
    return regex;
  } catch (error) {
    console.warn(`Invalid QR code template regex: ${template}`, error);
    qrTemplateRegexCache.set(template, null);
    return null;
  }
}

function extractNamedGroups(regex: RegExp, value: string): Record<string, string> | null {
  const match = regex.exec(value);
  if (!match || !match.groups) return null;
  return match.groups;
}

export interface ParseQrCaptureOptions {
  supplierTemplates: SupplierQrcodeTemplate[];
  targets?: string | string[];
  contextSupplierCode?: string;
  /**
   * Brands of the order being scanned (parts.brand per item). Templates whose
   * `brands` intersect are tried first; the rest stay as a fallback so
   * mixed-brand or unmapped-brand orders still parse.
   */
  contextBrands?: string[];
  /** Month-counter periods for koa_month_counter date-code decoding
   *  (GET /date-code-periods rows); defaults to DEFAULT_KOA_PERIODS. */
  dateCodePeriods?: DateCodePeriod[];
  /** Flow-config dateCodeFormat ("wwyy" default | "yyww") — decoded date
   *  codes are emitted in this label format (spec 2026-10-22 contract). */
  dateCodeFormat?: DateCodeFormat;
}

export function parseQrCapture(
  qrValue: string,
  options: ParseQrCaptureOptions
): OcrParseResult {
  const { supplierTemplates, targets = [], contextSupplierCode, contextBrands, dateCodePeriods, dateCodeFormat = "wwyy" } = options;
  const targetArray = Array.isArray(targets) ? targets : [targets];
  const normalizedQr = qrValue.trim();

  const brandSet = contextBrands?.length ? new Set(contextBrands) : null;
  const priority = (s: SupplierQrcodeTemplate): number => {
    if (contextSupplierCode && s.code === contextSupplierCode) return 0;
    if (brandSet && s.brands?.some((b) => brandSet.has(b))) return 1;
    return 2;
  };
  const orderedTemplates =
    contextSupplierCode || brandSet
      ? [...supplierTemplates].sort((a, b) => priority(a) - priority(b))
      : supplierTemplates;
  for (const supplier of orderedTemplates) {
    const regex = getQrTemplateRegex(supplier.qrcodeTemplate);
    if (!regex) continue;

    const groups = extractNamedGroups(regex, normalizedQr);
    if (!groups || !groups.itemId) continue;
    console.log("groups", groups)
    // COPAL OHM-spec trimmer labels carry the resistance code ("104" of
    // SM-3TW 104) in a resCode group after the model; parts.part_no stores
    // it, so append it to the item identity. Keep in sync with
    // apps/backend/src/db/scanParse.ts parseQrRaw.
    const normalizedItemId = collapseSpaces(
      (groups.resCode ? `${groups.itemId} ${groups.resCode}` : groups.itemId).toUpperCase()
    );
    const itemMatch =
      targetArray.length === 0 ||
      targetArray.some((t) => collapseSpaces(t.toUpperCase()) === normalizedItemId);

    if (!itemMatch) continue;
    let qty: number | undefined;
    if (groups.qty) {
      if (supplier.qrcodeQtyEncoding === QTY_ENCODING_KOA_ZEROS) {
        qty = decodeKoaQty(groups.qty);
      } else {
        const n = Number(groups.qty);
        if (Number.isInteger(n) && n > 0) qty = n;
      }
    }

    // KOA and NCC derive the date from the raw lot. Older templates may still
    // name KOA's segment dateCode — treat that as the lot code too. When both
    // groups exist (iC-Haus: AC = lot, DC = date), the date decodes from the
    // dateCode group. Without an encoding the dateCode group passes through.
    const rawLotCode = (groups.lotCode || groups.dateCode) ?? undefined;
    const rawDateCode = groups.dateCode || undefined;
    let dateCode: string | undefined;
    if (supplier.qrcodeDateCodeEncoding === DATE_CODE_ENCODING_KOA_MONTH_COUNTER) {
      dateCode = rawLotCode ? decodeKoaDateCode(rawLotCode, dateCodePeriods, new Date(), dateCodeFormat) : undefined;
    } else if (supplier.qrcodeDateCodeEncoding === DATE_CODE_ENCODING_YYWW) {
      dateCode = rawDateCode ? decodeYywwDateCode(rawDateCode, dateCodeFormat) : undefined;
    } else if (supplier.qrcodeDateCodeEncoding === DATE_CODE_ENCODING_YYWWD) {
      dateCode = rawDateCode ? decodeYywwdDateCode(rawDateCode, dateCodeFormat) : undefined;
    } else if (supplier.qrcodeDateCodeEncoding === DATE_CODE_ENCODING_NCC_LOT_YMMDD) {
      dateCode = rawLotCode ? decodeNccDateCode(rawLotCode, new Date(), dateCodeFormat) : undefined;
    } else if (supplier.qrcodeDateCodeEncoding === DATE_CODE_ENCODING_YMMDD) {
      dateCode = rawLotCode ? decodeYmmddDateCode(rawLotCode, new Date(), dateCodeFormat) : undefined;
    } else if (supplier.qrcodeDateCodeEncoding === DATE_CODE_ENCODING_YYYYMM_MIDMONTH) {
      dateCode = rawDateCode ? decodeYyyymmMidmonthDateCode(rawDateCode, dateCodeFormat) : undefined;
    } else {
      dateCode = rawDateCode;
    }
    const lotCode = supplier.qrcodeDateCodeEncoding === DATE_CODE_ENCODING_NCC_LOT_YMMDD && rawLotCode
      ? formatNccLotCode(rawLotCode)
      : rawLotCode;

    // Labels that print only the bare MPN (no wclItemNo group — ABLIC/SII
    // $-reel QRs) still reach parts.wcl_item_no when the profile covers
    // exactly one brand: derive "<brand>/<mpn>" (ABLIC parts are stored as
    // "ABLIC/S-812C33AMC-C2NT2U"). Multi-brand/unknown-brand profiles skip
    // the derivation. Keep in sync with apps/backend/src/db/scanParse.ts
    // deriveWclItemNo.
    const wclItemNo = groups.wclItemNo ||
      (supplier.brands?.length === 1 ? `${supplier.brands[0]}/${groups.itemId}` : undefined);

    return {
      matched: true,
      parsed: {
        itemId: normalizedItemId,
        qty,
        lotCode,
        dateCode,
        coo: groups.coo ?? undefined,
        cow: groups.cow ?? undefined,
        wclItemNo,
        serialNo: groups.serialNo ?? undefined,
      },
      options: {
        itemIds: [normalizedItemId],
        qtys: qty !== undefined ? [qty] : [],
        lotCodes: lotCode ? [lotCode] : [],
        dateCodes: dateCode ? [dateCode] : [],
        coos: groups.coo ? [groups.coo] : [],
        cows: groups.cow ? [groups.cow] : [],
      },
      raw: { text: qrValue, barcodes: [] },
      supplier: { code: supplier.code, brands: supplier.brands },
    };
  }

  return parseAndIdentify(
    { text: qrValue, barcodes: [{ value: qrValue, format: "4" }] },
    targets
  );
}
