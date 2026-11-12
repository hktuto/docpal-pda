# Agent Instructions

pnpm monorepo proof-of-concept for warehouse mobile/Android flows: `apps/pda` (Nuxt 3 client, shipped to Android via Capacitor), `apps/backend` (`@warehouse/backend` — Hono + Drizzle + PostgreSQL, :3002), `apps/admin` (desktop admin console). The web app always talks to `apps/backend` over HTTP through a single adapter layer. `apps/pda` replaced the original `apps/web` in the 2026-10 PDA app rewrite (spec `docs/superpowers/specs/2026-10-04-pda-app-rewrite-design.md`). The retired `apps/api`, native `apps/android` (Kotlin POC), `packages/shared` (deleted 2026-07) and `apps/web` (deleted 2026-10) live in git history and the `docs/superpowers/` specs.

**Authoritative references — read these before non-trivial backend work instead of relying on memory:** route catalog `docs/backend/api-design.md`, SSE event catalog `docs/backend/event-catalog.md`, table-by-table schema `docs/backend/schema-tables.md`, design specs `docs/superpowers/specs/`. Deep-dive reference docs extracted from this file: `docs/backend/schema-conventions.md`, `docs/backend/flow-config.md`, `docs/backend/allocation.md`, `docs/backend/verify-measuring.md`, `docs/backend/label-printing.md`.

<!-- intent-skills:start -->

## Skill Loading

Before editing files for a substantial TanStack Table task (`@tanstack/vue-table` v9, used by `apps/admin`):

- Browse the skills bundled with the installed packages: `ls apps/admin/node_modules/@tanstack/vue-table/skills/` and `ls apps/admin/node_modules/@tanstack/table-core/skills/`.
- Read the `SKILL.md` files relevant to the task (start with `vue-table/skills/getting-started`, which requires `table-core/skills/core` and `table-core/skills/table-features`) before changing table code, and follow them — v9 APIs differ from v8 (`useTable`, explicit `tableFeatures()`, no v8 rendering patterns).
- Skills are versioned with the packages; after a TanStack version bump, re-read the skills rather than relying on memory.

<!-- intent-skills:end -->

## Tech stack

