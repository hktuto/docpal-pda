# Agent Instructions

pnpm monorepo proof-of-concept for warehouse mobile/Android flows: `apps/web` (Nuxt 3 client, shipped to Android via Capacitor), `apps/backend` (`@warehouse/backend` — Hono + Drizzle + PostgreSQL, :3002), `apps/admin` (desktop admin console). The web app always talks to `apps/backend` over HTTP through a single adapter layer. The retired `apps/api`, native `apps/android` (Kotlin POC), and `packages/shared` were deleted 2026-07; their history lives in git and the `docs/superpowers/` specs.

**Authoritative references — read these before non-trivial backend work instead of relying on memory:** route catalog `docs/backend/api-design.md`, SSE event catalog `docs/backend/event-catalog.md`, table-by-table schema `docs/backend/schema-tables.md`, design specs `docs/superpowers/specs/`.

## Tech stack

- **Workspace:** pnpm monorepo — `apps/web`, `apps/backend`, `apps/admin`, `layers/i18n` (shared Nuxt i18n layer: `@nuxtjs/i18n` config, `i18n/locales/{en-US,zh-CN,zh-HK}.ts`, `warehouse-locale` localStorage persistence; apps add only `extends: ["../../layers/i18n"]`).
- **Backend (`apps/backend`):** Hono + Drizzle + PostgreSQL (`postgres` driver, `DATABASE_URL` overrides). Port `3002`, database `warehouse_backend`; tests against `TEST_DATABASE_URL` (default `warehouse_backend_test`). Migrations auto-apply on startup. Backend docs: `docs/backend/`.
  - **Schema conventions:** every table has an `id` text PK (UUID v7 via `newId()` in `src/db/id.ts` / `app_uuid_v7()` in SQL; exceptions: bigserial event-cursor tables, `BOX-*` box labels) and carries `created_date`/`last_update_date` (named `creation_date` on `parts`/`suppliers`/`supplier_profiles`/`org_info`).
  - **Keys:** `parts.part_no` is NOT unique — `wcl_item_no` is the NOT NULL UNIQUE business key; the UUID `id` is internal-only; `brand` is a plain-text supplier-code copy (no FK). Natural keys elsewhere: `receiving_orders.batch_no`, `picking_orders.id` (caller-supplied UUID; `order_no` is NOT unique). `supplier_profiles` holds PDA-local supplier QR fields and is NOT synced upstream.
  - **Stock partitioning:** one instance per warehouse (no `warehouse_code`); stock/doc tables partition by `org_id` (integer office id, 2 = HK) + `sub_inventory_code` (composite FK → `org_info`). Cross-store sharing via `sub_inventory_share_members`.
  - **Auth:** JWT bearer (HS256 via `hono/jwt`, `AUTH_SECRET`, 12 h TTL); global middleware enforces the token on all routes except `/health`, `/auth/login`, `/dev/*`; mutation actor comes from the token, never the body. When `DOCPAL_URL` is set, login delegates to the DocPal API with local user auto-provisioning and group mapping (`src/auth/docpal.ts`, `docpalGroupMapping` in `src/config.ts`); otherwise local scrypt login. User/group management lives in DocPal — no local user/group CRUD or change-password endpoint.
  - **Layering:** thin routes in `src/routes/<flow>.ts` over tx-wrapped domain modules in `src/db/<flow>.ts` (snake_code `HTTPException` errors, `actorId` in every mutation body, `transaction_logs` + `inventory_transactions` ledger rows inside the tx, best-effort `allocateAll` after stock-changing commits).
  - **Flow config:** `GET /config` from the `warehouse_config` row `"flow"` (seeded per warehouse, validated at boot); admin-editable at runtime via `GET/PUT /admin/flow-config`; `FLOW_CONFIG` env JSON override wins over the row; deprecated `FLOW_STEPS_DISABLED` still maps onto step enablement.
  - **Seed:** `src/db/seed.ts` auto-seeds reference data + shelves when `warehouse_config` is empty (masters/orders/users arrive via upstream sync / DocPal auth). `WAREHOUSE_SEED=off` disables seeding; `WAREHOUSE_SEED_DEMO=1` seeds the full demo world for local dev login; `WAREHOUSE_SEED_ORDERS=off` skips demo orders (default in prod). Demo order/stock world: edit `new_seed/demo-scenario.xlsx` → run `scripts/gen-seed-demo-scenario.mjs` → `db:seed`. Demo masters come from `scripts/gen-seed-real-data.mjs` artifacts.
  - **Allocation:** `src/db/allocate.ts` `allocateAll` — idempotent recompute per `docs/backend/concepts.md` §6 in `picking_orders.priority_seq` order; open qty = `qty − Σ picking_packages`; orders with a live PDA work lock (`POST`/`DELETE /picking-orders/:id/work-lock`, 409 `lock_held`) are skipped. `POST /dev/allocate` triggers it, `POST /dev/reset` re-seeds.
  - **Upstream sync:** performed by an external service (the ingest HTTP API and the ElectricSQL service were retired 2026-08) — it consumes the outbound `sync_events` feed (`GET /sync-events?since=`; `warehouse_sync` role writes are skipped, breaking the circular-event loop; `SYNC_DB_PASSWORD` provisions that role) or writes through the apply layer in `src/db/ingest.ts`.
