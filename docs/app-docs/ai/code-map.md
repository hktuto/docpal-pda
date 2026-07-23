# Code Map

Page and component locations mapped to source files.

## Pages

| Page | Route | Source file |
|------|-------|-------------|
| Login | `/login` | `pages/login.vue` |
| Home / Menu | `/` | `pages/index.vue` |
| Picking list | `/picking` | `pages/picking/index.vue` |
| Picking detail | `/picking/:id` | `pages/picking/[id].vue` or equivalent |
| Picking scan session ("checkout") | `/picking/scan/:id` | `pages/picking/scan/[id].vue` |
| Receiving list | `/receiving` | `pages/receiving/index.vue` |
| Receiving detail | `/receiving/:id` | `pages/receiving/[id].vue` or equivalent |
| Put-away list | `/put-away` | `pages/put-away/index.vue` |
| Put-away detail | `/put-away/:id` | `pages/put-away/[id].vue` or equivalent |
| Measuring list | `/measuring` | `pages/measuring/index.vue` |
| Measuring task detail | `/measuring/:id` | `pages/measuring/[id].vue` |
| Measuring box | `/measuring/:taskId/box/:boxId` | `pages/measuring/[taskId]/box/[boxId].vue` |
| Goods verify queue | `/goods-verify` | `pages/goods-verify/index.vue` |
| Goods verify detail | `/goods-verify/:id` | `pages/goods-verify/[id].vue` |
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
| ReceivingScanReviewModal | `components/receiving/ReceivingScanReviewModal.vue` |
| ReceivingScanMultiItemModal | `components/receiving/ReceivingScanMultiItemModal.vue` |
| PickingScanReviewModal | `components/picking/PickingScanReviewModal.vue` |
| ScanMultiItemModal | `components/ScanMultiItemModal.vue` |
| BoxMeasurementsModal | `components/BoxMeasurementsModal.vue` |
| ReportIssueModal | `components/ReportIssueModal.vue` |
| PickingIssueReportModal | `components/PickingIssueReportModal.vue` |
| SelectShelfDialog | `components/SelectShelfDialog.vue` |

## Put-away

| Component | Source file |
|-----------|-------------|
| Put-away lots panel | `components/put-away/PutAwayLotsPanel.vue` |
| Shelf boxes panel | `components/put-away/ShelfBoxesPanel.vue` |

## Picking

| Component | Source file |
|-----------|-------------|
| Items section | `components/picking/PickingItemsSection.vue` |
| Boxes section | `components/picking/PickingBoxesSection.vue` |
| Issue banner | `components/picking/PickingIssueBanner.vue` |

## Receiving

| Component | Source file |
|-----------|-------------|
| Items tab | `components/receiving/ReceivingItemsTab.vue` |
| Picking tab | `components/receiving/ReceivingPickingTab.vue` |
| Scan review modal | `components/receiving/ReceivingScanReviewModal.vue` |
| Multi-item scan review modal | `components/receiving/ReceivingScanMultiItemModal.vue` |

## Service layer (web data access)

Pages go through `WarehouseService` / `AuthService`, never the network
directly. There is exactly one adapter: HTTP to `apps/backend` (default
`http://localhost:3002`), env-overridable via `NUXT_PUBLIC_API_BASE_URL`.
The old `warehouseAdapter` config switch, the PGlite adapter, the `apps/api`
adapter, and `apps/web/db/` were removed in the 2026-07 migration.

| Element | Source file |
|---------|-------------|
| `WarehouseService` interface + `createWarehouseService` | `services/warehouse.ts` |
| `AuthService` interface | `services/auth.ts` |
| Web DTOs (mirror backend responses) | `services/types.ts` |
| HTTP adapter (warehouse) | `services/adapters/backendWarehouse.ts` |
| HTTP adapter (auth) | `services/adapters/apiAuth.ts` |
| HTTP fetch wrapper (error mapping to `I18nError`/`ApiError`) | `services/apiClient.ts` |
| Composable entry point | `composables/useWarehouse.ts` |