- **Workspace:** pnpm monorepo — `apps/pda`, `apps/backend`, `apps/admin`, `layers/i18n` (shared Nuxt i18n layer: `@nuxtjs/i18n` config, `i18n/locales/{en-US,zh-CN,zh-HK}.ts`, `warehouse-locale` localStorage persistence; apps add only `extends: ["../../layers/i18n"]`).
- **Backend (`apps/backend`):** Hono + Drizzle + PostgreSQL (`postgres` driver, `DATABASE_URL` overrides — append `?search_path=%22Schema%22` to target a non-`public` schema). Port `3002`, database `warehouse_backend`; tests against `TEST_DATABASE_URL` (default `warehouse_backend_test`). Migrations auto-apply on startup (`DB_MIGRATE=off` skips them for externally-provisioned schemas — the migration SQL hardcodes `"public"` FK targets and is not schema-agnostic). Backend docs: `docs/backend/`.
  - **Schema conventions + keys:** every table has an `id` text PK (UUID v7; exceptions: bigserial event-cursor tables, `BOX-*` box labels) and `created_date`/`last_update_date`. `parts.part_no` is NOT unique — `wcl_item_no` is the business key; `supplier_profiles` drives scan-template lookup and label-field decoding. NCC labels carry the numeric drawing code as itemId; `lookupPartsByDrawingNo` (`src/db/partDrawno.ts`) resolves it via the externally-managed `wcl_part_drawno` table (drawno exact match, then substring) in the receiving scan + `/scan/decode`. TE labels may print a truncated MPN; the receiving scan + `/scan/decode` TE branches resolve the real `part_no`/`wcl_item_no` from `parts` (`lookupPartKeyCandidates` — normalized equality on `idx_parts_norm_*`, then `ILIKE` substring on `pg_trgm` GIN indexes, migrations 0051/0052); decode replaces the parsed identity, the receiving commit retries the item match. PDA queue tables (`receiving_orders_cn`, `picking_orders`, `put_away_tasks`, `put_away_tasks_cn`, `verify_tasks`, `shipping_boxes`, `put_back_tasks`) carry a nullable `assignee` username (no FK; NULL = visible to all, set = only that user sees the task) filtered server-side via `assigneeFilter` in `src/db/user-scope.ts` and admin-managed via `GET /admin/task-assignments` / `PATCH /admin/task-assignment` (spec `docs/superpowers/specs/2026-11-01-task-assignee-design.md`; labeling/label-printing/packaging assignee lives on `picking_tasks` side rows keyed by step, put-back on `put_back_tasks`; the packaging queue itself is derived SQL over `picking_orders.packaged_at` — no task table). `put_back_tasks` rows also start `awaiting` — created by the cancel-invoice cron but held out of the PDA queue until an admin confirms the cancel on `/admin/cancel-records` (where they can record the replacement invoice; spec `docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md`). Details: `docs/backend/schema-conventions.md`.
  - **Stock partitioning:** one instance per warehouse (no `warehouse_code`); stock/doc tables partition by `org_id` (integer office id, 2 = HK) + `sub_inventory_code` (composite FK → `org_info`). Cross-store sharing via `sub_inventory_share_members`.
  - **Auth:** JWT bearer (HS256 via `hono/jwt`, `AUTH_SECRET`, 12 h TTL); global middleware enforces the token on all routes except `/health`, `/latency-ping`, `/auth/login`, `/auth/login-token`, `/dev/lab*` (the tokenless browser label-tool); `/dev/allocate` requires the token, and the boot fails closed when `DEV_ROUTES=off` without `AUTH_SECRET`; mutation actor comes from the token, never the body. Login always delegates to the DocPal API with local user auto-provisioning and group mapping (`src/auth/docpal.ts`) — `DOCPAL_URL` is required (no local password login). User/group management lives in DocPal.
  - **Layering:** thin routes in `src/routes/<flow>.ts` over tx-wrapped domain modules in `src/db/<flow>.ts` (snake_code `HTTPException` errors, actorId in every mutation domain call — always derived from the JWT via `actorFrom(c)`, never read from the body, `transaction_logs` + `inventory_transactions` ledger rows inside the tx, allocation recompute manual-only — per-order Re-allocate / confirm-arrival). `src/decode/` is the label-decode authority — DB-backed supplier QR decode (`POST /scan/decode`: templates + month-counter periods + flow-config `dateCodeFormat`, spec `docs/superpowers/specs/2026-11-03-backend-scan-decode-design.md`; NCC drawing-code resolution via `lookupPartsByDrawingNo`); PDA label scans cut over to it 2026-11-03 (`utils/labelDecode.ts`, local OCR heuristics as the `matched:false` fallback); the admin supplier-editor preview keeps its local copy until its cutover.
  - **Flow config:** `GET /config` from the `warehouse_config` row `"flow"` (seeded per warehouse, validated at boot); admin-editable via `GET/PUT /admin/flow-config`; `FLOW_CONFIG` env JSON override wins. Key top-level knobs: `allowedOrgIds`, `outdatedStockYears`, `dateCodeFormat` (canonical YYWW vs label WWYY), `receivingSubInventoryRules`, `receivingOrderNameTemplate`, `pickingShelfScan`, `pdaViewConfig` (supersedes `pdaListTemplates`), `receiving-cn` step. Full reference: `docs/backend/flow-config.md`.
  - **Seed:** `src/db/seed.ts` auto-seeds reference data + shelves + the warehouse flow config when `warehouse_config` is empty (HK layout `src/db/seed-shelves-hk.ts`, SZ via `WAREHOUSE_CODE=sz`; masters/orders/users arrive via upstream sync / DocPal auth). `WAREHOUSE_SEED=off` disables seeding; `WAREHOUSE_SEED_DEMO=1` seeds the demo world for local dev login; `WAREHOUSE_SEED_ORDERS=off` skips demo orders (default in prod). Demo order/stock world: edit `new_seed/demo-scenario.xlsx` → run `scripts/gen-seed-demo-scenario.mjs` → `db:seed`.
  - **Allocation:** manual-only recompute (spec `docs/superpowers/specs/2026-11-03-allocation-manual-only-design.md`): mutation routes never recompute — admins press per-order Re-allocate or confirm-arrival, and UIs converge via SSE `allocation.computed`. The picking-order Re-allocate (`allocateForPickingOrder`) is **strictly single-order**: only the selected order's items are wiped/rebuilt; other orders sharing part numbers keep their rows untouched and are netted out of availability instead (spec `docs/superpowers/specs/2026-11-05-picking-reallocate-single-order-design.md`). Confirm-arrival / receiving Re-allocate (`allocateForReceivingOrder`) keeps the part-key scope: it rebuilds ALL open demand for the affected part keys in `picking_orders.priority_seq` order, skipping work-locked orders. `allocateAll` (fleet-wide wipe/rebuild) is dev/test-only via `POST /dev/allocate`; it is skipped for work-locked orders and lacks the scoped core's dock pre-passes (PO match / date-code-gated qty perfect match — spec `docs/superpowers/specs/2026-11-05-allocation-dock-match-ordering-design.md`). Manual pins (`allocations.manual`) survive wipe/rebuild; admin per-item add/remove/transfer actions exist. Full reference: `docs/backend/allocation.md`.
  - **Upstream sync:** performed by an external service — it reads the outbound `sync_events` table-change feed directly (the `GET /sync-events?since=` endpoint was removed 2026-10; `warehouse_sync` role writes are skipped; `SYNC_DB_PASSWORD` provisions that role) and writes the business tables directly, including the CN receiving trio (`receiving_orders_cn`/`receiving_invoices_cn`/`receiving_invoice_items_cn`). The admin CN Excel upload also writes the CN trio directly (locally decoded, pending orders — spec `docs/superpowers/specs/2026-11-08-receiving-cn-excel-local-upload-design.md`; multi-invoice/multi-brand truck manifests (車單) are auto-detected and split client-side into one pending order per `INVOICE NO` — spec `docs/superpowers/specs/2026-11-10-receiving-cn-truck-manifest-upload-design.md`). Similarly the admin picking list's "New VMI" Excel upload batch-creates real picking orders client-side-decoded + gated (`POST /admin/picking-orders/vmi-create`, `picking_order_type='vmi'` — vmi rides the invoice branch of `pickingOrderOrgFilter`; spec `docs/superpowers/specs/2026-11-09-vmi-picking-excel-upload-design.md`).
  - **Verify/measuring re-scan (aggregate):** `picking_packages.rescanned_qty` is the re-scan credit — completion everywhere is `rescanned_qty >= qty`; matching is aggregate client-side (totals per part + batch fields, FIFO partial credits). A labeling stage sits between picking finish and measuring/verify when enabled. Full reference: `docs/backend/verify-measuring.md`.
  - **Printing:** `/print/*` proxies the label-printing-center service (`PRINT_API_BASE_URL`); `label_print_rules` (managed via `/admin/label-print-rules`) picks the template per picking label, consumed by the PDA picking-finish print prompt; prints recorded in `label_prints`. Full reference: `docs/backend/label-printing.md`.