- **Admin UI (`apps/admin`):** Nuxt 3 (`ssr: false`) admin console for the `/admin/*` CRUD API, plain CSS, port `3100`, `NUXT_PUBLIC_API_BASE_URL` (default `http://localhost:3002`). JWT login (admin-group membership required); generic `CrudTable`/`CrudForm` driven by `utils/entities.ts`; i18n via `layers/i18n` (zh-HK default). Navigation follows `apps/admin/TOC.md`. Run with `pnpm dev:backend` + `pnpm dev:admin`.
- **Web (`apps/web`):** Nuxt 3 (`ssr: false`), Vue 3, plain CSS, Capacitor Android shell.
  - **Data access:** pages call `WarehouseService` / `AuthService` via `useWarehouse()` / `useAuth()`; single adapter `services/adapters/backendWarehouse.ts` (+ `apiAuth.ts`) speaks HTTP to :3002 through `services/apiClient.ts` (60 s GET cache, invalidated by SSE topics and mutation prefixes). `apiBaseUrl` defaults to `http://127.0.0.1:3002` — 127.0.0.1, not localhost: some device ROM WebViews can't resolve `localhost` (see "Device networking notes"); env-overridable via `NUXT_PUBLIC_API_BASE_URL`. CORS allows every origin by default (`CORS_ORIGINS` restricts to an allowlist).
  - **List pages:** reload on mount and on visibility regain (Capacitor has no live queries); prefer `useVisibleReload(load, topics?)` with URL-prefix topics so SSE events also reload. `useWarehouseEvents.ts` holds the EventSource singleton; `useFlowSteps.ts` hides home tiles for disabled flow steps.

## Common commands

```bash
pnpm install        # install dependencies
docker compose up -d  # start the shared local Postgres service (required for dev/tests)
pnpm dev:backend                     # start the backend dev server on :3002
pnpm build:apk                       # signed release APK → apps/backend/public/apk/ (see "Production release APK")
pnpm --filter @warehouse/backend test    # backend test suite (node:test; needs Postgres + TEST_DATABASE_URL)
pnpm --filter @warehouse/backend build   # backend typecheck (tsc)
pnpm --filter @warehouse/backend db:generate  # generate Drizzle migrations after schema changes
pnpm --filter @warehouse/backend db:seed      # wipe and re-seed the demo dataset
pnpm --filter @warehouse/web dev     # start web dev server on :3103
pnpm --filter @warehouse/web test    # web test suite (vitest)
pnpm --filter @warehouse/web nuxt prepare   # generate Nuxt types; run after schema/template changes
pnpm --filter @warehouse/web build   # production build
pnpm --filter @warehouse/web generate     # static export for Capacitor
pnpm --filter @warehouse/web cap:sync     # copy web assets into native platforms
pnpm --filter @warehouse/web cap:android  # bundled build: generate, sync (server URL off), and open Android project
pnpm --filter @warehouse/web cap:android:proxy  # adb reverse tcp:3103+3002 (re-run after device reconnect)
pnpm --filter @warehouse/web cap:android:dev  # proxy + sync Android pointed at the running web dev server (live reload)
```

