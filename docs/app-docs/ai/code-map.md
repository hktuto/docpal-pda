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

## Service layer (web data access)

Pages go through `WarehouseService` / `AuthService`, never the database directly.
The adapter is selected by `warehouseAdapter` in `nuxt.config.ts` (`"api"` default,
`"pglite"` for offline/demo); `apiBaseUrl` is env-overridable via
`NUXT_PUBLIC_API_BASE_URL`.

| Element | Source file |
|---------|-------------|
| `WarehouseService` interface + `createWarehouseService` | `services/warehouse.ts` |
| `AuthService` interface | `services/auth.ts` |
| Web DTOs | `services/types.ts` |
| HTTP adapter (default) | `services/adapters/apiWarehouse.ts`, `services/adapters/apiAuth.ts` |
| PGlite adapter (in-browser fallback) | `services/adapters/pgliteWarehouse.ts`, `services/adapters/pgliteAuth.ts` |
| HTTP fetch wrapper (error mapping to `I18nError`/`ApiError`) | `services/apiClient.ts` |
| Composable entry point | `composables/useWarehouse.ts` |

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
- `composables/useScanMatchers.ts` — candidate search (`findReceivingCandidates`, `findPickingCandidates`) goes through `WarehouseService.getScanCandidates` → `GET /receiving-orders/:id/scan-candidates` in api mode (pglite adapter: `db/ocrPicking.ts`); the matched write actions also go through `WarehouseService`.

## Database helpers

These `db/*.ts` helpers are called only by the PGlite adapter
(`services/adapters/pgliteWarehouse.ts`); in the default api mode the equivalent
logic lives in `apps/api/src/db/*.ts` behind the routes below.

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

## Warehouse API (apps/api)

### Endpoints

