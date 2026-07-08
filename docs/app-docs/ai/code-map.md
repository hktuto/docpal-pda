# Code Map

Page and component locations mapped to source files.

## Pages

| Page | Route | Source file |
|------|-------|-------------|
| Login | `/login` | `pages/login.vue` |
| Home / Menu | `/` | `pages/index.vue` |
| Picking list | `/picking` | `pages/picking/index.vue` |
| Picking detail | `/picking/:id` | `pages/picking/[id].vue` or equivalent |
| Receiving list | `/receiving` | `pages/receiving/index.vue` |
| Receiving detail | `/receiving/:id` | `pages/receiving/[id].vue` or equivalent |
| Put-away list | `/put-away` | `pages/put-away/index.vue` |
| Put-away detail | `/put-away/:id` | `pages/put-away/[id].vue` or equivalent |
| Measuring list | `/measuring` | `pages/measuring/index.vue` |
| Measuring detail | `/measuring/:id` | `pages/measuring/[id].vue` or equivalent |
| Goods verify list | `/goods-verify` | `pages/goods-verify/index.vue` |
| Goods verify detail | `/goods-verify/:id` | `pages/goods-verify/[id].vue` or equivalent |
| Stock Search | `/stock-search` | `pages/stock-search/index.vue` |

## Layouts and global UI

| UI element | Source file |
|------------|-------------|
| Default layout | `layouts/default.vue` |
| App header | `components/AppHeader.vue` |
| Language switcher | `components/LanguageSwitcher.vue` |
| Toast notifications | `components/ToastHost.vue`, `composables/useToast.ts` |
| Inline spinner | `components/InlineSpinner.vue` |

## Shared detail primitives

| Component | Source file |
|-----------|-------------|
| DetailHeader | `components/DetailHeader.vue` |
| DetailRow | `components/DetailRow.vue` |
| Status badge (inline) | `composables/useStatusBadge.ts` |
| EmptyState | `components/EmptyState.vue` |
| ScanFab | `components/ScanFab.vue` |

## Modals

| Modal | Source file |
|-------|-------------|
| LabelScanReviewModal | `components/LabelScanReviewModal.vue` |
| BoxMeasurementsModal | `components/BoxMeasurementsModal.vue` |
| ReportIssueModal | `components/ReportIssueModal.vue` |
| PickingIssueReportModal | `components/PickingIssueReportModal.vue` |
| SelectShelfDialog | `components/SelectShelfDialog.vue` |

## Put-away

| Component | Source file |
|-----------|-------------|
| Put-away lots panel | `components/put-away/PutAwayLotsPanel.vue` |
| Shelf boxes panel | `components/put-away/ShelfBoxesPanel.vue` |

## Scan / OCR flow

| Component / helper | Source file |
|--------------------|-------------|
| Review modal | `components/LabelScanReviewModal.vue` |
| Candidate chips UI | `components/CandidateChips.vue` |
| Scan orchestration | `composables/useLabelScan.ts` |
| Review state wrapper | `composables/useLabelScanReview.ts` |
| Matchers | `composables/useScanMatchers.ts` |
| OCR parser and candidate extraction | `utils/parseOcrScan.ts` |
| OCR result → `OcrInput` mapper | `composables/useLabelScan.ts` |
| OCR-assisted picking DB helpers | `db/ocrPicking.ts` |

- `composables/useLabelScan.ts` — orchestrates native scan; in browsers falls back to `window.prompt()` + JSON.
- `composables/useLabelScan.ts` — validates prompt JSON and converts it to `LabelScanCapture` in browser fallback mode.
- `composables/useScanMatchers.ts` — candidate search reads (`findReceivingCandidates`, `findPickingCandidates`) use `useDb()` and `db/ocrPicking.ts` directly; only the matched write actions go through `WarehouseService`.

## Database helpers

| Helper | Source file |
|--------|-------------|
| Schema definitions | `db/schema.ts` |
| Bootstrap / init | `db/init.ts` |
| Seed data | `db/seed.ts` |
| Picking | `db/picking.ts` |
| OCR-assisted picking | `db/ocrPicking.ts` |
| Receiving | `db/receiving.ts` |
| Receiving mismatch | `db/mismatch.ts` |
| Put-away | `db/putAway.ts` |
| Measuring | `db/measuring.ts` |
| Goods verify | `db/goodsVerify.ts` |
| Allocation | `db/allocate.ts` |