- **Admin UI (`apps/admin`):** Nuxt 3 (`ssr: false`) admin console for the `/admin/*` CRUD API, plain CSS, port `3100`, `NUXT_PUBLIC_API_BASE_URL` (default `http://localhost:3002`). JWT login (admin-group membership required); generic `CrudTable`/`CrudForm` driven by `utils/entities.ts`; i18n via `layers/i18n` (zh-HK default). Navigation follows `apps/admin/TOC.md`; nav links can be gated by flow steps via `composables/useFlowSteps.ts` (the CN receiving link follows the `receiving-cn` step). Run with `pnpm dev:backend` + `pnpm dev:admin`.
  - **Filter dropdowns:** use `components/SearchableSelect.vue` for filter selects instead of plain `<select>` — searchable dropdown, multi-select by default (`v-model: string[]`, empty selection = "all"); pass `multiple: false` for single-select (`v-model: string`, `""` = "all"). Other props: `options: {value, label}[]`, `allLabel`, `ariaLabel`. Reference usage: `pages/stock-search.vue`. Multi-value backend filters take repeated query params (any-of `IN`), e.g. `GET /stock-search?brand=A&brand=B`.
- **Web (`apps/pda`):** Nuxt 3 (`ssr: false`), Vue 3, plain CSS, Capacitor Android shell.
  - **Data access:** pages call `WarehouseService` / `AuthService` via `useWarehouse()` / `useAuth()`; single adapter `services/adapters/backendWarehouse.ts` (+ `apiAuth.ts`) speaks HTTP to :3002 through `services/apiClient.ts` (plain fetch wrapper; no client-side cache — pages refetch on mount, visibility regain, and SSE topics). `apiBaseUrl` defaults to `http://127.0.0.1:3002` — 127.0.0.1, not localhost: some device ROM WebViews can't resolve `localhost` (see "Device networking notes"); env-overridable via `NUXT_PUBLIC_API_BASE_URL`. CORS allows every origin by default (`CORS_ORIGINS` restricts to an allowlist).
  - **List pages:** reload on mount and on visibility regain (Capacitor has no live queries); prefer `useVisibleReload(load, topics?)` with URL-prefix topics so SSE events also reload. `useWarehouseEvents.ts` holds the EventSource singleton; `useFlowSteps.ts` hides home tiles for disabled flow steps.
  - **Fleet WebView is Chrome 101 — no newer JS APIs.** The T23X devices run the Android system WebView `com.android.webview` 101.0.4951.61 (Android 13), and the ROM pins it there. Client code must not use Web APIs newer than Chrome 101: `AbortSignal.timeout` (103) broke every apiClient call as a fetch-level "network error" on these devices (BUG-043, commit 995a72a4 — deadline now uses `AbortController` + `setTimeout`, same as `useServerHealth`). Nothing in the build pipeline warns about Web API age, so check caniuse-level support against Chrome 101 when introducing a new browser API.

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
pnpm --filter @warehouse/pda dev     # start web dev server on :3103
pnpm --filter @warehouse/pda test    # web test suite (vitest)
pnpm --filter @warehouse/pda nuxt prepare   # generate Nuxt types; run after schema/template changes
pnpm --filter @warehouse/pda build   # production build
pnpm --filter @warehouse/pda generate     # static export for Capacitor
pnpm --filter @warehouse/pda cap:sync     # copy web assets into native platforms
pnpm --filter @warehouse/pda cap:android  # bundled build: generate, sync (server URL off), and open Android project
pnpm --filter @warehouse/pda cap:android:proxy  # adb reverse tcp:3103+3002 (re-run after device reconnect)
pnpm --filter @warehouse/pda cap:android:dev  # proxy + sync Android pointed at the running web dev server (live reload)
```

The web dev workflow needs TWO servers: `pnpm dev:backend` (:3002) and `pnpm --filter @warehouse/pda dev` (:3103).

### Postgres setup (shared)

`docker compose up -d` starts the shared PostgreSQL service. Migrations auto-apply on backend startup (`DB_MIGRATE=off` disables); `db:generate` generates migrations after schema changes. Backend tests share one `TEST_DATABASE_URL` database and run serially.

### Android live reload and device networking

- Live reload: `capacitor.config.ts` defaults `server.url` to `http://127.0.0.1:3103`; `pnpm --filter @warehouse/pda cap:android:dev` runs `adb reverse tcp:3103 tcp:3002`, syncs, and opens Android Studio. Re-run `cap:android:proxy` after every device reconnect (`adb reverse` does not persist). Reinstall the APK after changing `capacitor.config.ts` — it is packaged into the APK assets. Known issue: live reload may fail with a native bridge `Cannot read properties of undefined (reading 'triggerEvent')` error; use the bundled build in that case.
- `capacitor.config.ts` sets `server.androidScheme: "http"` and `AndroidManifest.xml` sets `android:usesCleartextTraffic="true"` — both required so LAN `http://` API calls are not blocked as mixed content.
- Never run `pnpm generate` while the web dev server is running: both share `.nuxt/dist/client`, and the dev server pollutes the static export with dev URLs. Stop the dev server first.
- **`127.0.0.1` vs `localhost` on devices.** Some ROM WebViews (observed on the NLS-MT95, Android 11 / WebView Chrome 114) fail to resolve `localhost` — every fetch dies with `Failed to fetch` even with `adb reverse` set, hence the `127.0.0.1` defaults. To check a new device, test inside the app's WebView via CDP (`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`, then `Runtime.evaluate` a `fetch('http://localhost:3002/health')` vs `127.0.0.1` over the websocket from `http://localhost:9333/json`) — do NOT test in the device browser, standalone Chromium hardcodes `localhost` → loopback and lies.

