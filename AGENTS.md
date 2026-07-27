# Agent Instructions

This is a pnpm monorepo proof-of-concept for warehouse mobile/Android flows: `apps/web` (Nuxt 3 client, shipped to Android via Capacitor), `apps/backend` (`@warehouse/backend` — Hono + Drizzle + PostgreSQL backend holding the revised target WMS schema, :3002), and `apps/admin` (desktop admin console). The web app always talks to `apps/backend` over HTTP through a single adapter layer. The retired `apps/api` (old Hono/SQLite API), the deprecated native `apps/android` (Kotlin POC), and `packages/shared` (legacy API types) were deleted 2026-07; their history lives in git and the `docs/superpowers/` specs.

## Tech stack

- **Workspace:** pnpm monorepo — `apps/web`, `apps/backend`, `apps/admin`, `layers/i18n` (shared Nuxt i18n layer extended by `apps/web` and `apps/admin`: `@nuxtjs/i18n` config, `i18n/locales/{en-US,zh-CN,zh-HK}.ts`, `components/LanguageSwitcher.vue`, `plugins/locale-persistence.client.ts` persisting the `warehouse-locale` localStorage key; apps add only `extends: ["../../layers/i18n"]`)
- **Backend:** `apps/backend` (`@warehouse/backend`) is the next-gen Hono + Drizzle + PostgreSQL backend holding the revised target WMS schema (full flow API implemented per `docs/backend/api-design.md`; the web client runs against it). Table-by-table schema contract: `docs/backend/schema-tables.md` (Drizzle source of truth: `src/db/schema/*.ts`; design decisions: `docs/superpowers/specs/2026-07-21-schema-redesign-org-id-design.md`). Master data includes `supplier_profiles` for PDA-local supplier fields (`qr_template`/`qr_template_config`/`qr_type`/`qty_encoding`) and lookups `country_list`, `box_size_list`, `net_weight_formula`, `customer_profiles` (+`rule` for customer custom requirements); `suppliers` stays a pure AP_SUPPLIERS sync mirror; `parts` is referenced by all other tables via `part_no` (UNIQUE) — its UUID `id` is internal-only. The app runs one standalone instance per warehouse, so there is no `warehouse_code`; stock is partitioned by the pair `org_id` (integer office id, 2 = HK) + `sub_inventory_code` (FK → `sub_inventories` — the group table (composite PK `org_id`+`code`, `customer_code` for customer-segregated stores) is the composite-FK target of all stock/doc tables; the seeded master is the real Oracle mapping (151 sub-inventories across 13 orgs from `new_seed/ORIGINAL_ID + ORG_ID + Sub Inventory mapping.xlsx`, alongside the demo groups) and cross-store sharing is declared per warehouse in `sub_inventory_share_members` (org_id+code → share_group; allocation also matches sources whose sub-inventory shares the demand's group — see `docs/superpowers/specs/2026-07-27-real-master-data-and-share-groups-design.md`)). The pair is carried by `shelf_boxes` (nullable — moved from `shelves` 2026-07-23; the box's pair defaults to its receiving order's pair and put-away stamps lots with the BOX's pair), the receiving tables (`receiving_orders` NOT NULL DEFAULT 2 org / mandatory sub-inventory, invoices/items nullable), `inventory_lots` (part of `inventory_lots_unique_lot`), and `picking_orders` (nullable — allocation matches on the pair when present, org-agnostic otherwise; customer-segregated sub-inventories only serve their customer's orders). Natural keys: `receiving_orders.batch_no`, `picking_orders.order_no` (UNIQUE — sync/dedup key for the upstream-DB replica; there is no `external_id`), `receiving_invoice_items.line_qty`/`ctn_no` (Oracle parity). Routes: `/health`; auth (JWT bearer, HS256 via `hono/jwt`, secret from env `AUTH_SECRET`, 12 h TTL — `POST /auth/login` → `{user, token}`, `GET /auth/me`, `POST /auth/change-password`; global middleware enforces the token on all routes except `/health`, `/auth/login`, `/dev/*`, with `?token=` accepted only for `GET /events`; passwords are scrypt-hashed (`src/auth/password.ts`, lazy upgrade of legacy plain-text rows); users belong to groups via `user_groups` + `user_group_members` (many-to-many, `users.role` is gone); mutation actor is taken from the token, never the body — see `docs/superpowers/specs/2026-07-21-real-login-design.md`); the full WMS flow API — receiving (`GET /receiving-orders?status=`, `GET /receiving-orders/:id` (+`/picking`, +`/put-away`), `POST .../confirm-arrival`/`/scan`, mismatch CRUD under `/receiving-invoice-items/:id/mismatch*`), put-away (`GET /put-away/candidates`, `POST /receiving-orders/:id/put-away-scans`, `/shelf-boxes*` lifecycle with lot materialization + receiving-order auto-clear), picking (`GET /picking-orders`, `POST /picking-items/:id/scan`, `/packages/:id`, `/shipping-boxes/:id*`, `POST /picking-orders/:id/finish` → measuring task, `POST /picking-orders/report-issues`, `POST /picking-orders/:id/resolve-issue` — an issued order is frozen (scan/unpack 409, excluded from allocation) until resolve returns it to `pending`, clears the `issue_*` columns and re-allocates), measuring (`GET /measuring-tasks`, `POST /measuring-tasks/:id/complete`), goods verify (`POST /goods-verify-tasks/generate` day-end from `inventory_transactions` — also runs automatically every night at local 00:00 via `src/jobs/goodsVerifyDayEnd.ts` started by `src/server.ts`, generating DB `CURRENT_DATE-1` + `CURRENT_DATE` idempotently with a boot catch-up, `GOODS_VERIFY_CRON=off` to disable; task queue, `POST /goods-verify-tasks/:id/verify` with ADJUST), stock search (`GET /stock-search`), box lookup (`GET /boxes?q=` — cross-flow shipping + shelf box search for the web `/box` QR page; server-generated box ids are `BOX-<kind>-<YYYYMMDD>-<seq>` with kind `S`=shipping / `H`=shelf and a per-day seq, `nextBoxId` in `src/db/boxes.ts`), scan support (`GET /scan-templates` — supplier QR templates for client-side label parsing; receiving scans also dedup by S-key serial via `receiving_scan_labels`, 409 `label_already_scanned`, migration 0012), ingest upserts (`PUT /receiving-orders/:batchNo`, `PUT /picking-orders/:orderNo` — idempotent upsert keyed by the natural business keys), server events (`GET /events?since=` — SSE over the `app_events` transactional outbox; `emitEvent` (`src/db/events.ts`) writes rows inside the allocate/ingest/goods-verify txs, each stream polls every ~1.5 s; catalog in `docs/backend/README.md`), and `/admin/*` master-data CRUD (`src/routes/admin/` — generic `createCrudRouter` for shelves/suppliers/supplier-profiles/parts/countries/box-sizes/customer-profiles/net-weight-formulas/users, plus custom `/admin/shelf-boxes`, `/admin/sub-inventories` (org_id+code groups) and `/admin/sub-inventory-share-groups` (org_id+code → share_group upsert/remove) routers, `GET /admin/receiving-mismatches` (cross-order open-mismatch list, `src/routes/admin/issues.ts` — also `GET /admin/receiving-orders/:id/logs` + `GET /admin/picking-orders/:id/logs` audit-log reads over `transaction_logs` with actor display names, and `DELETE /admin/receiving-invoice-items/:id` to remove a not-yet-worked issue item, 409 `item_work_started`), and flow-edit PATCHes `PATCH /admin/picking-orders/:id` `{deliveryDate}` + `PATCH /admin/receiving-invoice-items/:id` `{dateCode}` (`src/db/adminedits.ts` — `transaction_logs` audit rows); unauthenticated POC, errors are plain text). Layering: thin routes in `src/routes/<flow>.ts` over tx-wrapped domain modules in `src/db/<flow>.ts` (snake_code `HTTPException` errors, `actorId` in every mutation body, `transaction_logs` + `inventory_transactions` ledger rows inside the tx, best-effort `allocateAll` after stock-changing commits). Migrations auto-apply on startup, and `src/db/seed.ts` auto-seeds the demo dataset when the `users` table is empty (a small hand-written demo world — cleared KOA order with on-shelf lots, pending DAITO order, pending SO, 10 stocked shelf boxes (`BOX-H-20260701-0001..0010`; skipped in tests via `resetAndReseed(..., { stockBoxes: false })`) — plus the `new_seed/` real dataset generated into `src/db/seed-real-data.ts`: pending receiving orders `04958184`/`65878` with real invoices/items, and their picking lists — the `65878` picking.xlsx invoices and the `04958184` TN transfer-note PDFs as picking orders — and the 2026-07-27 real master-data set (generated artifacts + generator `scripts/gen-seed-real-data.mjs`): the full Oracle parts master (`src/db/seed-parts-data.json`, ~100k parts split supplier/part_no on the first `/ + - *` with spaces stripped, plus 162 auto-created suppliers), the real net-weight table (`src/db/seed-net-weight-data.ts`), the 151-group sub-inventory master (`src/db/seed-subinventories-data.ts`), and the multi-supplier receiving order `210726` (`src/db/seed-order-210726.ts` — order-level supplier NULL, supplier per invoice, org 2 / STAGING). Bulk parts/weights/210726 are skipped in tests via `resetAndReseed(..., { bulkParts: false })`) (disable with `WAREHOUSE_SEED=off`); `pnpm --filter @warehouse/backend db:seed` wipes and re-seeds. Commands: `pnpm --filter @warehouse/backend dev|build|test|db:generate|db:migrate|db:seed` (`test` runs the node:test suite across `src/db/*.test.ts` against `TEST_DATABASE_URL`, default database `warehouse_backend_test`). The allocation engine lives in `src/db/allocate.ts` (`allocateAll` — idempotent recompute per `docs/backend/concepts.md` §6; `POST /dev/allocate` triggers it, `POST /dev/reset` re-seeds). Demands are allocated in `picking_orders.priority_seq` order (`POST /picking-orders/reorder` rewrites the seq and re-allocates; default seq = delivery date ASC NULLS LAST then order_no; new ingest orders slot into their delivery-date position, shifting existing orders down), open qty is `qty − Σ picking_packages`, and an order with a live page work lock (`working_by`/`working_at`, refreshed by the open PDA page every 3 min, expiring 10 min after `working_at`; `POST`/`DELETE /picking-orders/:id/work-lock`, 409 `lock_held` for a second user) is skipped by the recompute — see `docs/superpowers/specs/2026-07-23-picking-priority-allocation-design.md`. Defaults: port `3002`, database `warehouse_backend` on the shared local Postgres (`DATABASE_URL` overrides). Backend docs (key concepts + schema reference): `docs/backend/`.
- **Admin UI:** `apps/admin` (`@warehouse/admin`) is a Nuxt 3 (`ssr: false`) desktop admin console for the backend's `/admin/*` CRUD API. Plain CSS styled with the DocPal brand palette (teal `--brand-teal` → blue `--brand-blue` CSS vars in `assets/main.css`, light sidebar with the `public/logoWithName.png` brand mark + favicon set in `public/`), port `3100`, `apiBaseUrl` env-overridable via `NUXT_PUBLIC_API_BASE_URL` (default `http://localhost:3002`). i18n comes from the shared `layers/i18n` layer (zh-HK default; nav, userbox, login, and page/table content are translated via `admin.*` locale keys — `navSections` titles and `EntityConfig` `title`/field `label` values in `utils/entities.ts` are i18n keys resolved by CrudTable/CrudForm; only status enum values and the QrTemplateEditorDialog internals stay English). Real login against the backend's `POST /auth/login` (JWT bearer stored as `admin_token` in localStorage, admin-group membership required); generic `CrudTable`/`CrudForm` driven by `utils/entities.ts` configs (internal UUID `id` columns hidden; all list pages paginate client-side via `composables/usePaging.ts` + `components/Pager.vue`, except parts and net-weight-formulas — the ~100k-row Oracle parts master pages/searches/filters/sorts server-side (`GET /admin/parts?page=&pageSize=&q=&supplierCode=&sort=&dir=` → `{rows, total}`, entity flag `serverPaging` + `filterFields` in `utils/entities.ts` + `components/CrudTable.vue`); CrudTable also offers clickable column sorting (`composables/useColumnSort.ts`) and client-side search (`EntityConfig.clientSearch`, e.g. suppliers)), suppliers page edits the supplier profile (upsert) through `components/QrTemplateEditorDialog.vue` — a non-technical QR-template editor (paste a sample scan, label the pieces, live parse preview + test bench) that generates `qr_template` from the structured `qr_template_config` it stores alongside (`utils/qrTemplate.ts`; spec `docs/superpowers/specs/2026-07-24-supplier-qr-template-editor-design.md`), `shelf-boxes` pages manage shelf boxes (items read-only), and the sub-inventories page also edits each store's share group inline (which sub-inventories may serve each other's picking demands — `/admin/sub-inventory-share-groups`) plus client-side keyword filter/sort. A read-only stock-search page (`pages/stock-search.vue`, Warehouse nav section) queries `GET /stock-search?supplierId=&partNo=` and renders the parts summary + lots tables. Navigation follows the sections in `apps/admin/TOC.md` (`navSections` in `utils/entities.ts`): Customer / Supplier / Warehouse (master data), Picking (orders list in `priority_seq` order + `/picking/reorder` priority editor calling `POST /picking-orders/reorder`, detail with delivery-date edit via `PATCH /admin/picking-orders/:id`), Receiving (list + detail with delivery-date edit via `PATCH /admin/receiving-orders/:id`, inline item date-code edit via `PATCH /admin/receiving-invoice-items/:id`, and a client-side invoice filter), Issues (`pages/issues/receiving.vue` — open receiving mismatches with confirm/cancel; `pages/issues/picking.vue` — picking orders in `issue` status with resolve → back to `pending` + re-allocate; spec `docs/superpowers/specs/2026-07-27-admin-issue-handling-design.md`), Shipping (completed measuring tasks, multi-select for the future shipper download), Settings (users/groups). Flow reads go through `utils/flowApi.ts` (typed wrappers over the shared api client); document-download buttons (packing list / TN / delivery order list / shipper) are placeholders until the Excel formats arrive. Run with `pnpm dev:backend` + `pnpm dev:admin`.
- **Web framework:** Nuxt 3 (`ssr: false`)
- **UI:** Vue 3, plain CSS
- **Mobile shell:** Capacitor (Android platform added)
- **API:** Hono on Node, PostgreSQL via the `postgres` driver (`DATABASE_URL` connection string), Drizzle ORM
- **Data access (web):** Pages call `WarehouseService` / `AuthService` (`apps/web/services/warehouse.ts`, `services/auth.ts`) via `useWarehouse()` / `useAuth()`. There is a single adapter: `services/adapters/backendWarehouse.ts` (+ `apiAuth.ts`) speaks HTTP to `apps/backend` (:3002) through `services/apiClient.ts`. `apiBaseUrl` is set in `apps/web/nuxt.config.ts` (default `http://127.0.0.1:3002` — 127.0.0.1, not localhost: some device ROMs' WebViews can't resolve `localhost`; see the remark under "Device networking notes"), env-overridable via `NUXT_PUBLIC_API_BASE_URL` (Capacitor device builds need a LAN-reachable host — the backend's CORS default allowlist covers `http://localhost(:3000)`, `http://127.0.0.1(:3000)` and `capacitor://localhost`, and the device WebView origin is `http://localhost`/`http://127.0.0.1` because `capacitor.config.ts` sets `server.androidScheme: "http"`).
- **List pages:** Reload on mount and when the app regains visibility (Capacitor has no live-query support). All reads go through `WarehouseService` → HTTP; prefer the shared `useVisibleReload(load, topics?)` composable for the lifecycle wiring — pass URL-prefix topics (e.g. `["/picking-orders"]`) so the page also reloads when the backend's SSE stream reports a change. `apiClient.get` responses are cached 60 s in `services/apiCache.ts` (memory + localStorage, invalidated by SSE topics and mutation prefixes via `MUTATION_INVALIDATIONS` in `apiClient.ts`); `composables/useWarehouseEvents.ts` holds the EventSource singleton (connects when logged in, `?since=` cursor + manual reconnect, toast notifications via `useToast`).

## Common commands

```bash
pnpm install        # install dependencies
docker compose up -d  # start the shared local Postgres service (required for dev/tests)
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
pnpm --filter @warehouse/web cap:android  # bundled build: generate, sync (server URL off), and open Android project
pnpm --filter @warehouse/web cap:android:proxy  # adb reverse tcp:3000+3002 (re-run after device reconnect)
pnpm --filter @warehouse/web cap:android:dev  # proxy + sync Android pointed at the running web dev server (live reload)
```

The web dev workflow needs TWO servers: `pnpm dev:backend` (:3002) and `pnpm --filter @warehouse/web dev` (:3000). The web app always talks to the backend.

### Postgres setup (shared)

The backend expects a running PostgreSQL server. A Docker Compose service is provided at the repo root:

```bash
docker compose up -d
```

Backend migrations are applied automatically on startup. To generate migrations after schema changes:

```bash
pnpm --filter @warehouse/backend db:generate
```

Backend tests use the `TEST_DATABASE_URL` database (default `warehouse_backend_test`) and run serially because they share one test database.

For Android live reload, `capacitor.config.ts` defaults `server.url` to `http://127.0.0.1:3000`, and `adb reverse` tunnels the device's loopback ports back to the dev machine: run the web dev server (`pnpm --filter @warehouse/web dev`) and backend (`pnpm dev:backend`), then `pnpm --filter @warehouse/web cap:android:dev` — it runs `scripts/cap-android-proxy.mjs` (`adb reverse tcp:3000` + `tcp:3002`, so the default `apiBaseUrl` `http://127.0.0.1:3002` works on-device too), syncs, and opens Android Studio. Re-run `cap:android:proxy` after every device reconnect/reboot (`adb reverse` does not persist). Reinstall the APK after changing `capacitor.config.ts` — the config is packaged into the APK assets. Known issue: on the current Capacitor version live reload may fail with a native bridge `Cannot read properties of undefined (reading 'triggerEvent')` error; use the bundled build below in that case.

Device networking notes (bundled builds verified on a real device):

- `capacitor.config.ts` sets `server.androidScheme: "http"` — required so LAN `http://` API calls are not blocked as mixed content (the default `https://localhost` origin would also miss the API CORS allowlist). `AndroidManifest.xml` carries `android:usesCleartextTraffic="true"` for the same reason.
- Never run `pnpm generate` while the web dev server is running: both share `.nuxt/dist/client`, and the dev server pollutes the static export with dev URLs (`@vite/client`, absolute-path entries). Stop the dev server first, then generate.
- **`127.0.0.1` vs `localhost` on devices.** The defaults use `127.0.0.1` because some ROMs' WebViews (observed on the NLS-MT95, Android 11 / WebView Chrome 114) fail to resolve the hostname `localhost` — every fetch dies with `TypeError: Failed to fetch` and the app shows the server-down overlay even though `adb reverse` is set and the backend is healthy. Numeric loopback (`127.0.0.1`, `::1`) always works. To check a new device, do NOT test in the device browser (standalone Chromium hardcodes `localhost` → loopback, so it lies) — test inside the app's WebView via CDP instead:
  1. `adb shell cat /proc/net/unix | grep webview_devtools` — find `webview_devtools_remote_<pid>` for the app's pid (`adb shell ps | grep warehousedemo`).
  2. `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`, then `curl http://localhost:9333/json` to get the page's `webSocketDebuggerUrl`.
  3. Over that websocket send `Runtime.evaluate` with `awaitPromise: true` for `fetch('http://localhost:3002/health').then(r=>r.status).catch(e=>''+e)` and the same with `127.0.0.1`. If `localhost` fails and `127.0.0.1` returns 200, the device needs the numeric defaults (which is why they are the defaults).

### Demo reset

- **Backend:** `POST :3002/dev/reset` truncates the Postgres database and re-seeds it.
- **Web:** the reset control in `components/AppHeader.vue` calls `warehouse.resetDemoData()`, which hits `POST /dev/reset` through the backend adapter.

### Native Android build / install on a connected device

When the web assets have changed, regenerate and sync first. `capacitor.config.ts` defaults `server.url` to the dev server, so bundled syncs must go through the helper script (it sets `CAPACITOR_SERVER_URL=off`; set `NUXT_PUBLIC_API_BASE_URL` to the hosted backend first for production builds):

```bash
NUXT_PUBLIC_API_BASE_URL=http://<backend-host>:3002 pnpm generate
node scripts/cap-android-bundled.mjs
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

## Code conventions

- Follow existing patterns. Make minimal, focused changes.
- Keep files small and single-responsibility.
- Put Vue composables in `composables/` and shared helpers in `utils/`.
- New data access goes through `WarehouseService` (`useWarehouse()`), which talks HTTP to `apps/backend` (:3002). List pages reload on `onMounted` plus `visibilitychange`/`focus` events so Capacitor behaves correctly; prefer the shared `useVisibleReload(load)` composable for this lifecycle wiring.
- Use shared presentation primitives on detail pages: `DetailRow`, `ScanFab`, `EmptyState`, and composables `useStatusBadge`, `useLabelScanReview`. Status badges are rendered inline with `badgeClass` and `useStatusBadge` / `statusLabel` helpers. Keep page-specific sub-views in `components/<page>/`.
- Prefer explicit, readable names over clever abstractions.

## Testing

- Backend: `pnpm --filter @warehouse/backend test` (node:test, needs Postgres).
- Web: `pnpm --filter @warehouse/web test` (vitest).

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

- **Demo passwords only.** The seed uses well-known demo passwords (`operator` / `DocPal2026!`, `admin` / `DocPalAdmin2026!`) — they are scrypt-hashed at seed time, but change them before any real deployment.
- **Native scanning.** The Android native `RectangleDetection.scanLabel()` flow is still used for camera-based label capture where implemented.
- **Hardware scanner delivery.** The Capacitor app receives hardware scans two ways: the `ScannerBroadcast` plugin (`apps/web/android/.../ScannerBroadcastPlugin.java`, wrapped by `composables/useScannerBroadcast.ts`) listens for the scanner service's intent broadcast `com.wclsolution.docpal.action.BARCODE_SCANNED` (extra `barcode`) and is the fast path; `useHardwareScanner` also keeps the keyboard-wedge fallback (key events buffered until Enter) for browser dev and unconfigured devices. The plugin receives via a context-registered receiver (implicit broadcasts) plus the manifest component `ScannerBroadcastReceiver` (explicit package/class-targeted broadcasts); both share one dispatch path that suppresses duplicate deliveries of the same value within 400 ms. After a broadcast scan the composable eats wedge key echo for 1.5 s so the "Output to broadcast/keyboard" device mode does not double-scan. Device setup (one-time, scanner Function settings / directional output): Barcode data output mode = "Output to broadcast", PackageName = `com.docpal.warehousedemo`, ClassName = `com.docpal.warehousedemo.ScannerBroadcastReceiver`, Scan Result Action = the action above (Enable Intent ON), Scan Result Data Key = `barcode` (the firmware's misspelled default `bacode` is also accepted); verify with `adb logcat -s ScannerBroadcast` (this ROM suppresses DEBUG log lines — the plugin logs at INFO).
- **Capacitor web assets.** Bundled builds: `pnpm generate` then `node scripts/cap-android-bundled.mjs` (sets `CAPACITOR_SERVER_URL=off`) so the native app receives the static build from `.output/public`. For dev live reload, use `pnpm cap:android:dev` instead (dev-server URL + `adb reverse`).
- **Android only.** iOS platform is not configured.
- **Server-down handling.** Two layers: (1) WebView can't load the app at all (dev server down) — `server.errorPath: 'maintenance.html'` in `capacitor.config.ts` shows the bundled `public/maintenance.html`, which auto-retries every 10 s and has an advanced "change server URL" override (persisted in the WebView's localStorage; `allowNavigation: ['*']` keeps the override inside the app); (2) app loads but the backend API is down — `composables/useServerHealth.ts` (started in `app.vue`) polls `GET /health` every 20 s + on resume, `apiClient` reports fetch-level failures to it, and `components/ServerDownOverlay.vue` covers the screen until the backend recovers.
