# OCR Parse Helper Design

## Goal

Provide a single, testable helper that turns a raw label scan (OCR text + barcodes) into a ranked set of candidate values: part number, quantity, COO, date code, lot code, and COW.

The helper is intentionally decoupled from UI and database code so it can be unit-tested in isolation and reused once the scan flows are ready for integration.

## Background

The current scan pipeline (`useLabelScan` → `useRecognizedTextParser` → `useScanMatchers`) only parses OCR text and requires exact part-number matches. Real supplier labels often:

- Prefix part numbers with supplier codes (`KOA+RK73H1ETTP1001F`).
- Split part numbers across spaces (`RK73H1ETTP 1001F`).
- Encode the same data in barcodes/QR codes that the native layer already returns.
- Print quantity, date, or lot values without explicit labels.
- Suffer from OCR digit/letter confusion (`O` read as `0`, etc.).

## Scope

- New helper: `utils/parseOcrScan.ts`.
- Unit tests: `tests/parseOcrScan.test.ts`.
- No integration into existing scan pages or composables in this change.

## API

```ts
interface RawOcrCapture {
  text: string;
  barcodes: Array<{ value: string; format: string }>;
}

interface ParsedFields {
  itemId: string | null;
  qty?: number;
  coo?: string;
  dateCode?: string;
  lotCode?: string;
  cow?: string;
}

interface CandidateOptions {
  itemIds: string[];
  qtys: number[];
  coos: string[];
  dateCodes: string[];
  lotCodes: string[];
  cows: string[];
}

interface OcrParseResult {
  matched: boolean;
  parsed: ParsedFields;
  options: CandidateOptions;
  raw: RawOcrCapture;
}

function parseAndIdentify(
  capture: RawOcrCapture,
  targets: string | string[]
): OcrParseResult;
```

`targets` is the list of candidate part numbers for the current flow (e.g., items in the receiving order). The caller decides which parts are relevant.

## Matching strategy

### 1. Barcodes first

Barcodes are far more reliable than OCR. The helper:

- Parses GS1/ANSI-style composite barcodes: `(P)PART(Q)5000(D)2544`.
- Strips supplier prefixes: `KOA+RK73B1JTTD181G` → `RK73B1JTTD181G`.
- Falls back to treating a whole barcode value as a part number if it looks like one.

### 2. OCR text fallback

If barcodes do not identify the part, the helper scans OCR text:

- Explicit labels: `(P)CUSTOMER P/N:`, `TYPE:`, `QTY:`, `DATE CODE:`, `LOT:`, etc.
- Token fallback: any token that looks like a part number.
- Joined-token fallback: adjacent tokens are merged to recover split part numbers.
- OCR-error variants: generates substitution variants for `0/O`, `1/I/L`, `2/Z`, `5/S`, `8/B`.

### 3. Field candidate extraction

For each field, candidates are collected from both barcodes and OCR text:

| Field | Sources |
|-------|---------|
| qty | `QTY:` / `Q:` labels, `5000 pcs`, barcode `Q5000`, pure numeric barcodes, bare integers |
| dateCode | `DATE CODE:`, barcode `(D)`, ISO dates (`2025-10-29`), 4–8 digit sequences |
| lotCode | `LOT:`, `(1T)TRACE CODE:`, barcode `(L)/(T)`, leftover alphanumeric tokens |
| coo | `COO:`, `Made in Slovenia` → `SI`, barcode `(COO)` |
| cow | `COW:`, barcode `(COW)` |

`options` arrays are ordered by confidence. `parsed` picks the first item of each array as the best guess.

## Fuzzy scoring

Target part numbers are scored against candidates:

| Match type | Score |
|------------|-------|
| Exact | 100 |
| After stripping supplier prefix | 95 |
| OCR variant (`O`↔`0`, etc.) | 80 |
| Contains / contained | 50 |

Only targets with a score > 0 are returned in `options.itemIds`, sorted best-first. If the array is empty, `matched` is `false`.

## Handling unlabeled values

When a label prints values without field names, the helper uses heuristics:

- Any 2+ digit integer is a quantity candidate.
- Any `YYYY-MM-DD` string is a date-code candidate.
- Any 4–8 digit sequence is a date-code candidate.
- Alphanumeric tokens that are not substrings of the matched part number are lot-code candidates.

These heuristics can produce false positives, which is why every field returns an `options` array rather than a single value.

## Integration notes

Future scan-flow integration should:

1. Pass the relevant part numbers as `targets` (e.g., items of the active receiving order).
2. Use `result.parsed` for auto-apply when confidence is high.
3. Use `result.options` to populate a review/choice modal when multiple candidates exist.
4. Preserve `result.raw` for manual input and mismatch reporting.

## Testing

Tests are written with Vitest and cover:

- Barcode exact match and supplier-prefix stripping.
- OCR exact match, space-joined part numbers, and OCR substitution errors.
- GS1 composite barcodes.
- Labeled and unlabeled quantity, date, lot, COO, and COW extraction.
- Multiple-target ranking and empty input.

Run with:

```bash
pnpm test
```
