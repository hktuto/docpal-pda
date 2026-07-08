# Picking — AI Scope and Remarks

## In scope

- List open picking orders.
- Show picking order detail with allocated lines.
- Confirm picks by quantity and source location.
- OCR-assisted picking via typed label input on the receiving detail Picking tab.
- Issue reporting for shortages/damages.
- Finish a picking order and create a measuring task.

## Out of scope

- Real camera barcode scanning (typed input / Android native rectangle detection only).
- Wave picking or batch picking across multiple orders.
- Pick-to-light or voice picking.
- Integration with external WMS/ERP.

## Key files

- `pages/picking/` — list and detail pages.
- `components/picking/` — picking-specific components.
- `composables/useLabelScan.ts` — label parsing.
- `composables/useScanMatchers.ts` — matching logic.
- `composables/useMockOcr.ts` — OCR normalization demo.
- `db/picking.ts` — picking DB helpers.
- `db/ocrPicking.ts` — OCR-assisted picking apply logic.
- `db/allocate.ts` — allocation creation.

## Known limitations

- Typed input simulates scanning; the Android native `RectangleDetection.scanLabel()` path is used in some camera flows but not all.
- Matching depends on normalized text and may require manual review.
- No backend validation; all logic runs client-side in PGlite.
- OCR scan candidate search (`findReceivingCandidates` / `findPickingCandidates`) is intentionally local-only in `composables/useScanMatchers.ts`; it is not exposed through `WarehouseService` and has no API equivalent.

## Related specs/plans

- `docs/superpowers/specs/2026-07-01-ocr-assisted-picking-design.md`
- `docs/superpowers/specs/2026-07-03-picking-issue-reporting-design.md`
- `docs/superpowers/specs/2026-07-03-package-level-picking-design.md`
