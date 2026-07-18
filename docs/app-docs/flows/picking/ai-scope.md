# Picking — AI Scope and Remarks

## In scope

- List picking orders with a status filter and text search; multi-select
  batch issue reporting.
- Show picking order detail as one nested read: order (incl. issue fields
  and its measuring task), items → allocations (with lot or receiving-area
  source) and packages, plus the shipping boxes.
- Scan-to-pick: the operator pre-selects an allocation row, scans a label
  (validated client-side against supplier QR templates), and the app calls
  `POST /picking-items/:id/scan {allocationId, qty, ...batch overrides}`.
- Package and shipping-box operations: remove (undo-scan) / verify packages,
  create / cancel / close boxes, add/remove packages, add-all-unboxed;
  box sizes and weights in integer grams.
- Finish a picking order manually, or automatically when the last package
  is boxed — finishing creates a measuring task.
- Per-order issue reporting (`POST /picking-orders/report-issues`).

## Out of scope

- Real camera barcode scanning (typed input / Android native rectangle detection only).
- Wave picking or batch picking across multiple orders.
- Pick-to-light or voice picking.
- Integration with external WMS/ERP.
- Server-side picking-scan matching — the current UX pre-selects the
  allocation, so client-side template validation is sufficient.

## Key files

- `pages/picking/index.vue` — list page (search, status filter, batch issue
  report dialog).
- `pages/picking/[id].vue` — detail page (items/allocations/packages,
  boxes, logs, scan-to-pick, finish).
- `components/picking/PickingItemsSection.vue`,
  `components/picking/PickingBoxesSection.vue`,
  `components/picking/PickingIssueBanner.vue` — detail sub-views.
- `components/PickingIssueReportModal.vue` — batch issue report dialog.
- `composables/useLabelScan.ts` + `utils/parseOcrScan.ts` — label parsing
  (QR templates from `GET /scan-templates`, OCR fallback).
- `composables/useScanMatchers.ts` — client-side `matchPicking` validation;
  apply calls `WarehouseService.scanPickingItem`.
- `services/adapters/backendWarehouse.ts` — picking + shipping-box methods.
- `apps/backend/src/routes/picking.ts` + `apps/backend/src/db/picking.ts` —
  `GET /picking-orders`, `GET /picking-orders/:id`,
  `POST /picking-items/:id/scan`, `/packages/:id` verbs,
  `/shipping-boxes/:id*` lifecycle, `POST /picking-orders/:id/finish`
  (→ measuring task), `POST /picking-orders/report-issues`.
- `apps/backend/src/routes/ingest.ts` + `apps/backend/src/db/ingest.ts` —
  `PUT /picking-orders/:externalId` upsert; a changed upsert triggers
  allocation.

## Known limitations

- **Allocation ids are unstable between scan and boxing:** post-scan
  `allocateAll` rebuilds an item's allocation rows with new ids until its
  packages are boxed, so the detail page re-fetches after every scan/box
  mutation instead of caching allocation ids (documented in
  `docs/backend/README.md`).
- Typed input simulates scanning; the Android native
  `RectangleDetection.scanLabel()` path is used in some camera flows but
  not all.
- Matching depends on normalized text and may require manual review.

## Related specs/plans

- `docs/backend/api-design.md` §Picking
- `docs/superpowers/specs/2026-07-01-ocr-assisted-picking-design.md`
- `docs/superpowers/specs/2026-07-03-picking-issue-reporting-design.md`
- `docs/superpowers/specs/2026-07-03-package-level-picking-design.md`
- `docs/superpowers/specs/2026-07-10-allocation-box-remark-design.md`
- `docs/superpowers/plans/2026-07-12-picking-execution.md`
