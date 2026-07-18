# Agent Instructions

This is a pnpm monorepo proof-of-concept for warehouse mobile/Android flows: `apps/web` (Nuxt 3 client), `apps/backend` (`@warehouse/backend` — Hono + Drizzle + PostgreSQL backend holding the revised target WMS schema, :3002), `apps/api` (**RETIRED** — the old Hono API the web client used until 2026-07; kept for history, see its README), and `packages/shared` (API request/response types used by both sides). The web app always talks to `apps/backend` over HTTP through a single adapter layer; the old PGlite offline mode and the `apps/api` adapter are gone.

## Tech stack

- **Workspace:** pnpm monorepo — `apps/web`, `apps/api`, `apps/backend`, `apps/android`, `packages/shared`
- **Backend:** `apps/backend` (`@warehouse/backend`) is the next-gen Hono + Drizzle + PostgreSQL backend holding the revised target WMS schema (full flow API implemented per `docs/backend/api-design.md`; the web client runs against it) (21 tables under `src/db/schema/`, plus `supplier_profiles` for PDA-local supplier fields such as `qr_template`/`qty_encoding` and lookup tables `country_list`, `box_size_list`, `net_weight_formula`, `customer_profiles`, `sub_inventories`; `suppliers` stays a pure AP_SUPPLIERS sync mirror). `sub_inventory_code` (FK → `sub_inventories`) partitions stock across `shelves`, `receiving_orders`, `receiving_invoices`, `picking_orders`, and `inventory_lots`; the same five tables also carry `warehouse_code` (plain text, no lookup table — instance default from env `WAREHOUSE_CODE`, default `HK1`, see `src/config.ts`) and `warehouse_section_code` (FK → `warehouse_sections`) — the three levels form warehouse → section → sub-inventory, all part of `inventory_lots_unique_lot`. Routes: `/health`; auth (`POST /auth/login`, `POST /auth/logout`, `GET /auth/users/:id` — stateless demo: plain-text password compare, no tokens); the full WMS flow API — receiving (`GET /receiving-orders?status=`, `GET /receiving-orders/:id` (+`/picking`, +`/put-away`), `POST .../confirm-arrival`/`/scan`, mismatch CRUD under `/receiving-invoice-items/:id/mismatch*`), put-away (`GET /put-away/candidates`, `POST /receiving-orders/:id/put-away-scans`, `/shelf-boxes*` lifecycle with lot materialization + receiving-order auto-clear), picking (`GET /picking-orders`, `POST /picking-items/:id/scan`, `/packages/:id`, `/shipping-boxes/:id*`, `POST /picking-orders/:id/finish` → measuring task, `POST /picking-orders/report-issues`), measuring (`GET /measuring-tasks`, `POST /measuring-tasks/:id/complete`), goods verify (`POST /goods-verify-tasks/generate` day-end from `inventory_transactions`, task queue, `POST /goods-verify-tasks/:id/verify` with ADJUST), stock search (`GET /stock-search`), scan support (`GET /scan-templates` — supplier QR templates for client-side label parsing; receiving scans also dedup by S-key serial via `receiving_scan_labels`, 409 `label_already_scanned`, migration 0012), ingest upserts (`PUT /receiving-orders/:externalId`, `PUT /picking-orders/:externalId` — nullable `external_id` unique columns, migration 0011), and `/admin/*` master-data CRUD (`src/routes/admin/` — generic `createCrudRouter` for shelves/suppliers/supplier-profiles/parts/countries/box-sizes/sub-inventories/customer-profiles/net-weight-formulas/users, plus a custom `/admin/shelf-boxes` router; unauthenticated POC, errors are plain text). Layering: thin routes in `src/routes/<flow>.ts` over tx-wrapped domain modules in `src/db/<flow>.ts` (snake_code `HTTPException` errors, `actorId` in every mutation body, `transaction_logs` + `inventory_transactions` ledger rows inside the tx, best-effort `allocateAll` after stock-changing commits). Same conventions as `apps/api`: migrations auto-apply on startup, and `src/db/seed.ts` auto-seeds a small demo dataset when the `users` table is empty (disable with `WAREHOUSE_SEED=off`); `pnpm --filter @warehouse/backend db:seed` wipes and re-seeds. Commands: `pnpm --filter @warehouse/backend dev|build|test|db:generate|db:migrate|db:seed` (`test` runs the node:test suite — 74 tests across `src/db/*.test.ts` — against `TEST_DATABASE_URL`, default database `warehouse_backend_test`). The allocation engine lives in `src/db/allocate.ts` (`allocateAll` — idempotent recompute per `docs/backend/concepts.md` §6; `POST /dev/allocate` triggers it, `POST /dev/reset` re-seeds). Defaults: port `3002`, database `warehouse_backend` on the shared local Postgres (`DATABASE_URL` overrides). Backend docs (key concepts + schema reference): `docs/backend/`. Hosted dev deployment (Vercel + Neon, see `docs/backend/README.md` "Hosted dev"): Vercel projects `docpal-pda-backend` (`https://docpal-pda-backend.vercel.app`, Hono preset serving `src/index.ts` via its `export default app`; boot migrate/seed skipped under `VERCEL`, use `db:migrate` + `db:seed` against the unpooled Neon URL) and `docpal-pda-admin`; Neon DB `warehouse_backend` (Marketplace integration injects `DATABASE_URL`; runtime uses the pooled URL with `PG_MAX=1` + `PG_PREPARE=false`); deploys are git-triggered on push to `master`.
- **Admin UI:** `apps/admin` (`@warehouse/admin`) is a Nuxt 3 (`ssr: false`) desktop admin console for the backend's `/admin/*` CRUD API. Plain CSS, English-only, port `3100`, `apiBaseUrl` env-overridable via `NUXT_PUBLIC_API_BASE_URL` (default `http://localhost:3002`). Client-side login gate only (stores `admin_user` in localStorage); generic `CrudTable`/`CrudForm` driven by `utils/entities.ts` configs, suppliers page edits the supplier profile (upsert), `shelf-boxes` pages manage shelf boxes (items read-only). Run with `pnpm dev:backend` + `pnpm dev:admin`.
- **Web framework:** Nuxt 3 (`ssr: false`)
- **UI:** Vue 3, plain CSS
- **Mobile shell:** Capacitor (Android platform added)
- **API:** Hono on Node, PostgreSQL via the `postgres` driver (`DATABASE_URL` connection string), Drizzle ORM
- **Data access (web):** Pages call `WarehouseService` / `AuthService` (`apps/web/services/warehouse.ts`, `services/auth.ts`) via `useWarehouse()` / `useAuth()`. There is a single adapter: `services/adapters/backendWarehouse.ts` (+ `apiAuth.ts`) speaks HTTP to `apps/backend` (:3002) through `services/apiClient.ts`. `apiBaseUrl` is set in `apps/web/nuxt.config.ts`, env-overridable via `NUXT_PUBLIC_API_BASE_URL` (Capacitor device builds need a LAN-reachable host — the backend's CORS allows `http://localhost:3000` and `capacitor://localhost`, and the device WebView origin is `http://localhost` because `capacitor.config.ts` sets `server.androidScheme: "http"`).
- **List pages:** Reload on mount and when the app regains visibility (Capacitor has no live-query support). All reads go through `WarehouseService` → HTTP; prefer the shared `useVisibleReload(load)` composable for the lifecycle wiring.

## Common commands

```bash
pnpm install        # install dependencies
cd apps/api && docker compose up -d  # start the shared local Postgres service (required for dev/tests)
pnpm dev:backend                     # start the backend dev server on :3002 (@warehouse/backend)
pnpm --filter @warehouse/backend test    # backend test suite (node:test; needs Postgres + TEST_DATABASE_URL)
pnpm --filter @warehouse/backend build   # backend typecheck (tsc)
pnpm --filter @warehouse/backend db:generate  # generate Drizzle migrations after schema changes
pnpm --filter @warehouse/backend db:seed      # wipe and re-seed the demo dataset
pnpm --filter @warehouse/web dev     # start web dev server on :3000
pnpm --filter @warehouse/web test    # web test suite (vitest)
pnpm --filter @warehouse/web nuxt prepare   # generate Nuxt types; run after schema/template changes
pnpm --filter @warehouse/web build   # production build
pnpm --filter @warehouse/web generate     # static export for Capacitor
pnpm --filter @warehouse/web cap:sync     # copy web assets into native platforms
pnpm --filter @warehouse/web cap:android  # generate, sync, and open Android project
pnpm --filter @warehouse/web cap:android:dev  # sync Android to the running web dev server for live reload
```

The retired `apps/api` package keeps its own commands (`pnpm --filter @warehouse/api dev|test|build|db:migrate`) for historical reference only — the web client no longer talks to it.

The web dev workflow needs TWO servers: `pnpm dev:backend` (:3002) and `pnpm --filter @warehouse/web dev` (:3000). The web app always talks to the backend.

### Postgres setup (shared)

The backend expects a running PostgreSQL server. A Docker Compose service is provided (it lives in `apps/api` for historical reasons but serves the whole repo):

```bash
cd apps/api
cp .env.example .env   # edit DATABASE_URL / TEST_DATABASE_URL if needed
docker compose up -d
```

Backend migrations are applied automatically on startup. To generate migrations after schema changes:

```bash
pnpm --filter @warehouse/backend db:generate
```

Backend tests use the `TEST_DATABASE_URL` database (default `warehouse_backend_test`) and run serially because they share one test database.

For Android live reload, run the web dev server in one terminal, then run `pnpm --filter @warehouse/web cap:android:dev` in another. The helper script (`scripts/cap-android-dev.mjs`) finds your machine's LAN IP, sets `CAPACITOR_SERVER_URL` (consumed by `capacitor.config.ts`), and points the Android WebView at `http://<ip>:3000`. The device also needs to reach the backend, so set `NUXT_PUBLIC_API_BASE_URL=http://<ip>:3002` when starting the web dev server. Make sure the Android device and dev machine are on the same network. Known issue: on the current Capacitor version live reload fails with a native bridge `Cannot read properties of undefined (reading 'triggerEvent')` error; use the bundled build below until that is resolved.

Device networking notes (bundled builds verified on a real device):

- `capacitor.config.ts` sets `server.androidScheme: "http"` — required so LAN `http://` API calls are not blocked as mixed content (the default `https://localhost` origin would also miss the API CORS allowlist). `AndroidManifest.xml` carries `android:usesCleartextTraffic="true"` for the same reason.
- Never run `pnpm generate` while the web dev server is running: both share `.nuxt/dist/client`, and the dev server pollutes the static export with dev URLs (`@vite/client`, absolute-path entries). Stop the dev server first, then generate.

### Demo reset

- **Backend:** `POST :3002/dev/reset` truncates the Postgres database and re-seeds it.
- **Web:** the reset control in `components/AppHeader.vue` calls `warehouse.resetDemoData()`, which hits `POST /dev/reset` through the backend adapter.

### Native Android build / install on a connected device

When the web assets have changed, regenerate and sync first:

```bash
pnpm generate
npx cap sync android
```

Then build and install the debug APK (from the `android` directory):

```bash
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:installDebug
```

If `adb` is not on your `PATH`, use the SDK recorded in `android/local.properties`. On this machine that is:

```bash
'/d/android/platform-tools/adb.exe' devices
'/d/android/platform-tools/adb.exe' shell run-as com.docpal.warehousedemo ls cache/
```

To clear old debug/output images from the app cache:

```bash
'/d/android/platform-tools/adb.exe' shell \
  "run-as com.docpal.warehousedemo sh -c 'rm -f cache/debug_* cache/rectangle_*'"
```

## Native Android app (apps/android) — DEPRECATED

**Deprecated (2026-07).** The native rewrite (Kotlin + Compose + Room) was a
proof-of-concept and is no longer the product direction — the Capacitor web
client (`apps/web`) + `apps/backend` is. The code stays as reference only
(scan parsing, flow logic); do not add features. It lives in `apps/android` as an
independent Gradle project — do not confuse it with the Capacitor project at
`apps/web/android`. Spec: `docs/superpowers/specs/2026-07-12-native-android-design.md`;
plans: `docs/superpowers/plans/2026-07-12-native-android-phase-*.md`.

```bash
cd apps/android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:installDebug        # build + install on connected device
./gradlew :app:testDebugUnitTest   # JVM tests (Robolectric Room tests + OpenCV crop test)
```

Seed data: `apps/android/app/src/main/assets/seed.sql` was generated from the
old web PGlite seed (precalc preset) and imported in Room's `onCreate`. It is
frozen — the PGlite seed and the `export:android-seed` script were removed with
the backend migration, so the file can no longer be regenerated.
The app id `com.docpal.warehousepda` installs side by side with the Capacitor
`com.docpal.warehousedemo`.

Phase 1 (login, home, receiving list/detail with items + picking tabs, end-to-end
scan pipeline), Phase 2 (picking list with search + batch issue report, picking
detail with boxes/logs, scan-to-pick, finish → measuring task), Phase 3
(put-away candidate list, put-away detail with lots + shelf boxes, scan-to-put-away,
inventory-lot materialization, receiving-order auto-clear), and Phase 4
(goods-verify shelf list → shelf box list → box detail, scan-to-verify per part,
mark box verified) are complete: 282 JVM tests green, debug APK builds and installs.
Conventions inside `apps/android` (details in the Phase 1 plan's "Phase 2 handoff
notes", the Phase 2 plan's "Phase 3 handoff notes", the Phase 3 plan's "Phase 4
handoff notes", and the Phase 4 plan's "Phase 5 handoff notes"):

- **Layers:** `data/` holds Room (`data/db/`) plus suspend repositories that wrap
  DAO calls in `withContext(Dispatchers.IO)`; `domain/` holds the pure/sync
  business logic (`PickingRepository` — scan-to-pick, shipping-box ops, batch
  issue reports, finish (manual or auto when the last package is boxed) which
  inserts the `measuring_tasks` row Phase 5 will read; `PutAwayRepository` —
  put-away read model, shelf-box lifecycle, scan-to-box assignment with
  inventory-lot materialization, auto-clear via `ReceivingRepository.tryMarkClear`;
  `GoodsVerifyRepository` — goods-verify read model (shelves → boxes → box items),
  verify-item (all scans of a part in a box), mark-box-verified with a
  `closed → verified` transition log; `MismatchRepository`, `AuthRepository`,
  `AllocationDistributor` for allocation
  math) whose transition functions self-wrap `db.runInTransaction`. Scan
  parsing/matching lives in `domain/scan/`.
- **Screens:** `ui/login`, `ui/home`, `ui/receiving` (list + detail with items
  and picking tabs, `ReportIssueDialog`), `ui/picking` (list with search +
  multi-select batch issue report, detail with items/allocations/packages/boxes/
  logs, `PickingIssueReportDialog`), `ui/putaway` (candidate list, detail with
  lots + shelf-boxes sections, `SelectShelfDialog`), `ui/goodsverify` (shelf
  list, shelf box list, box detail with expected-items + mark-verified). The
  shared scan review
  dialog lives in `ui/scan/` (`LabelScanReviewDialog`, `ScanReviewUiState`).
- **Scan entry points:** `ui/receiving/ScanLaunchers.kt` (camera / manual /
  wedge), `HardwareKeyBuffer` (wedge key capture), `QrParser` with
  `OcrLabelParser` fallback, then `ScanMatcher` (`matchReceiving` for receiving,
  `matchPicking` for scan-to-pick, `matchPutAway` for pinned-lot put-away,
  `matchGoodsVerify` for box-scoped scan-to-verify — single match auto-applies
  (goods verify always opens the review dialog, web `confirmSingleMatch` parity),
  a match error opens the review dialog).
- **UI conventions:** reusables in `ui/components/` (`StatusBadge`, `EmptyState`,
  `DetailRow`, `ErrorText`, `OnResumeEffect`). ViewModels take an injected `io`
  dispatcher, reload through a race-safe `loadJob`, serialize mutations via
  `runAction`, and detail screens use a per-orderId `provideFactory`
  (`ReceivingDetailViewModel.provideFactory`).
- **Tests:** Robolectric with `@Config(sdk=[34])` + `StandardTestDispatcher`;
  Room fixtures use an in-memory DB seeded by `offMainThread` execSQL
  (`app/src/test/.../DbTestSupport.kt`); repositories are faked via their source
  interfaces. Never hardcode seed UUIDs — look ids up by business key
  (`ReceivingRepositoryTest.partIdOf` is the pattern).

## Code conventions

- Follow existing patterns. Make minimal, focused changes.
- Keep files small and single-responsibility.
- Put Vue composables in `composables/` and shared helpers in `utils/`.
- New data access goes through `WarehouseService` (`useWarehouse()`), which talks HTTP to `apps/backend` (:3002). List pages reload on `onMounted` plus `visibilitychange`/`focus` events so Capacitor behaves correctly; prefer the shared `useVisibleReload(load)` composable for this lifecycle wiring.
- Use shared presentation primitives on detail pages: `DetailRow`, `ScanFab`, `EmptyState`, and composables `useStatusBadge`, `useLabelScanReview`. Status badges are rendered inline with `badgeClass` and `useStatusBadge` / `statusLabel` helpers. Keep page-specific sub-views in `components/<page>/`.
- Prefer explicit, readable names over clever abstractions.

## Testing

The native Android app (`apps/android`, **deprecated**) has a JVM unit-test suite (Robolectric
Room/repository tests, ViewModel tests, OpenCV crop test — see the Android
section above for the current count). Run it with:

```bash
cd apps/android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:testDebugUnitTest
```

Also verify work with:

1. `pnpm nuxt prepare` — ensure types generate without errors.
2. Manual browser check — with `pnpm dev:backend` (:3002) running, log in as `operator` / `DocPal2026!`, navigate through the affected flows, and confirm behavior.

## Feature workflow

For non-trivial changes:

1. Write a design spec in `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md`.
2. Write an implementation plan in `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`.
3. Implement, verify, and commit.

## Documentation system

The project maintains a dual-audience documentation system under `docs/app-docs/`:

- **Human training manual** for operators and trainers.
- **AI lookup reference** for coding agents.

### How agents should use it

- Start with `docs/app-docs/README.md` for the table of contents.
- Use `docs/app-docs/ai/feature-registry.md` to locate which files implement a feature.
- Use `docs/app-docs/ai/code-map.md` for page/component ↔ source-file mappings.
- Read the relevant flow's `ai-scope.md` before changing behavior so you know boundaries and known limitations.

### How agents should maintain it

When you add, remove, or significantly change a feature:

1. Update the relevant `docs/app-docs/flows/<flow>/` files:
   - `overview.md` for concept changes.
   - `steps.md` for operator-step changes.
   - `ai-scope.md` for scope, key files, limitations, and related specs.
2. Update `docs/app-docs/ai/feature-registry.md` and `docs/app-docs/ai/code-map.md` if files or features changed.
3. Use `docs/app-docs/ai/scope-remark-template.md` as the format for new AI scope blocks.
4. Do not duplicate `README.md` or `AGENTS.md`; link to them instead.

## Demo limitations to keep in mind

- **Demo passwords only.** Passwords are stored as plain-text hashes in the seed file.
- **Native scanning.** The Android native `RectangleDetection.scanLabel()` flow is still used for camera-based label capture where implemented.
- **Hardware scanner delivery.** The Capacitor app receives hardware scans two ways: the `ScannerBroadcast` plugin (`apps/web/android/.../ScannerBroadcastPlugin.java`, wrapped by `composables/useScannerBroadcast.ts`) listens for the scanner service's intent broadcast `com.wclsolution.docpal.action.BARCODE_SCANNED` (extra `barcode`) and is the fast path; `useHardwareScanner` also keeps the keyboard-wedge fallback (key events buffered until Enter) for browser dev and unconfigured devices. The plugin receives via a context-registered receiver (implicit broadcasts) plus the manifest component `ScannerBroadcastReceiver` (explicit package/class-targeted broadcasts); both share one dispatch path that suppresses duplicate deliveries of the same value within 400 ms. After a broadcast scan the composable eats wedge key echo for 1.5 s so the "Output to broadcast/keyboard" device mode does not double-scan. Device setup (one-time, scanner Function settings / directional output): Barcode data output mode = "Output to broadcast", PackageName = `com.docpal.warehousedemo`, ClassName = `com.docpal.warehousedemo.ScannerBroadcastReceiver`, Scan Result Action = the action above (Enable Intent ON), Scan Result Data Key = `barcode` (the firmware's misspelled default `bacode` is also accepted); verify with `adb logcat -s ScannerBroadcast` (this ROM suppresses DEBUG log lines — the plugin logs at INFO).
- **Capacitor web assets.** Run `pnpm generate` before `pnpm cap:sync` so the native apps receive the latest static build from `.output/public`. For dev live reload, use `pnpm cap:android:dev` instead.
- **Android only.** iOS platform is not configured.