## Scan / OCR flow

| Component / helper | Source file |
|--------------------|-------------|
| Review modal (picking / put-away / measuring) | `components/LabelScanReviewModal.vue` |
| Review modal (receiving candidates) | `components/receiving/ReceivingScanReviewModal.vue` |
| Candidate chips UI | `components/CandidateChips.vue` |
| Scan orchestration | `composables/useLabelScan.ts` |
| Receiving scan submission (server-side match, 409 → review) | `composables/useReceivingScan.ts` |
| Review state wrapper | `composables/useLabelScanReview.ts` |
| Client-side matchers (picking / put-away / measuring) | `composables/useScanMatchers.ts` |
| Picking page work lock (acquire/refresh/release + held-by state) | `composables/usePickingWorkLock.ts` |
| OCR/QR parser and candidate extraction | `utils/parseOcrScan.ts` |
| Mismatch form validation (pure) | `utils/mismatch.ts` |

- `composables/useLabelScan.ts` — orchestrates native scan; in browsers falls back to `window.prompt()` + JSON.
- `composables/useLabelScan.ts` — validates prompt JSON and converts it to a capture in browser fallback mode; supplier QR templates come from `GET /scan-templates` via `WarehouseService.getSupplierQrTemplates`.
- `composables/useReceivingScan.ts` — sends the raw label to `POST /receiving-orders/:id/scan`; on 409 `{message, candidates}` it opens the review modal, and picking a candidate resends with explicit `{partNo, qty}`. A raw label that parses into 2+ item rows (`extractMultiItemRows`) opens the multi-item table modal instead, and `applyRows` applies one explicit `{partNo, qty}` scan per row.
- `composables/useScanMatchers.ts` — client-side validation for picking (`matchPicking`), put-away (`matchPutAway`), and measuring (`matchMeasuring`); the apply actions go through `WarehouseService`.

## Warehouse backend (apps/backend)

Hono routes in `apps/backend/src/routes/` over tx-wrapped domain modules in
`apps/backend/src/db/`. Authoritative endpoint reference:
`docs/backend/api-design.md`.

