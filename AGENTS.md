# Agent Instructions

This is a client-side Nuxt 3 proof-of-concept for warehouse mobile/Android flows. It runs a full Postgres database in the browser using PGlite, so the demo works without a backend.

## Tech stack

- **Framework:** Nuxt 3 (`ssr: false`)
- **UI:** Vue 3, plain CSS
- **Mobile shell:** Capacitor (Android platform added)
- **Database:** PGlite — WebAssembly build of Postgres running in the browser
- **ORM:** Drizzle ORM with the `drizzle-orm/pglite` driver
- **Persistence:** IndexedDB via PGlite (`idb://warehouse-demo-pglite`)
- **List pages:** Manual `db.execute` queries that reload on mount and when the app regains visibility (Capacitor does not support `useLiveQuery`).

## Common commands

```bash
pnpm install        # install dependencies
pnpm dev            # start dev server
pnpm nuxt prepare   # generate Nuxt types; run after schema/template changes
pnpm build          # production build
pnpm generate          # static export for Capacitor
pnpm cap:sync          # copy web assets into native platforms
pnpm cap:android       # generate, sync, and open Android project
pnpm cap:android:dev   # sync Android to the running `pnpm dev` server for live reload
```

For Android live reload, run `pnpm dev` in one terminal, then run `pnpm cap:android:dev` in another. The helper script finds your machine's LAN IP and points the Android WebView at `http://<ip>:3000`. Make sure the Android device and dev machine are on the same network.

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

## Code conventions

- Follow existing patterns. Make minimal, focused changes.
- Keep files small and single-responsibility.
- Put database helpers in `db/` and Vue composables in `composables/`.
- Use manual `db.execute` queries for list pages and reload on `onMounted` plus `visibilitychange`/`focus` events so Capacitor behaves correctly. Prefer the shared `useVisibleReload(load)` composable for this lifecycle wiring.
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

- **No migrations.** The schema is created once from `db/init.ts` when the `users` table does not exist. Schema changes require clearing IndexedDB.
- **Demo passwords only.** Passwords are stored as plain-text hashes in the seed file.
- **Per-browser database.** PGlite stores data in IndexedDB, so each browser has its own isolated demo database.
- **Native scanning.** The Android native `RectangleDetection.scanLabel()` flow is still used for camera-based label capture where implemented.
- **Capacitor web assets.** Run `pnpm generate` before `pnpm cap:sync` so the native apps receive the latest static build from `.output/public`. For dev live reload, use `pnpm cap:android:dev` instead.
- **Android only.** iOS platform is not configured.
