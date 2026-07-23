# Feature Registry

Machine-readable index of features in the warehouse PDA demo. Use this page to locate implementation files and scope notes.

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Picking list | Picking | Shipped | `pages/picking/index.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking detail | Picking | Shipped | `pages/picking/[id].vue` or equivalent | [ai-scope](../flows/picking/ai-scope.md) |
| Picking scan session ("checkout" queue) | Picking | Shipped | `pages/picking/scan/[id].vue`, `composables/usePickingScanQueue.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking work lock + allocation priority | Picking | Shipped | `composables/usePickingWorkLock.ts`, `POST`/`DELETE /picking-orders/:id/work-lock` + `POST /picking-orders/reorder` in `apps/backend/src/routes/picking.ts`, `picking_orders.priority_seq`/`working_by` in `apps/backend/src/db/allocate.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Pre-printed box ids (scan-to-create-box) | Picking | Shipped | `pages/picking/[id].vue`, `createShippingBox` `boxId` in `apps/backend/src/db/picking.ts`; picking detail box Print button removed, receiving picking tab Print still a placeholder | [ai-scope](../flows/picking/ai-scope.md) |
| Label scan (put-away / measuring) | Put-away / Measuring | Shipped | `composables/useLabelScan.ts`, `composables/useScanMatchers.ts`, `services/warehouse.ts`, `components/LabelScanReviewModal.vue`, `utils/parseOcrScan.ts`, `components/CandidateChips.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Receiving label scan (server-side match + serial dedup) | Receiving | Shipped | `composables/useReceivingScan.ts`, `components/receiving/ReceivingScanReviewModal.vue`, `POST /receiving-orders/:id/scan` in `apps/backend/src/routes/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving multi-item label scan (carton labels) | Receiving | Shipped | `utils/parseOcrScan.ts` (`extractMultiItemRows`), `composables/useReceivingScan.ts` (`applyRows`), `components/receiving/ReceivingScanMultiItemModal.vue` | [ai-scope](../flows/receiving/ai-scope.md) |
| Picking issue reporting | Picking | Shipped | `components/PickingIssueReportModal.vue`, `components/ReportIssueModal.vue` | [ai-scope](../flows/picking/ai-scope.md) |
| Receiving list | Receiving | Shipped | `pages/receiving/index.vue` | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving detail | Receiving | Shipped | `pages/receiving/[id].vue` or equivalent | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving mismatch | Receiving | Shipped | `components/ReportIssueModal.vue`, `utils/mismatch.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Pending picking count badge | Receiving | Shipped | `pages/receiving/index.vue` (server-computed `pendingPickingOrders` on the list row) | [ai-scope](../flows/receiving/ai-scope.md) |
| Put-away list | Put-away | Shipped | `pages/put-away/index.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Put-away detail | Put-away | Shipped | `pages/put-away/[id].vue`, `components/put-away/PutAwayLotsPanel.vue`, `components/put-away/ShelfBoxesPanel.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Shelf selection | Put-away | Shipped | `components/SelectShelfDialog.vue` | [ai-scope](../flows/put-away/ai-scope.md) |
| Measuring list | Measuring | Shipped | `pages/measuring/index.vue`, `services/warehouse.ts`, `services/adapters/backendWarehouse.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Measuring detail | Measuring | Shipped | `pages/measuring/[id].vue`, `services/warehouse.ts`, `services/adapters/backendWarehouse.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Box measurements | Measuring | Shipped | `components/BoxMeasurementsModal.vue`, `pages/measuring/[taskId]/box/[boxId].vue` | [ai-scope](../flows/measuring/ai-scope.md) |
| Goods verify queue | Goods Verify | Shipped | `pages/goods-verify/index.vue` (task queue: date/status filters, generate button) | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Goods verify detail | Goods Verify | Shipped | `pages/goods-verify/[id].vue` (lot context, box contents, verify with optional countedQty) | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Stock Search | — | Shipped | `pages/stock-search/index.vue` (one `GET /stock-search` call) | [ai-scope](../flows/stock-search/ai-scope.md) |
| Login | Auth | Shipped | `pages/login.vue`, `composables/useAuth.ts` | [roles](../concepts/roles.md) |
| Language switcher | Shared | Shipped | `components/LanguageSwitcher.vue`, `app.vue`, `i18n/` | [navigation](../concepts/navigation.md) |
| Toast notifications | Shared | Shipped | `components/ToastHost.vue`, `composables/useToast.ts` | [picking ai-scope](../flows/picking/ai-scope.md) |
| Service layer | Shared | Shipped | `services/warehouse.ts` (`WarehouseService` interface), `services/auth.ts` (`AuthService`), `services/adapters/backendWarehouse.ts` + `apiAuth.ts` (HTTP impls), `services/apiClient.ts` (fetch wrapper; GETs cached 60 s in `services/apiCache.ts`, invalidated by SSE topics and mutation prefixes via `MUTATION_INVALIDATIONS`), `services/types.ts` (web DTOs matching backend responses), `composables/useWarehouse.ts` | root `AGENTS.md` |
| Server events client | Shared | Shipped | `composables/useWarehouseEvents.ts` (EventSource singleton with `?since=` cursor + manual reconnect; toasts via `useToast`, cache invalidation, topic subscribers), `useVisibleReload(load, topics?)`, wired in `layouts/default.vue` | `docs/superpowers/specs/2026-07-18-sse-events-and-swr-cache-design.md` |
| Hardware scanner delivery | Shared | Shipped | `composables/useHardwareScanner.ts` (wedge fallback + broadcast subscription), `composables/useScannerBroadcast.ts`, native `apps/web/android/.../ScannerBroadcastPlugin.java` + `ScannerBroadcastReceiver.java` (manifest component) | [scanner setup](../setup/android-pda-scanner.md) |