The web dev workflow needs TWO servers: `pnpm dev:backend` (:3002) and `pnpm --filter @warehouse/web dev` (:3103).

### Postgres setup (shared)

`docker compose up -d` starts the shared PostgreSQL service. Migrations auto-apply on backend startup; `db:generate` generates migrations after schema changes. Backend tests share one `TEST_DATABASE_URL` database and run serially.

### Android live reload and device networking

- Live reload: `capacitor.config.ts` defaults `server.url` to `http://127.0.0.1:3103`; `pnpm --filter @warehouse/web cap:android:dev` runs `adb reverse tcp:3103 tcp:3002`, syncs, and opens Android Studio. Re-run `cap:android:proxy` after every device reconnect (`adb reverse` does not persist). Reinstall the APK after changing `capacitor.config.ts` — it is packaged into the APK assets. Known issue: live reload may fail with a native bridge `Cannot read properties of undefined (reading 'triggerEvent')` error; use the bundled build in that case.
- `capacitor.config.ts` sets `server.androidScheme: "http"` and `AndroidManifest.xml` sets `android:usesCleartextTraffic="true"` — both required so LAN `http://` API calls are not blocked as mixed content.
- Never run `pnpm generate` while the web dev server is running: both share `.nuxt/dist/client`, and the dev server pollutes the static export with dev URLs. Stop the dev server first.
- **`127.0.0.1` vs `localhost` on devices.** Some ROM WebViews (observed on the NLS-MT95, Android 11 / WebView Chrome 114) fail to resolve `localhost` — every fetch dies with `Failed to fetch` even with `adb reverse` set, hence the `127.0.0.1` defaults. To check a new device, test inside the app's WebView via CDP (`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`, then `Runtime.evaluate` a `fetch('http://localhost:3002/health')` vs `127.0.0.1` over the websocket from `http://localhost:9333/json`) — do NOT test in the device browser, standalone Chromium hardcodes `localhost` → loopback and lies.

### Production docker stack

`docker-compose.prod.yml` runs the full stack (db + backend + web + admin) as a separate compose project (`warehouse-prod`) so it coexists with the dev db on :5432. Per-app Dockerfiles in `apps/*/Dockerfile` (build context = repo root). Required env: `POSTGRES_PASSWORD`, `AUTH_SECRET`; optional: `CORS_ORIGINS`, `SYNC_DB_PASSWORD`, `FLOW_CONFIG`, `WAREHOUSE_SEED=off`, `WAREHOUSE_SEED_ORDERS=on`. Ports: web 3000, admin 80, backend 9002 (also exposes 3002 internally for local-LAN access); `DEV_ROUTES=off`. When `PRODUCTION_URL` is set, web/admin `NUXT_PUBLIC_API_BASE_URL` default to `${PRODUCTION_URL}:9002`. The backend mounts `apps/backend/public/apk` read-only so `pnpm build:apk` output is served without a rebuild.

Use `scripts/deploy-prod.sh` (run on the server from the repo root) — it prompts for `PRODUCTION_URL` and `DOCPAL_URL`, preserves/generates `POSTGRES_PASSWORD`/`AUTH_SECRET` in the gitignored `.env`, then runs compose.

```bash
scripts/deploy-prod.sh
```

Or manually after filling `.env` (copied from `.env.example`):

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### Demo reset

- **Backend:** `POST :3002/dev/reset` truncates the Postgres database and re-seeds it.
- **Web:** the reset control in `components/AppHeader.vue` calls `warehouse.resetDemoData()` → `POST /dev/reset`.

### Native Android build / install on a connected device

