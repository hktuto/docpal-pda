# Agent Instructions

This is a pnpm monorepo proof-of-concept for warehouse mobile/Android flows: `apps/web` (Nuxt 3 client), `apps/api` (Hono API backed by better-sqlite3), and `packages/shared` (API request/response types used by both sides). The web app talks to the HTTP API by default through an adapter layer; the original in-browser PGlite database remains available behind a config flag for offline/demo use.

## Tech stack

- **Workspace:** pnpm monorepo — `apps/web`, `apps/api`, `packages/shared`
- **Web framework:** Nuxt 3 (`ssr: false`)
- **UI:** Vue 3, plain CSS
- **Mobile shell:** Capacitor (Android platform added)
- **API:** Hono on Node, better-sqlite3 (file-backed `./dev.sqlite`, `DATABASE_URL` overridable), Drizzle ORM
- **Data access (web):** Pages call `WarehouseService` / `AuthService` (`apps/web/services/warehouse.ts`, `services/auth.ts`) via `useWarehouse()` / `useAuth()`. The default adapter (`services/adapters/apiWarehouse.ts`, `apiAuth.ts`) speaks HTTP through `services/apiClient.ts`. The PGlite adapter (`services/adapters/pgliteWarehouse.ts`, `pgliteAuth.ts`) keeps the old in-browser Postgres path (Drizzle `drizzle-orm/pglite`, in-memory, re-seeded per launch); `plugins/pglite.client.ts` only starts PGlite when `warehouseAdapter === "pglite"`.
- **Adapter switch:** `apps/web/nuxt.config.ts` — `warehouseAdapter: "api"` (default) or `"pglite"`, and `apiBaseUrl` (env-overridable via `NUXT_PUBLIC_API_BASE_URL`; Capacitor device builds need a LAN-reachable host — the API's CORS allows `http://localhost:3000` and `capacitor://localhost`, and the device WebView origin is `http://localhost` because `capacitor.config.ts` sets `server.androidScheme: "http"`).
- **List pages:** Reload on mount and when the app regains visibility (Capacitor does not support `useLiveQuery`). In pglite mode these use manual `db.execute` queries; in api mode they go through `WarehouseService` → HTTP.

## Common commands

```bash
pnpm install        # install dependencies
pnpm --filter @warehouse/api dev     # start API dev server on :3001
pnpm --filter @warehouse/api test    # API test suite (node:test)
pnpm --filter @warehouse/api build   # API typecheck (tsc)
pnpm --filter @warehouse/web dev     # start web dev server on :3000
pnpm --filter @warehouse/web test    # web test suite (vitest)
pnpm --filter @warehouse/web nuxt prepare   # generate Nuxt types; run after schema/template changes
pnpm --filter @warehouse/web build   # production build
pnpm --filter @warehouse/web generate     # static export for Capacitor
pnpm --filter @warehouse/web cap:sync     # copy web assets into native platforms
pnpm --filter @warehouse/web cap:android  # generate, sync, and open Android project
pnpm --filter @warehouse/web cap:android:dev  # sync Android to the running web dev server for live reload
```

The web dev workflow needs TWO servers: `pnpm --filter @warehouse/api dev` (:3001) and `pnpm --filter @warehouse/web dev` (:3000). The web app talks to the API by default; with `warehouseAdapter: "pglite"` the API is not needed.

For Android live reload, run the web dev server in one terminal, then run `pnpm --filter @warehouse/web cap:android:dev` in another. The helper script (`scripts/cap-android-dev.mjs`) finds your machine's LAN IP, sets `CAPACITOR_SERVER_URL` (consumed by `capacitor.config.ts`), and points the Android WebView at `http://<ip>:3000`. In api mode the device also needs to reach the API, so set `NUXT_PUBLIC_API_BASE_URL=http://<ip>:3001` when starting the web dev server. Make sure the Android device and dev machine are on the same network. Known issue: on the current Capacitor version live reload fails with a native bridge `Cannot read properties of undefined (reading 'triggerEvent')` error; use the bundled build below until that is resolved.

Device networking notes (bundled builds verified on a real device):

- `capacitor.config.ts` sets `server.androidScheme: "http"` — required so LAN `http://` API calls are not blocked as mixed content (the default `https://localhost` origin would also miss the API CORS allowlist). `AndroidManifest.xml` carries `android:usesCleartextTraffic="true"` for the same reason.
- Never run `pnpm generate` while the web dev server is running: both share `.nuxt/dist/client`, and the dev server pollutes the static export with dev URLs (`@vite/client`, absolute-path entries). Stop the dev server first, then generate.

### Demo reset

- **API:** `POST /dev/reset` wipes the sqlite database and re-seeds it.
- **Web:** the reset control in `components/AppHeader.vue` calls `warehouse.resetDemoData()`, which hits `POST /dev/reset` in api mode and re-seeds PGlite in pglite mode.

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

## Native Android app (apps/android)

The native rewrite (Kotlin + Compose + Room) lives in `apps/android` as an
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

Seed data: `apps/android/app/src/main/assets/seed.sql` is generated from the
web PGlite seed (precalc preset) and imported in Room's `onCreate`. Regenerate
after seed changes with `cd apps/web && pnpm export:android-seed`.
The app id `com.docpal.warehousepda` installs side by side with the Capacitor
`com.docpal.warehousedemo`.

Phase 1 (login, home, receiving list/detail with items + picking tabs, end-to-end
scan pipeline) is complete: 143 JVM tests green, debug APK builds and installs.
Conventions inside `apps/android` (details in the Phase 1 plan's
"Phase 2 handoff notes"):

- **Layers:** `data/` holds Room (`data/db/`) plus suspend repositories that wrap
  DAO calls in `withContext(Dispatchers.IO)`; `domain/` holds the pure/sync
  business logic (`PickingRepository`, `MismatchRepository`, `AuthRepository`,
  `AllocationDistributor` for allocation math) whose transition functions
  self-wrap `db.runInTransaction`. Scan parsing/matching lives in `domain/scan/`.
- **Screens:** `ui/login`, `ui/home`, `ui/receiving` (list + detail with items
  and picking tabs, `LabelScanReviewDialog`, `ReportIssueDialog`).
- **Scan entry points:** `ui/receiving/ScanLaunchers.kt` (camera / manual /
  wedge), `HardwareKeyBuffer` (wedge key capture), `QrParser` with
  `OcrLabelParser` fallback, then `ScanMatcher`.
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
- Put database helpers in `db/` and Vue composables in `composables/`.
- New data access goes through `WarehouseService` (`useWarehouse()`), which routes to the HTTP API or the PGlite adapter depending on `warehouseAdapter`. In pglite mode, use manual `db.execute` queries for list pages and reload on `onMounted` plus `visibilitychange`/`focus` events so Capacitor behaves correctly. Prefer the shared `useVisibleReload(load)` composable for this lifecycle wiring (both modes).
- Use shared presentation primitives on detail pages: `DetailRow`, `ScanFab`, `EmptyState`, and composables `useStatusBadge`, `useLabelScanReview`. Status badges are rendered inline with `badgeClass` and `useStatusBadge` / `statusLabel` helpers. Keep page-specific sub-views in `components/<page>/`.
- Inline raw SQL is acceptable for list queries when Drizzle relations are cumbersome.
- Prefer explicit, readable names over clever abstractions.

## Testing

There is a small Android unit-test suite for the OpenCV crop logic. Run it with:

```bash
cd android
export JAVA_HOME='/c/Program Files/Android/Android Studio/jbr'
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew :app:testDebugUnitTest
```

Also verify work with:

1. `pnpm nuxt prepare` — ensure types generate without errors.
2. Manual browser check — log in as `operator` / `DocPal2026!`, navigate through the affected flows, and confirm behavior.

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

- **PGlite adapter mode only — no migrations.** With `warehouseAdapter: "pglite"` the schema is created once from `db/init.ts` when the `users` table does not exist. Because that database is in-memory, schema changes take effect on the next app launch.
- **PGlite adapter mode only — data is not persisted.** The in-memory database is re-seeded on every app launch, so each session starts fresh. In api mode data lives in the API's sqlite file and survives reloads; use `POST /dev/reset` to re-seed.
- **Demo passwords only.** Passwords are stored as plain-text hashes in the seed file.
- **Native scanning.** The Android native `RectangleDetection.scanLabel()` flow is still used for camera-based label capture where implemented.
- **Capacitor web assets.** Run `pnpm generate` before `pnpm cap:sync` so the native apps receive the latest static build from `.output/public`. For dev live reload, use `pnpm cap:android:dev` instead.
- **Android only.** iOS platform is not configured.