| Endpoint | Source file |
|----------|-------------|
| `GET /health` | `apps/api/src/routes/health.ts` |
| `PUT /receiving-orders/:external_id` | `apps/api/src/routes/receiving.ts` |
| `POST /receiving-orders/:external_id/confirm-arrival` | `apps/api/src/routes/receiving.ts` |
| `PUT /picking-orders/:external_id` | `apps/api/src/routes/picking.ts` |
| `POST /picking-orders/:id/scan` | `apps/api/src/routes/pickingExecution.ts` |
| `DELETE /picking-orders/:id/packages/:package_id` | `apps/api/src/routes/pickingExecution.ts` |
| `POST /picking-orders/:id/boxes` | `apps/api/src/routes/pickingExecution.ts` |
| `POST /picking-orders/:id/boxes/:box_id/cancel` | `apps/api/src/routes/pickingExecution.ts` |
| `POST /picking-orders/:id/boxes/:box_id/packages` | `apps/api/src/routes/pickingExecution.ts` |
| `POST /picking-orders/:id/boxes/:box_id/add-all-unboxed` | `apps/api/src/routes/pickingExecution.ts` |
| `DELETE /picking-orders/:id/boxes/:box_id/packages/:package_id` | `apps/api/src/routes/pickingExecution.ts` |
| `POST /picking-orders/:id/finish` | `apps/api/src/routes/pickingExecution.ts` |
| `POST /allocations/:id/scan` | `apps/api/src/routes/pickingExecution.ts` |
| `POST /packages/:id/add-to-box` | `apps/api/src/routes/pickingExecution.ts` |
| `DELETE /packages/:id` | `apps/api/src/routes/pickingExecution.ts` |
| `POST /packages/:id/verify` | `apps/api/src/routes/pickingExecution.ts` |
| `POST /shipping-boxes/:id/cancel?actor_id=` | `apps/api/src/routes/pickingExecution.ts` |
| `GET /picking-orders`, `GET /picking-orders/:id` | `apps/api/src/routes/pickingExecution.ts` |
| `GET /measuring-tasks` (with `total_items`/`packed_items` totals), `GET /measuring-tasks/:id` | `apps/api/src/routes/measuring.ts` |
| `POST /measuring-tasks/:id/complete` | `apps/api/src/routes/measuring.ts` |
| `PATCH /shipping-boxes/:id` | `apps/api/src/routes/boxes.ts` |
| `GET /shipping-boxes/:id/for-measuring` | `apps/api/src/routes/boxes.ts` |
| `POST /shipping-boxes/:id/verify-package` | `apps/api/src/routes/boxes.ts` |
| `POST /shipping-boxes/:id/close` | `apps/api/src/routes/boxes.ts` |
| `POST /shipping-boxes/:id/verify` | `apps/api/src/routes/boxes.ts` |
| `GET /verification-tasks`, `GET /verification-tasks/:id` | `apps/api/src/routes/verification.ts` |
| `POST /verification-tasks/:id/complete` | `apps/api/src/routes/verification.ts` |
| `GET /put-away/candidates` | `apps/api/src/routes/putAway.ts` |
| `GET /receiving-orders/:id/put-away-lots` | `apps/api/src/routes/putAway.ts` |
| `GET /receiving-orders/:id/put-away-scans` | `apps/api/src/routes/putAway.ts` |
| `GET /receiving-orders/:id/shelf-boxes` | `apps/api/src/routes/putAway.ts` |
| `POST /receiving-orders/:id/shelf-boxes` | `apps/api/src/routes/putAway.ts` |
| `DELETE /shelf-boxes/:id` | `apps/api/src/routes/putAway.ts` |
| `POST /put-away/scans` | `apps/api/src/routes/putAway.ts` |
| `POST /put-away/scans/:id/remove-piece` | `apps/api/src/routes/putAway.ts` |
| `POST /put-away/scans/:id/assign-to-box` | `apps/api/src/routes/putAway.ts` |
| `POST /shelf-boxes/:id/add-all-unboxed` | `apps/api/src/routes/putAway.ts` |
| `POST /put-away/scans/:id/remove-from-box` | `apps/api/src/routes/putAway.ts` |
| `POST /shelf-boxes/:id/close` | `apps/api/src/routes/putAway.ts` |
| `GET /shelves`, `GET /shelves/with-box-counts`, `GET /shelves/:code/boxes` | `apps/api/src/routes/goodsVerify.ts` |
| `GET /shelf-boxes/:id` | `apps/api/src/routes/goodsVerify.ts` |
| `POST /shelf-boxes/:id/verify-item` | `apps/api/src/routes/goodsVerify.ts` |
| `POST /auth/login`, `GET /auth/users/:id` | `apps/api/src/routes/auth.ts` |
| `POST /dev/reset` | `apps/api/src/routes/dev.ts` |
| `GET /receiving-orders`, `GET /receiving-orders/:id` | `apps/api/src/routes/receiving.ts` |
| `GET /receiving-orders/:id/picking` | `apps/api/src/routes/receiving.ts` |
| `POST /picking-items/transition-logs` | `apps/api/src/routes/receiving.ts` |
| `GET /receiving-orders/:id/scan-candidates` | `apps/api/src/routes/receiving.ts` |
| `GET /receiving-invoice-items/:id/mismatch`, `POST /receiving-invoice-items/:id/mismatches` | `apps/api/src/routes/mismatch.ts` |
| `PATCH /mismatches/:id`, `POST /mismatches/:id/confirm`, `POST /mismatches/:id/cancel` | `apps/api/src/routes/mismatch.ts` |
| `POST /picking-orders/report-issues` | `apps/api/src/routes/picking.ts` |
| `POST /picking-orders/:id/ocr-pick` | `apps/api/src/routes/picking.ts` |
| `GET /stock-search/suppliers`, `GET /stock-search/suppliers/:id/parts`, `GET /stock-search/parts/lots` | `apps/api/src/routes/stockSearch.ts` |
| `GET /suppliers/qr-templates` | `apps/api/src/routes/suppliers.ts` |

### Ingest helpers and triggers