| Endpoint group | Source file |
|----------------|-------------|
| `GET /health` | `apps/backend/src/routes/health.ts` |
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/users/:id` | `apps/backend/src/routes/auth.ts` |
| `GET /receiving-orders`, `GET /receiving-orders/:id` (+`/picking`, +`/put-away`) | `apps/backend/src/routes/receiving.ts` |
| `POST /receiving-orders/:id/confirm-arrival`, `POST /receiving-orders/:id/scan` | `apps/backend/src/routes/receiving.ts` |
| `GET|POST|PATCH /receiving-invoice-items/:id/mismatch`, `POST .../mismatch/confirm|cancel` | `apps/backend/src/routes/receiving.ts` |
| `GET /picking-orders`, `GET /picking-orders/:id`, `POST /picking-orders/:id/finish`, `POST /picking-orders/report-issues` | `apps/backend/src/routes/picking.ts` |
| `POST /picking-items/:id/scan`, `/packages/:id*` verbs, `/shipping-boxes/:id*` lifecycle | `apps/backend/src/routes/picking.ts` |
| `GET /put-away/candidates`, `POST /receiving-orders/:id/put-away-scans`, `DELETE /put-away-scans/:scanId`, `/shelf-boxes*` lifecycle (create / cancel / assign-scan / remove-scan / add-all-unboxed / close) | `apps/backend/src/routes/putaway.ts` |
| `GET /measuring-tasks`, `GET /measuring-tasks/:id`, `POST /measuring-tasks/:id/complete` | `apps/backend/src/routes/measuring.ts` |
| `POST /goods-verify-tasks/generate`, `GET /goods-verify-tasks`, `GET /goods-verify-tasks/:id`, `POST /goods-verify-tasks/:id/verify` | `apps/backend/src/routes/goodsverify.ts` |
| `GET /stock-search` | `apps/backend/src/routes/stocksearch.ts` |
| `GET /scan-templates` | `apps/backend/src/routes/scantemplates.ts` |
| `PUT /receiving-orders/:externalId`, `PUT /picking-orders/:externalId` | `apps/backend/src/routes/ingest.ts` |
| `POST /dev/reset`, `POST /dev/allocate` | `apps/backend/src/routes/dev.ts` |
| `/admin/*` master-data CRUD | `apps/backend/src/routes/admin/` |

### Domain modules

| Helper | Source file |
|--------|-------------|
| Receiving reads/writes, scan matching, mismatch lifecycle | `apps/backend/src/db/receiving.ts` |
| Label parsing for receiving scans (QR templates, serial extraction) | `apps/backend/src/db/scanParse.ts` |
| Picking execution (scan, packages, boxes, finish, issues) | `apps/backend/src/db/picking.ts` |
| Put-away (scans, shelf boxes, lot materialization, auto-clear) | `apps/backend/src/db/putaway.ts` |
| Measuring (task reads, completion) | `apps/backend/src/db/measuring.ts` |
| Goods verify (generation, queue, verify with ADJUST) | `apps/backend/src/db/goodsverify.ts` |
| Stock search | `apps/backend/src/db/stocksearch.ts` |
| Ingest upserts | `apps/backend/src/db/ingest.ts` |
| Allocation engine (`allocateAll`) | `apps/backend/src/db/allocate.ts` |
| Demo seed | `apps/backend/src/db/seed.ts` |

- Server entry / app wiring: `apps/backend/src/index.ts` (migrations auto-apply on startup; seed runs when `users` is empty unless `WAREHOUSE_SEED=off`).
- All web pages go through `WarehouseService` → these HTTP endpoints.
- The retired `apps/api` (:3001) routes are gone from the web app's runtime path; the package remains in the repo for history (see `apps/api/README.md`).

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
| Picking list + detail (search, batch issue report, boxes, logs, scan-to-pick) | `apps/android/.../ui/picking/`, `domain/PickingRepository.kt` |
| Put-away candidate list + detail (lots, shelf boxes, scan-to-put-away, auto-clear) | `apps/android/.../ui/putaway/`, `domain/PutAwayRepository.kt` |
| Goods verify shelf list + box list + box detail (scan-to-verify, mark verified) | `apps/android/.../ui/goodsverify/`, `domain/GoodsVerifyRepository.kt`, `data/db/GoodsVerifyDao.kt`, `domain/model/GoodsVerifyModels.kt` |
| Shared UI primitives | `apps/android/.../ui/components/` (`StatusBadge`, `EmptyState`, `DetailRow`, `ErrorText`, `OnResumeEffect`) |
| Room DB, entities, DAOs | `apps/android/.../data/db/`; repositories in `apps/android/.../data/` + `apps/android/.../domain/` |
| Scan pipeline | `apps/android/.../scanner/` (camera/OCR), `apps/android/.../domain/scan/` (parsers, `ScanMatcher.matchReceiving`/`matchPicking`/`matchPutAway`/`matchGoodsVerify`, wedge buffer), `ui/receiving/ScanLaunchers.kt`, `ui/scan/LabelScanReviewDialog.kt` |
| JVM tests | `apps/android/app/src/test/...` (Robolectric; fixtures in `DbTestSupport.kt`) |

Full structure and conventions: root `AGENTS.md`, "Native Android app
(apps/android)", and the handoff notes in
`docs/superpowers/plans/2026-07-12-native-android-phase-1.md` ("Phase 2
handoff notes"), `docs/superpowers/plans/2026-07-12-native-android-phase-2.md`
("Phase 3 handoff notes"), and
`docs/superpowers/plans/2026-07-12-native-android-phase-3.md` ("Phase 4
handoff notes").