Pages and components never query a database directly (except the pure `validateMismatchInputs` helper in `components/ReportIssueModal.vue`): they call `WarehouseService` / `AuthService`, which talk HTTP to `apps/backend` (:3002, env-overridable via `NUXT_PUBLIC_API_BASE_URL`). The old PGlite adapter and the `apps/api` adapter were removed in the 2026-07 migration; `apps/web/db/` no longer exists.

## Warehouse backend (apps/backend)

The backend the web app talks to. Route layer: `apps/backend/src/routes/<flow>.ts`; transaction-wrapped domain logic: `apps/backend/src/db/<flow>.ts`. Authoritative reference: `docs/backend/api-design.md`; concepts: `docs/backend/concepts.md`.

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Demo auth API | Auth | Shipped | `POST /auth/login`, `POST /auth/logout`, `GET /auth/users/:id` in `apps/backend/src/routes/auth.ts` (plain-text compare, no tokens; `actorId` stays a trusted client param) | [roles](../concepts/roles.md) |
| Receiving list/detail reads | Receiving | Shipped | `GET /receiving-orders?status=`, `GET /receiving-orders/:id` in `apps/backend/src/routes/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving scan (server parse/match + S-key dedup) | Receiving | Shipped | `POST /receiving-orders/:id/scan` in `apps/backend/src/routes/receiving.ts`, `apps/backend/src/db/scanParse.ts`; 409 `{message, candidates}` on no/multiple match, 409 `label_already_scanned` on a repeat serial (`receiving_scan_labels`) | [ai-scope](../flows/receiving/ai-scope.md) |
| Confirm arrival + allocation trigger | Receiving | Shipped | `POST /receiving-orders/:id/confirm-arrival` in `apps/backend/src/routes/receiving.ts`; triggers best-effort `allocateAll` in `apps/backend/src/db/allocate.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Receiving mismatch (item-keyed, flat columns) | Receiving | Shipped | `GET|POST|PATCH /receiving-invoice-items/:id/mismatch`, `POST .../mismatch/confirm|cancel` in `apps/backend/src/routes/receiving.ts`, `apps/backend/src/db/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Picking-by-receiving bundle | Receiving / Picking | Shipped | `GET /receiving-orders/:id/picking` in `apps/backend/src/routes/receiving.ts` | [ai-scope](../flows/receiving/ai-scope.md) |
| Picking list/detail reads | Picking | Shipped | `GET /picking-orders?status=`, `GET /picking-orders/:id` (nested: items → allocations/packages, boxes, measuring task) in `apps/backend/src/routes/picking.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking execution — scan | Picking | Shipped | `POST /picking-items/:id/scan {allocationId, qty, ...}` in `apps/backend/src/routes/picking.ts`, `apps/backend/src/db/picking.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking execution — packages & boxes | Picking | Shipped | `/packages/:id` (delete / verify), `POST /picking-orders/:id/boxes`, `/shipping-boxes/:id*` (patch / packages add+remove / add-all-unboxed / cancel / close) in `apps/backend/src/routes/picking.ts`; boxing the last package auto-finishes the order and creates a measuring task | [ai-scope](../flows/picking/ai-scope.md) |
| Picking order finish | Picking | Shipped | `POST /picking-orders/:id/finish` → measuring task in `apps/backend/src/routes/picking.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Picking issue reporting | Picking | Shipped | `POST /picking-orders/report-issues` in `apps/backend/src/routes/picking.ts` | [ai-scope](../flows/picking/ai-scope.md) |
| Put-away aggregate & scans | Put-away | Shipped | `GET /put-away/candidates`, `GET /receiving-orders/:id/put-away` (items + lots + scans + boxes), `POST /receiving-orders/:id/put-away-scans`, `DELETE /put-away-scans/:scanId` in `apps/backend/src/routes/putaway.ts`, `apps/backend/src/db/putaway.ts` | [ai-scope](../flows/put-away/ai-scope.md) |
| Shelf-box lifecycle | Put-away | Shipped | `POST /shelf-boxes`, `DELETE /shelf-boxes/:id` (cancel), `POST /shelf-boxes/:id/scans` (assign), `DELETE /shelf-boxes/:id/scans/:scanId`, `POST /shelf-boxes/:id/add-all-unboxed`, `POST /shelf-boxes/:id/close` in `apps/backend/src/routes/putaway.ts`; closing materializes inventory lots and auto-clears the receiving order | [ai-scope](../flows/put-away/ai-scope.md) |
| Measuring task list/detail | Measuring | Shipped | `GET /measuring-tasks?status=` (server-computed box counts), `GET /measuring-tasks/:id` (consolidated task + order + boxes with packages) in `apps/backend/src/routes/measuring.ts` | [ai-scope](../flows/measuring/ai-scope.md) |
| Measuring task completion | Measuring | Shipped | `POST /measuring-tasks/:id/complete` in `apps/backend/src/routes/measuring.ts`, `apps/backend/src/db/measuring.ts` (requires all boxes closed and items fully packed) | [ai-scope](../flows/measuring/ai-scope.md) |
| Goods-verify task generation & queue | Goods Verify | Shipped | `POST /goods-verify-tasks/generate` (day-end, idempotent per task date + lot, from `inventory_transactions`), `GET /goods-verify-tasks` (filters `date`/`status`/`shelfCode`), `GET /goods-verify-tasks/:id` in `apps/backend/src/routes/goodsverify.ts`, `apps/backend/src/db/goodsverify.ts` | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Goods-verify verify (with ADJUST) | Goods Verify | Shipped | `POST /goods-verify-tasks/:id/verify` (optional `countedQty`; a differing count corrects the lot and writes an ADJUST ledger row) in `apps/backend/src/routes/goodsverify.ts` | [ai-scope](../flows/goods-verify/ai-scope.md) |
| Stock search | — | Shipped | `GET /stock-search?supplierId&partNo&shelfCode` → `{parts, lots}` in `apps/backend/src/routes/stocksearch.ts`, `apps/backend/src/db/stocksearch.ts` | [ai-scope](../flows/stock-search/ai-scope.md) |
| Supplier QR templates | Shared | Shipped | `GET /scan-templates` in `apps/backend/src/routes/scantemplates.ts` (client-side label parsing for picking/put-away/measuring scans) | — |
| Ingest upserts | Receiving / Picking | Shipped | `PUT /receiving-orders/:externalId`, `PUT /picking-orders/:externalId` in `apps/backend/src/routes/ingest.ts`, `apps/backend/src/db/ingest.ts` (nullable unique `external_id`) | — |
| Admin master-data CRUD | Shared | Shipped | `/admin/*` in `apps/backend/src/routes/admin/` (generic `createCrudRouter` + custom `/admin/shelf-boxes`); the web app reuses `/admin/shelves` and `/admin/suppliers` as read lists | — |
| Admin console flow pages (picking/receiving/shipping) | Admin | Shipped | `apps/admin/pages/picking/*` (list, `reorder.vue` via `POST /picking-orders/reorder`, detail + delivery-date edit), `pages/receiving/*` (detail item date-code edit), `pages/shipping/*` (completed measuring tasks); `apps/admin/utils/flowApi.ts`; backend edits in `apps/backend/src/db/adminedits.ts` (`PATCH /admin/picking-orders/:id`, `PATCH /admin/receiving-invoice-items/:id`) | — |
| Demo seed + dev reset | Shared | Shipped | seed-on-empty in `apps/backend/src/db/seed.ts` (disable with `WAREHOUSE_SEED=off`); `POST /dev/reset` and `POST /dev/allocate` in `apps/backend/src/routes/dev.ts` | — |
| Allocation engine | Shared | Shipped | `allocateAll` in `apps/backend/src/db/allocate.ts` — idempotent recompute, runs best-effort after stock-changing commits | `docs/backend/concepts.md` §6 |
| Server events (SSE outbox) | Shared | Shipped | `GET /events?since=` in `apps/backend/src/routes/events.ts`; `app_events` table (`src/db/schema/events.ts`) written via `emitEvent` (`src/db/events.ts`) inside the allocate/ingest/goods-verify transactions | `docs/superpowers/specs/2026-07-18-sse-events-and-swr-cache-design.md` |