| Helper | Source file |
|--------|-------------|
| Receiving upsert / confirm arrival | `apps/api/src/ingest/receiving.ts` |
| Picking upsert | `apps/api/src/ingest/picking.ts` |
| Part resolve/create | `apps/api/src/ingest/parts.ts` |
| Supplier resolve | `apps/api/src/ingest/suppliers.ts` |
| Transition log writer | `apps/api/src/ingest/transition.ts` |
| Allocation triggers (`allocateAll`, `allocatePickingOrder`) | `apps/api/src/db/allocate.ts` |
| Picking execution writes (scan, undo-scan, boxes, pack/unpack, finish, auto-finish → measuring task) | `apps/api/src/db/pickScan.ts` |
| Measuring + pre-shipment verification writes (box measurements, package verify, box close/verify, task completion) | `apps/api/src/db/measure.ts` |
| Put-away writes (scans, shelf-box lifecycle, lot materialization, receiving clear, cycle-count scheduling) | `apps/api/src/db/putAway.ts` |
| Cycle-count verification writes (`verifyShelfBoxItem`, `cycle_count` branch of `completeVerificationTask`) | `apps/api/src/db/putAway.ts`, `apps/api/src/db/measure.ts` |
| Pick-scan cycle-count hook (picking from a boxed lot schedules a recount and resets the box) | `apps/api/src/db/pickScan.ts` |
| Seed on empty + reset (`seedIfEmpty`, `resetAndReseed`; frozen `seedSql` + recompute + `allocateAll`) | `apps/api/src/db/seed.ts`, `apps/api/src/db/seedSql.ts` |
| Seed generator (replays web seed in PGlite, projects onto API schema) | `apps/web/scripts/export-api-seed.test.ts` |
| Receiving mismatch workflow (report/edit/confirm/cancel) | `apps/api/src/db/mismatch.ts` |
| Picking issue reporting | `apps/api/src/db/pickingIssues.ts` |
| OCR pick (FIFO link + `scanAllocation` from an in-hand receiving order) | `apps/api/src/db/ocrPick.ts` |

- Server entry: `apps/api/src/server.ts`; app wiring: `apps/api/src/index.ts`; DB bootstrap: `apps/api/src/db.ts`.
- confirm-arrival runs `allocateAll` after the order flips to `in_hand`; a picking upsert runs `allocatePickingOrder` when the upsert changed data. Both are best-effort and never roll back the committed write.
- All web pages (including `pages/put-away/` and `pages/goods-verify/`) go through `WarehouseService` → these HTTP endpoints by default (`warehouseAdapter: "api"`); the PGlite adapter path (`db/*.ts`) remains behind `warehouseAdapter: "pglite"`.

## Native Android app (apps/android)

The native rewrite lives in `apps/android` (package `com.docpal.warehousepda`);
an earlier `native-android/` scaffold listed in older revisions of this page
was superseded. Entry points:

| Element | Source file |
|---------|-------------|
| App entry / DI | `apps/android/app/src/main/java/com/docpal/warehousepda/App.kt`, `AppContainer.kt`, `MainActivity.kt` |
| Navigation | `apps/android/.../ui/navigation/` |
| Login / Home | `apps/android/.../ui/login/`, `apps/android/.../ui/home/` |
| Receiving list + detail (items & picking tabs, dialogs, scan launchers) | `apps/android/.../ui/receiving/` |
| Shared UI primitives | `apps/android/.../ui/components/` (`StatusBadge`, `EmptyState`, `DetailRow`, `ErrorText`, `OnResumeEffect`) |
| Room DB, entities, DAOs | `apps/android/.../data/db/`; repositories in `apps/android/.../data/` + `apps/android/.../domain/` |
| Scan pipeline | `apps/android/.../scanner/` (camera/OCR), `apps/android/.../domain/scan/` (parsers, matcher, wedge buffer), `ui/receiving/ScanLaunchers.kt` |
| JVM tests | `apps/android/app/src/test/...` (Robolectric; fixtures in `DbTestSupport.kt`) |

Full structure and conventions: root `AGENTS.md`, "Native Android app
(apps/android)", and the "Phase 2 handoff notes" in
`docs/superpowers/plans/2026-07-12-native-android-phase-1.md`.
