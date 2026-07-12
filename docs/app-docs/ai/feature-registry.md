# Feature Registry

Machine-readable index of features in the warehouse PDA demo. Use this page to locate implementation files and scope notes.

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Picking list | Picking | Shipped | `pages/picking/index.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking detail | Picking | Shipped | `pages/picking/[id].vue` or equivalent | [ai-scope](../flows/picking/ai-scope.md) |
| OCR-assisted picking | Picking / Receiving | Shipped | `composables/useLabelScan.ts`, `composables/useScanMatchers.ts`, `services/warehouse.ts`, `components/LabelScanReviewModal.vue`, `utils/parseOcrScan.ts`, `components/CandidateChips.vue`; apply logic: `db/ocrPicking.ts` (pglite adapter) / `apps/api/src/db/ocrPick.ts` (api) | [ai-scope](../flows/picking/ai-scope.md) |
| OCR scan candidate search | Picking / Receiving | Shipped | `composables/useScanMatchers.ts` → `WarehouseService.getScanCandidates` → `GET /receiving-orders/:id/scan-candidates` in `apps/api/src/routes/receiving.ts` (pglite adapter: `db/ocrPicking.ts`) | [useScanMatchers](../composables/useScanMatchers.md) |
| Picking issue reporting | Picking | Shipped | `components/PickingIssueReportModal.vue`, `components/ReportIssueModal.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Receiving list | Receiving | Shipped | `pages/receiving/index.vue` | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving detail | Receiving | Shipped | `pages/receiving/[id].vue` or equivalent | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving mismatch | Receiving | Shipped | `components/ReportIssueModal.vue`, `db/mismatch.ts`, `db/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Pending picking count badge | Receiving | Shipped | `pages/receiving/index.vue`, `db/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Put-away list | Put-away | Shipped | `pages/put-away/index.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Put-away detail | Put-away | Shipped | `pages/put-away/[id].vue`, `components/put-away/PutAwayLotsPanel.vue`, `components/put-away/ShelfBoxesPanel.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Shelf selection | Put-away | Shipped | `components/SelectShelfDialog.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Measuring list | Measuring | Shipped | `pages/measuring/index.vue`, `services/warehouse.ts`, `services/adapters/apiWarehouse.ts` / `pgliteWarehouse.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Measuring detail | Measuring | Shipped | `pages/measuring/[id].vue`, `services/warehouse.ts`, `services/adapters/apiWarehouse.ts` / `pgliteWarehouse.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Box measurements | Measuring | Shipped | `components/BoxMeasurementsModal.vue`, `services/warehouse.ts`, `services/adapters/apiWarehouse.ts` / `pgliteWarehouse.ts`, `db/measuring.ts` (pglite only) | [ai-scope](../flows/measuring/ai-scope.md) |
| Goods verify list | Goods Verify | Shipped | `pages/goods-verify/index.vue` | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Goods verify detail | Goods Verify | Shipped | `pages/goods-verify/[id].vue` or equivalent | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Stock Search | — | Shipped | `pages/stock-search/index.vue`, `db/stockSearch.ts` | [ai-scope](../flows/stock-search/ai-scope.md) |
| Login | Auth | Shipped | `pages/login.vue`, `composables/useAuth.ts` | [roles](../concepts/roles.md) |
| Language switcher | Shared | Shipped | `components/LanguageSwitcher.vue`, `app.vue`, `i18n/` | [navigation](../concepts/navigation.md) |
| Toast notifications | Shared | Shipped | `components/ToastHost.vue`, `composables/useToast.ts` | [picking ai-scope](../flows/picking/ai-scope.md) |
| Service adapter layer | Shared | Shipped | `services/warehouse.ts` (`WarehouseService` interface), `services/auth.ts` (`AuthService`), `services/adapters/apiWarehouse.ts` + `apiAuth.ts` (HTTP impl, default), `services/adapters/pgliteWarehouse.ts` + `pgliteAuth.ts` (in-browser fallback), `services/apiClient.ts` (fetch wrapper), `services/types.ts` (web DTOs), `composables/useWarehouse.ts` (adapter switch via `warehouseAdapter` runtime config) | root `AGENTS.md` |

Pages and components never query the database directly (except the pure `validateMismatchInputs` helper in `components/ReportIssueModal.vue`): they call `WarehouseService` / `AuthService`, which route to the HTTP API by default (`warehouseAdapter: "api"`) or to in-browser PGlite (`warehouseAdapter: "pglite"`). The `db/*.ts` helpers below are now exercised only by the PGlite adapter.

## Warehouse API (apps/api)

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Receiving order ingestion | Receiving | Shipped | `PUT /receiving-orders/:external_id` in `apps/api/src/routes/receiving.ts`, `apps/api/src/ingest/receiving.ts`, `apps/api/src/ingest/parts.ts`, `apps/api/src/ingest/suppliers.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Confirm arrival + allocation trigger | Receiving | Shipped | `POST /receiving-orders/:external_id/confirm-arrival` in `apps/api/src/routes/receiving.ts`, `apps/api/src/ingest/receiving.ts`, `apps/api/src/ingest/transition.ts`; triggers `allocateAll` in `apps/api/src/db/allocate.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Picking order ingestion + allocation trigger | Picking | Shipped | `PUT /picking-orders/:external_id` in `apps/api/src/routes/picking.ts`, `apps/api/src/ingest/picking.ts`, `apps/api/src/ingest/parts.ts`; triggers `allocatePickingOrder` in `apps/api/src/db/allocate.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking execution — scan & undo-scan | Picking | Shipped | `POST /picking-orders/:id/scan`, `DELETE /picking-orders/:id/packages/:package_id` in `apps/api/src/routes/pickingExecution.ts`, `apps/api/src/db/pickScan.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking execution — box & pack ops | Picking | Shipped | `POST /picking-orders/:id/boxes`, `POST /picking-orders/:id/boxes/:box_id/cancel`, `POST /picking-orders/:id/boxes/:box_id/packages`, `POST /picking-orders/:id/boxes/:box_id/add-all-unboxed`, `DELETE /picking-orders/:id/boxes/:box_id/packages/:package_id` in `apps/api/src/routes/pickingExecution.ts`, `apps/api/src/db/pickScan.ts`; packing the last package auto-finishes the order and creates a measuring task | [ai-scope](../flows/picking/ai-scope.md) |
| Picking order finish | Picking | Shipped | `POST /picking-orders/:id/finish` in `apps/api/src/routes/pickingExecution.ts`, `apps/api/src/db/pickScan.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Flat mutation routes (web adapter) | Picking / Measuring | Shipped | `POST /allocations/:id/scan`, `POST /packages/:id/add-to-box`, `DELETE /packages/:id`, `POST /packages/:id/verify`, `POST /shipping-boxes/:id/cancel?actor_id=` in `apps/api/src/routes/pickingExecution.ts` — used by `apps/web/services/adapters/apiWarehouse.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking order list/detail API | Picking | Shipped | `GET /picking-orders`, `GET /picking-orders/:id` in `apps/api/src/routes/pickingExecution.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Measuring task list/detail API | Measuring | Shipped | `GET /measuring-tasks` (with `total_items`/`packed_items` totals), `GET /measuring-tasks/:id` in `apps/api/src/routes/measuring.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Measuring task completion | Measuring | Shipped | `POST /measuring-tasks/:id/complete` in `apps/api/src/routes/measuring.ts`, `apps/api/src/db/measure.ts`; auto-creates a `pre_shipment` verification task | [ai-scope](../flows/measuring/ai-scope.md) |
| Shipping box measuring execution | Measuring | Shipped | `PATCH /shipping-boxes/:id`, `GET /shipping-boxes/:id/for-measuring`, `POST /shipping-boxes/:id/verify-package`, `POST /shipping-boxes/:id/close` in `apps/api/src/routes/boxes.ts`, `apps/api/src/db/measure.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Pre-shipment box verification | Goods Verify | Shipped | `POST /shipping-boxes/:id/verify` in `apps/api/src/routes/boxes.ts`, `apps/api/src/db/measure.ts`; box `closed → verified` | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Verification task API | Goods Verify | Shipped | `GET /verification-tasks` (filters: `kind`, `status`, `since`, `due_before`), `GET /verification-tasks/:id`, `POST /verification-tasks/:id/complete` in `apps/api/src/routes/verification.ts`, `apps/api/src/db/measure.ts` | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Put-away scans & shelf boxes | Put-away | Shipped | `GET /put-away/candidates`, `POST /put-away/scans`, `POST /put-away/scans/:id/assign-to-box`, `POST /shelf-boxes/:id/add-all-unboxed`, `POST /shelf-boxes/:id/close` (and undo/remove routes) in `apps/api/src/routes/putAway.ts`, `apps/api/src/db/putAway.ts`; assigning a scan materializes an `inventory_lots` row | [ai-scope](../flows/put-away/ai-scope.md) |
| Receiving order clear | Receiving / Put-away | Shipped | order flips `in_hand → clear` when its last piece is boxed and the box closes, in `assignScanToBox` / `closeShelfBox` in `apps/api/src/db/putAway.ts` | [ai-scope](../flows/put-away/ai-scope.md) |
| Cycle-count shelf browse & verify-item | Goods Verify | Shipped | `GET /shelves`, `GET /shelves/with-box-counts`, `GET /shelves/:code/boxes`, `GET /shelf-boxes/:id`, `POST /shelf-boxes/:id/verify-item` in `apps/api/src/routes/goodsVerify.ts`, `verifyShelfBoxItem` in `apps/api/src/db/putAway.ts` | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Cycle-count task scheduling & completion | Goods Verify | Shipped | `scheduleCycleCount` in `apps/api/src/db/putAway.ts` (coalesced one pending task per box per day, due next local 09:00 stored UTC); `cycle_count` branch of `completeVerificationTask` in `apps/api/src/db/measure.ts`; pick-from-boxed-lot hook in `scanAllocation` in `apps/api/src/db/pickScan.ts` | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Demo auth API | Auth | Shipped | `POST /auth/login`, `GET /auth/users/:id` in `apps/api/src/routes/auth.ts` (plain-text compare, no tokens; `actor_id` stays a trusted client param) | [roles](../concepts/roles.md) |
| Demo seed + dev reset | Shared | Shipped | seed-on-empty in `apps/api/src/db.ts` via `seedIfEmpty` in `apps/api/src/db/seed.ts` (runs frozen `seedSql` from `apps/api/src/db/seedSql.ts` + `recomputeReceivingItem` + `allocateAll`); `POST /dev/reset` in `apps/api/src/routes/dev.ts`; generator `apps/web/scripts/export-api-seed.test.ts` (`pnpm --filter @warehouse/api gen:seed`) | — |
| Receiving list/detail read API | Receiving | Shipped | `GET /receiving-orders`, `GET /receiving-orders/:id` in `apps/api/src/routes/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving mismatch API | Receiving | Shipped | `GET /receiving-invoice-items/:id/mismatch`, `POST /receiving-invoice-items/:id/mismatches`, `PATCH /mismatches/:id`, `POST /mismatches/:id/confirm`, `POST /mismatches/:id/cancel` in `apps/api/src/routes/mismatch.ts`, `apps/api/src/db/mismatch.ts`; pure fns in `packages/shared/src/index.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Picking-by-receiving bundle API | Receiving / Picking | Shipped | `GET /receiving-orders/:id/picking`, `POST /picking-items/transition-logs` in `apps/api/src/routes/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Picking issue reporting API | Picking | Shipped | `POST /picking-orders/report-issues` in `apps/api/src/routes/picking.ts`, `apps/api/src/db/pickingIssues.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| OCR pick API | Picking / Receiving | Shipped | `POST /picking-orders/:id/ocr-pick` in `apps/api/src/routes/picking.ts`, `applyOcrPick` in `apps/api/src/db/ocrPick.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Scan candidates API | Picking / Receiving | Shipped | `GET /receiving-orders/:id/scan-candidates` in `apps/api/src/routes/receiving.ts` | [useScanMatchers](../composables/useScanMatchers.md) |
| Stock search API | — | Shipped | `GET /stock-search/suppliers`, `GET /stock-search/suppliers/:id/parts`, `GET /stock-search/parts/lots` in `apps/api/src/routes/stockSearch.ts` | [ai-scope](../flows/stock-search/ai-scope.md) |
| Supplier QR templates API | Shared | Shipped | `GET /suppliers/qr-templates` in `apps/api/src/routes/suppliers.ts` | — |

## Native Android app (apps/android)

The native rewrite lives in `apps/android` (Kotlin + Compose + Room, app id
`com.docpal.warehousepda`) — an earlier `native-android/` scaffold listed in
older revisions of this page was superseded.

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Native Phase 1: login, home, receiving list/detail (items + picking tabs) | Receiving | Shipped (native) | `apps/android/app/src/main/java/com/docpal/warehousepda/` (`ui/login/`, `ui/home/`, `ui/receiving/`, `data/`, `domain/`) | [phase-1 plan](../../superpowers/plans/2026-07-12-native-android-phase-1.md) (see "Phase 2 handoff notes") |
| Native scan pipeline (camera + hardware wedge, QR templates → OCR fallback → match → review dialog) | Picking / Receiving | Shipped (native) | `apps/android/.../scanner/`, `domain/scan/`, `ui/receiving/ScanLaunchers.kt`, `ui/scan/LabelScanReviewDialog.kt` | [phase-1 plan](../../superpowers/plans/2026-07-12-native-android-phase-1.md) |
| Native Phase 2: picking list (search, batch issue report), picking detail (items/allocations/packages/boxes/logs), scan-to-pick (`matchPicking`), finish → measuring task | Picking | Shipped (native) | `apps/android/.../ui/picking/`, `domain/PickingRepository.kt`, `domain/scan/ScanMatcher.kt` | [phase-2 plan](../../superpowers/plans/2026-07-12-native-android-phase-2.md) (see "Phase 3 handoff notes") |

Conventions (repository layer, ViewModel patterns, test setup): root `AGENTS.md`,
"Native Android app (apps/android)" section.

## Status legend

- **Shipped** — feature exists in the current demo.
- **Planned** — not part of this documentation system; see `docs/superpowers/plans/`.
- **In Progress** — being built in the native Android rewrite.
