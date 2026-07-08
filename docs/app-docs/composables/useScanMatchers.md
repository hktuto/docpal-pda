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
- `composables/useWarehouse.ts` — write actions (apply pick, record put-away scan, verify package, verify shelf box item).
- `db/ocrPicking.ts` — local candidate search helpers (`findReceivingCandidates`, `findPickingCandidates`).
- `services/types.ts` — shared DTOs (`OcrParseResult`, `ReceivingCandidate`, `PickingCandidate`).

## Architecture note

Candidate search reads stay local: `useScanMatchers.ts` imports `useDb()` and calls `findReceivingCandidates` / `findPickingCandidates` directly from `db/ocrPicking.ts`. Only the resulting write actions are routed through `WarehouseService` so they can be backed by either PGlite or a future API adapter.
