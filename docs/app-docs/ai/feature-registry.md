# Feature Registry

Machine-readable index of features in the warehouse PDA demo. Use this page to locate implementation files and scope notes.

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Picking list | Picking | Shipped | `pages/picking/index.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking detail | Picking | Shipped | `pages/picking/[id].vue` or equivalent | [ai-scope](../flows/picking/ai-scope.md) |
| OCR-assisted picking | Picking / Receiving | Shipped | `composables/useLabelScan.ts`, `composables/useScanMatchers.ts`, `db/ocrPicking.ts`, `components/LabelScanReviewModal.vue`, `utils/parseOcrScan.ts`, `components/CandidateChips.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| OCR scan candidate search | Picking / Receiving | Local-only | `composables/useScanMatchers.ts`, `db/ocrPicking.ts`, `composables/useDb.ts` | [useScanMatchers](../composables/useScanMatchers.md) |
| Picking issue reporting | Picking | Shipped | `components/PickingIssueReportModal.vue`, `components/ReportIssueModal.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Receiving list | Receiving | Shipped | `pages/receiving/index.vue` | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving detail | Receiving | Shipped | `pages/receiving/[id].vue` or equivalent | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving mismatch | Receiving | Shipped | `components/ReportIssueModal.vue`, `db/mismatch.ts`, `db/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Pending picking count badge | Receiving | Shipped | `pages/receiving/index.vue`, `db/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Put-away list | Put-away | Shipped | `pages/put-away/index.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Put-away detail | Put-away | Shipped | `pages/put-away/[id].vue`, `components/put-away/PutAwayLotsPanel.vue`, `components/put-away/ShelfBoxesPanel.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Shelf selection | Put-away | Shipped | `components/SelectShelfDialog.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Measuring list | Measuring | Shipped | `pages/measuring/index.vue`, `services/warehouse.ts`, `services/adapters/pgliteWarehouse.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Measuring detail | Measuring | Shipped | `pages/measuring/[id].vue`, `services/warehouse.ts`, `services/adapters/pgliteWarehouse.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Box measurements | Measuring | Shipped | `components/BoxMeasurementsModal.vue`, `services/warehouse.ts`, `services/adapters/pgliteWarehouse.ts`, `db/measuring.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Goods verify list | Goods Verify | Shipped | `pages/goods-verify/index.vue` | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Goods verify detail | Goods Verify | Shipped | `pages/goods-verify/[id].vue` or equivalent | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Stock Search | — | Shipped | `pages/stock-search/index.vue`, `db/stockSearch.ts` | [ai-scope](../flows/stock-search/ai-scope.md) |
| Login | Auth | Shipped | `pages/login.vue`, `composables/useAuth.ts` | [roles](../concepts/roles.md) |
| Language switcher | Shared | Shipped | `components/LanguageSwitcher.vue`, `app.vue`, `i18n/` | [navigation](../concepts/navigation.md) |
| Toast notifications | Shared | Shipped | `components/ToastHost.vue`, `composables/useToast.ts` | [picking ai-scope](../flows/picking/ai-scope.md) |

## Warehouse API (apps/api)

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Receiving order ingestion | Receiving | Shipped | `PUT /receiving-orders/:external_id` in `apps/api/src/routes/receiving.ts`, `apps/api/src/ingest/receiving.ts`, `apps/api/src/ingest/parts.ts`, `apps/api/src/ingest/suppliers.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Confirm arrival + allocation trigger | Receiving | Shipped | `POST /receiving-orders/:external_id/confirm-arrival` in `apps/api/src/routes/receiving.ts`, `apps/api/src/ingest/receiving.ts`, `apps/api/src/ingest/transition.ts`; triggers `allocateAll` in `apps/api/src/db/allocate.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Picking order ingestion + allocation trigger | Picking | Shipped | `PUT /picking-orders/:external_id` in `apps/api/src/routes/picking.ts`, `apps/api/src/ingest/picking.ts`, `apps/api/src/ingest/parts.ts`; triggers `allocatePickingOrder` in `apps/api/src/db/allocate.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking execution — scan & undo-scan | Picking | Shipped | `POST /picking-orders/:id/scan`, `DELETE /picking-orders/:id/packages/:package_id` in `apps/api/src/routes/pickingExecution.ts`, `apps/api/src/db/pickScan.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking execution — box & pack ops | Picking | Shipped | `POST /picking-orders/:id/boxes`, `POST /picking-orders/:id/boxes/:box_id/cancel`, `POST /picking-orders/:id/boxes/:box_id/packages`, `POST /picking-orders/:id/boxes/:box_id/add-all-unboxed`, `DELETE /picking-orders/:id/boxes/:box_id/packages/:package_id` in `apps/api/src/routes/pickingExecution.ts`, `apps/api/src/db/pickScan.ts`; packing the last package auto-finishes the order and creates a measuring task | [ai-scope](../flows/picking/ai-scope.md) |
| Picking order finish | Picking | Shipped | `POST /picking-orders/:id/finish` in `apps/api/src/routes/pickingExecution.ts`, `apps/api/src/db/pickScan.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking order list/detail API | Picking | Shipped | `GET /picking-orders`, `GET /picking-orders/:id` in `apps/api/src/routes/pickingExecution.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Measuring task list API | Measuring | Shipped | `GET /measuring-tasks` in `apps/api/src/routes/measuring.ts` | [ai-scope](../flows/measuring/ai-scope.md) |

## Native Android (greenfield rewrite)

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Native app scaffold | — | In Progress | `native-android/` Gradle project | [full-native spec](../../superpowers/specs/2026-07-09-full-native-android-design.md) |
| Offline SQLite database | — | In Progress | `native-android/app/.../data/local/AppDatabase.kt`, `UserEntity`, `UserDao` | [full-native spec](../../superpowers/specs/2026-07-09-full-native-android-design.md) |
| Native login | Auth | In Progress | `native-android/app/.../ui/screens/LoginScreen.kt`, `LoginViewModel`, `AuthRepository` | [full-native spec](../../superpowers/specs/2026-07-09-full-native-android-design.md) |
| Native home menu | — | In Progress | `native-android/app/.../ui/screens/HomeScreen.kt` | [full-native spec](../../superpowers/specs/2026-07-09-full-native-android-design.md) |

## Status legend

- **Shipped** — feature exists in the current demo.
- **Planned** — not part of this documentation system; see `docs/superpowers/plans/`.
- **In Progress** — being built in the native Android rewrite.