### Production docker stack

`docker-compose.prod.yml` runs the full stack (db + backend + pda + admin) as a separate compose project (`warehouse-prod`) so it coexists with the dev db on :5432. Per-app Dockerfiles in `apps/*/Dockerfile` (build context = repo root). Required env: `POSTGRES_PASSWORD`, `AUTH_SECRET`; optional: `CORS_ORIGINS`, `SYNC_DB_PASSWORD`, `FLOW_CONFIG`, `WAREHOUSE_SEED=off`, `WAREHOUSE_SEED_ORDERS=on`. Ports: pda 3000, admin 8080, backend 3002; `DEV_ROUTES=off`. When `PRODUCTION_URL` is set, pda/admin `NUXT_PUBLIC_API_BASE_URL` default to `${PRODUCTION_URL}:9002`. The backend mounts `apps/backend/public/apk` read-only so `pnpm build:apk` output is served without a rebuild.

Use `scripts/deploy-prod.sh` (run on the server from the repo root) — it prompts for `PRODUCTION_URL` and `DOCPAL_URL`, preserves/generates `POSTGRES_PASSWORD`/`AUTH_SECRET` in the gitignored `.env`, then runs compose.

```bash
scripts/deploy-prod.sh
```

Or manually after filling `.env` (copied from `.env.example`):

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### Multi-warehouse instances (HK, SZ, …)