The retired `apps/api` (:3001) package is kept for history only — see its README and `docs/backend/api-review-old-api.md`. Its docs (`docs/api-reference-backend.md`, `docs/database-schema-api.md`) no longer describe the running system.

## Native Android app (apps/android)

The native rewrite lives in `apps/android` (Kotlin + Compose + Room, app id
`com.docpal.warehousepda`) — an earlier `native-android/` scaffold listed in
older revisions of this page was superseded.

| Feature | Flow | Status | Key Files | Scope Doc |
|---------|------|--------|-----------|-----------|
| Native Phase 1: login, home, receiving list/detail (items + picking tabs) | Receiving | Shipped (native) | `apps/android/app/src/main/java/com/docpal/warehousepda/` (`ui/login/`, `ui/home/`, `ui/receiving/`, `data/`, `domain/`) | [phase-1 plan](../../superpowers/plans/2026-07-12-native-android-phase-1.md) (see "Phase 2 handoff notes") |
| Native scan pipeline (camera + hardware wedge, QR templates → OCR fallback → match → review dialog) | Picking / Receiving | Shipped (native) | `apps/android/.../scanner/`, `domain/scan/`, `ui/receiving/ScanLaunchers.kt`, `ui/scan/LabelScanReviewDialog.kt` | [phase-1 plan](../../superpowers/plans/2026-07-12-native-android-phase-1.md) |
| Native Phase 2: picking list (search, batch issue report), picking detail (items/allocations/packages/boxes/logs), scan-to-pick (`matchPicking`), finish → measuring task | Picking | Shipped (native) | `apps/android/.../ui/picking/`, `domain/PickingRepository.kt`, `domain/scan/ScanMatcher.kt` | [phase-2 plan](../../superpowers/plans/2026-07-12-native-android-phase-2.md) (see "Phase 3 handoff notes") |
| Native Phase 3: put-away candidate list, put-away detail (lots + shelf boxes, `SelectShelfDialog`), scan-to-put-away (`matchPutAway`, pinned lot), inventory-lot materialization, receiving-order auto-clear | Put-away | Shipped (native) | `apps/android/.../ui/putaway/`, `domain/PutAwayRepository.kt`, `domain/scan/ScanMatcher.kt` | [phase-3 plan](../../superpowers/plans/2026-07-12-native-android-phase-3.md) (see "Phase 4 handoff notes") |
| Native Phase 4: goods-verify shelf list → shelf box list → box detail, scan-to-verify per part (`matchGoodsVerify`, box-scoped), mark box verified | Goods Verify | Shipped (native) | `apps/android/.../ui/goodsverify/`, `domain/GoodsVerifyRepository.kt`, `data/db/GoodsVerifyDao.kt`, `domain/scan/ScanMatcher.kt` | [phase-4 plan](../../superpowers/plans/2026-07-12-native-android-phase-4.md) (see "Phase 5 handoff notes") |

Conventions (repository layer, ViewModel patterns, test setup): root `AGENTS.md`,
"Native Android app (apps/android)" section.

## Status legend

- **Shipped** — feature exists in the current demo.
- **Planned** — not part of this documentation system; see `docs/superpowers/plans/`.
- **In Progress** — being built in the native Android rewrite.