When web assets changed, regenerate and sync first (bundled syncs must go through the helper script, which sets `CAPACITOR_SERVER_URL=off`; set `NUXT_PUBLIC_API_BASE_URL` first for production builds):

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

**Production release APK.** `pnpm build:apk` (script `apps/web/scripts/build-android-apk.mjs`) builds a signed release APK pointed at the fixed web host `${PRODUCTION_URL}:3000` (or override with `APK_WEB_URL`). Stop the web dev server first — the script refuses to run while it is up. The WebView boots from the hosted app so the Capacitor bridge keeps working (hardware scanning, camera, back button). The first-launch `/server` picker only chooses the **backend API** (`utils/serverHost.ts`, saved as `pda-server-host`). First run generates the gitignored release keystore (`apps/web/android/app/warehouse-release.keystore`) and `keystore.properties` with random passwords — keep them: Android only treats a new APK as an in-place update when the signature matches. The APK + `version.json` are published to `apps/backend/public/apk/` (gitignored), served by `GET /admin/app-download/file`, and downloaded from the admin console's `/app-download` page. Web content updates with every deploy — only native changes (or a web-host move) need a new APK.

If `adb` is not on your `PATH`, use the SDK in `android/local.properties`; on this machine `'/d/android/platform-tools/adb.exe'`.

## Code conventions

- Follow existing patterns. Make minimal, focused changes.
- Keep files small and single-responsibility.
- Put Vue composables in `composables/` and shared helpers in `utils/`.
- New data access goes through `WarehouseService` (`useWarehouse()`). List pages reload on `onMounted` plus `visibilitychange`/`focus`; prefer the shared `useVisibleReload(load)` composable.
- Use shared presentation primitives on detail pages: `DetailRow`, `ScanFab`, `EmptyState`, and composables `useStatusBadge`, `useLabelScanReview`. Keep page-specific sub-views in `components/<page>/`.
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

Dual-audience docs under `docs/app-docs/`: a human training manual for operators/trainers, and an AI lookup reference for coding agents.

- **Use:** start with `docs/app-docs/README.md` (TOC); `docs/app-docs/ai/feature-registry.md` locates which files implement a feature; `docs/app-docs/ai/code-map.md` maps pages/components to source files; read the relevant flow's `ai-scope.md` before changing behavior.
- **Maintain:** when you add, remove, or significantly change a feature, update the relevant `docs/app-docs/flows/<flow>/` files (`overview.md`, `steps.md`, `ai-scope.md`), plus `ai/feature-registry.md` and `ai/code-map.md` if files or features changed. Use `docs/app-docs/ai/scope-remark-template.md` for new AI scope blocks. Do not duplicate `README.md` or `AGENTS.md`; link to them instead.

## Demo limitations to keep in mind

- **Demo passwords only.** The seed uses well-known demo passwords (`operator` / `DocPal2026!`, `admin` / `DocPalAdmin2026!`) — change them before any real deployment.
- **Hardware scanner delivery.** Fast path: the `ScannerBroadcast` Capacitor plugin (`composables/useScannerBroadcast.ts`) receives the scanner service's intent broadcast `com.wclsolution.docpal.action.BARCODE_SCANNED` (extra `barcode`), with duplicate suppression; fallback: `useHardwareScanner` keyboard-wedge buffering. One-time device setup: output mode = "Output to broadcast", PackageName/ClassName `com.docpal.warehousedemo` / `.ScannerBroadcastReceiver`, Data Key = `barcode` (firmware's misspelled `bacode` also accepted); verify with `adb logcat -s ScannerBroadcast` (logs at INFO).
- **Android only.** iOS platform is not configured. Camera-based label capture still uses the native `RectangleDetection.scanLabel()` flow.
- **Server-down handling.** WebView can't load the app → bundled `public/maintenance.html` (`server.errorPath`, manual retry only). App loads but backend down → `useServerHealth.ts` polls `GET /health` and `components/ServerDownOverlay.vue` covers the screen, with a "change server" escape to the `/server` picker.
