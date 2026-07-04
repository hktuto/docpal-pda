# useScanMatchers

`composables/useScanMatchers.ts`

Matches parsed label data against receiving invoice items and picking items.

## When to use

Use this composable when implementing OCR-assisted picking or any feature that must link a scanned label to database records.

## Main responsibilities

- Compare parsed fields to records.
- Return candidate matches with confidence.
- Handle ambiguity (multiple matches / no matches).

## Related files

- `composables/useLabelScan.ts`
- `db/ocrPicking.ts`