One standalone instance per warehouse — separate backend process + separate database, no `warehouse_code` column (stock partitions by `org_id` + `sub_inventory_code`). Warehouse-exclusive differences are **configurable, never git branches** — design spec: `docs/superpowers/specs/2026-10-09-multi-warehouse-configurable-design.md`. To add a warehouse (SZ is the first):

1. Create `apps/backend/src/db/seed-shelves-<wh>.ts` mirroring `seed-shelves-hk.ts` (zone groups → flattened `shelves` rows, reusing `shelfDisplayName`); fill in the real layout.
2. In `src/db/seed.ts`: import the new rows, add a `<WH>_FLOW_CONFIG` const (partial JSON merged over `defaultFlowConfig()` — set `allowedOrgIds` to the warehouse's org ids, `[]` = all orgs), and extend the `WAREHOUSE_CODE` selector in `seedReferenceOnly()` (`isSz` pattern) to seed them.
3. Deploy the new instance with its own `DATABASE_URL` and `WAREHOUSE_CODE=<wh>` (e.g. SZ: `WAREHOUSE_CODE=sz`). Tune the flow config afterwards via `GET/PUT /admin/flow-config`.

Today: HK = default (`HK_FLOW_CONFIG` + `seed-shelves-hk.ts`), SZ = `WAREHOUSE_CODE=sz` (`SZ_FLOW_CONFIG` + `seed-shelves-sz.ts`).

### Demo reset

- **Backend:** `pnpm --filter @warehouse/backend db:seed` truncates the Postgres database and re-seeds it (the `POST /dev/reset` endpoint was removed 2026-11-06 — dev DBs are remote/upstream-synced now).

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

**Production release APK.** `pnpm build:apk` (script `apps/pda/scripts/build-android-apk.mjs`) builds a signed release APK pointed at `https://<region domain>:9000` — region from `APK_REGION` (default `hk`, catalog `apps/pda/scripts/regions.json`), or override the full URL with `APK_WEB_URL`. Stop the web dev server first — the script probes :3103 and refuses to run while it is up. The WebView boots from the hosted app so the Capacitor bridge keeps working (hardware scanning, camera, back button). The first-launch `/server` picker only chooses the **backend API** (`utils/serverHost.ts`, saved as `pda-server-host`). First run generates the release keystore (`apps/pda/android/app/warehouse-release.keystore`) and `keystore.properties` with random passwords — keep them: Android only treats a new APK as an in-place update when the signature matches. ⚠ Both files are currently **committed to this repo** (the `apps/pda/android/.gitignore` keystore lines are commented out) — signing material + passwords in git history; untrack and rotate before widening repo access. The APK + `version.json` are published to `apps/backend/public/apk/` (gitignored), served by `GET /admin/app-download/file`, and downloaded from the admin console's `/app-download` page. Web content updates with every deploy — only native changes (or a web-host move) need a new APK.

If `adb` is not on your `PATH`, use the SDK in `android/local.properties`; on this machine `'/d/android/platform-tools/adb.exe'`.

## Code conventions

- Follow existing patterns. Make minimal, focused changes.
- Keep files small and single-responsibility.
- Put Vue composables in `composables/` and shared helpers in `utils/`.
- New data access goes through `WarehouseService` (`useWarehouse()` — one memoized instance per API base URL, its in-memory list caches are app-session-scoped). List pages reload on `onMounted` plus `visibilitychange`; prefer the shared `useVisibleReload(load)` composable.
- Use shared presentation primitives on detail pages: `DetailRow`, `ScanFab`, `EmptyState`, and composables `useStatusBadge`, `useLabelScanReview`. Keep page-specific sub-views in `components/<page>/`.
- Prefer explicit, readable names over clever abstractions.

## Testing

- Backend: `pnpm --filter @warehouse/backend test` (node:test, needs Postgres).
- Web: `pnpm --filter @warehouse/pda test` (vitest).

Also verify work with:

1. `pnpm nuxt prepare` — ensure types generate without errors.
2. Manual browser check — with `pnpm dev:backend` (:3002) running and `DOCPAL_URL` set, log in with a DocPal account, navigate through the affected flows, and confirm behavior.

## Feature workflow

For non-trivial changes:

1. Write a design spec in `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md`.
2. Write an implementation plan in `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`.
3. Implement, verify, and commit.
4. Record the delivered feature (and any bugs found) in the UAT tracker — see "UAT issue tracking".

## UAT issue tracking

UAT tracker sources of truth: `docs/uat/functions.json` (62 admin/PDA functions, stable `ADM-`/`PDA-` ids) plus **one file per record** — `docs/uat/bugs/BUG-*.json` and `docs/uat/features/CR-*.json` (keeps appends conflict-free and lets an agent read/update a single issue without the whole list). `UAT-Test-Tracking.xlsx` in the same folder is **generated** (gitignored, three sheets with per-function count formulas + dropdown vocabularies) — never edit the xlsx by hand; regenerate instead:

```bash
node scripts/gen-uat-xlsx.mjs   # after editing docs/uat/*.json
```

- **Add a bug/feature:** create `docs/uat/bugs/BUG-<next>.json` / `features/CR-<next>.json` (next id = highest existing + 1) copying the shape of a neighbour; `functionId` must reference an existing function id (blank allowed for features; the script refuses bad refs and duplicate ids). Dates are `YYYY-MM-DD`; vocabularies in `docs/uat/README.md`.
- **Update an issue:** edit that one small file (`status`, `retestResult`, `closedDate`).
- **Trace an issue to code:** each backfilled row carries `Backfill — commit <hash>` in `remarks` — `git show <hash>` for the fix/feature; new rows should cite the fixing commit or spec doc the same way.
- **Regeneration overwrites tester edits** — fold any marked-up workbook changes back into the JSON before rerunning, and hand the fresh xlsx to testers as the deliverable.
- When you add/remove/rename a user-facing function in admin or PDA, update `functions.json` too (keep ids stable — bugs and features reference them).

## Documentation system

Chinese developer handoff guide (self-study entry point): `docs/dev-guide-zh/` (overview + one doc per flow with Mermaid flowchart, entry components, key logic/business decisions; picking.md is the template). Links to the docs below instead of duplicating them.

Dual-audience docs under `docs/app-docs/`: a human training manual for operators/trainers, and an AI lookup reference for coding agents.

- **Use:** start with `docs/app-docs/README.md` (TOC); `docs/app-docs/ai/feature-registry.md` locates which files implement a feature; `docs/app-docs/ai/code-map.md` maps pages/components to source files; read the relevant flow's `ai-scope.md` before changing behavior.
- **Maintain:** when you add, remove, or significantly change a feature, update the relevant `docs/app-docs/flows/<flow>/` files (`overview.md`, `steps.md`, `ai-scope.md`), plus `ai/feature-registry.md` and `ai/code-map.md` if files or features changed. Use `docs/app-docs/ai/scope-remark-template.md` for new AI scope blocks. Do not duplicate `README.md` or `AGENTS.md`; link to them instead.

## Demo limitations to keep in mind

- **Demo passwords only.** The seeded demo users (`operator`, `admin`) authenticate through the test/dev fake DocPal with well-known demo passwords (`DocPal2026!` / `DocPalAdmin2026!`) — real deployments authenticate against the actual DocPal API (`DOCPAL_URL`).
- **Hardware scanner delivery (two platforms, auto-detected).** The native side detects the scanner platform (`ScannerConfig.getDeviceInfo()` → `platform`: `"xcheng"` | `"honeywell"` | `"none"` — branching happens inside the Java plugin; the unused JS wrapper was removed 2026-11-06). **Movfast/xcheng** (NLS-MT95, T23X): `ScannerBroadcast` plugin receives the scanner app's broadcast `com.wclsolution.docpal.action.BARCODE_SCANNED` (extra `barcode`, `bacode` typo also accepted) — one-time device setup per `docs/app-docs/setup/android-pda-scanner.md`; verify with `adb logcat -s ScannerBroadcast` (logs at INFO). **Honeywell** (CT32): no device setup — `HoneywellScannerClient.java` claims `dcs.scanner.imager` from the DataCollectionService over a re-implemented AIDL/JSON-RPC bridge (`com/honeywell/Message.java` + `IExecutor.java`, no Honeywell SDK aar; `com.honeywell.decode.permission.DECODE` is normal-protection), held in foreground only; scans arrive as `scanner.barcodeEvent` events (delivered via the one-way `executeAsync` — the stub must forward it to `execute`). Fallback on both: `useHardwareScanner` keyboard-wedge buffering (wedge/idle plumbing shared with `useOrderScanNav` in `utils/scannerWedge.ts`).
- **Scanner symbology whitelist (xcheng/Movfast + Honeywell).** The `ScannerConfig` Capacitor plugin (`composables/useScannerConfig.ts`, native `ScannerConfigPlugin.java`) restricts the hardware decoder to a supplier's `supplier_profiles.barcode_types`, branching by platform: xcheng via its `ENABLE/DISABLE_SCANTYPE_BROADCAST` receiver (runtime-only, device-global, restored on page leave + app start); Honeywell via DCS `scanner.setProperties` with `DEC_*` keys in `HoneywellScannerClient` (xcheng names mapped, e.g. `"QR CODE"` → `DEC_QR_ENABLED`; session-scoped while claimed). Applied by `useSupplierSymbologyScope` on receiving/put-away detail and stock-search, and by `useBrandSymbologyScope` (union whitelist via `brandWhitelistUnion`; any unmapped brand = no restriction) on the picking scan page. Screens that scan shelf/box QR labels pass `{ withShelfCodes: true }` so `SHELF_CODE_SYMBOLOGIES` stay enabled — content validation is software-side. Spec: `docs/superpowers/specs/2026-09-04-supplier-barcode-type-whitelist-design.md`.
- **Android only.** iOS platform is not configured. Camera-based label capture still uses the native `RectangleDetection.scanLabel()` flow.
- **Server-down handling.** WebView can't load the app → bundled `public/maintenance.html` (`server.errorPath`, manual retry only). App loads but backend down → `useServerHealth.ts` polls `GET /health` and `components/ServerDownOverlay.vue` covers the screen, with a "change server" escape to the `/server` picker.
