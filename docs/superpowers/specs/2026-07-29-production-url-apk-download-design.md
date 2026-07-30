# Production URL APK build + admin-console APK download

Date: 2026-07-29
Status: implemented

## Problem

The PDA app needs to run against the hosted production site instead of a dev/bundled build, and the signed release APK needs a distribution channel that warehouse admins can reach without a developer machine:

1. **No production build flow.** The existing Android flows are dev live-reload (`cap:android:dev`) and a bundled static export (`cap:android`) — neither produces a signed release APK pointed at the hosted site.
2. **No signing story.** Release builds were unsigned; there was no keystore, so in-place updates on devices were impossible.
3. **No distribution channel.** The APK had to be copied to devices by hand (adb / USB), which does not scale to a warehouse rollout.

## Decisions

- **`PRODUCTION_URL` in the root `.env` stays a schemeless host** (e.g. `mobile-wms-admin.wclsolution.com`; user decision). The hosted deployment is HTTPS end-to-end — TLS terminates on the site and on the API port `:3002` — so every consumer prepends `https://` itself. Keeping the env value schemeless lets compose interpolate both the origin (`https://${PRODUCTION_URL}`) and the API base (`https://${PRODUCTION_URL}:3002`) from one value.
- **WebView loads the remote URL** (`https://<PRODUCTION_URL>`) via the existing `CAPACITOR_SERVER_URL` support in `apps/web/capacitor.config.ts` (env → `server.url` + cleartext) — no capacitor config change. Because the WebView loads the hosted SPA, **web content auto-updates with every deploy**; no Capgo/Ionic live-update plugin is needed. Only native changes (Capacitor version, plugins, config) require a new APK.
- **Release signing with a per-machine keystore, generated on first run**: `apps/web/android/app/build.gradle` loads `keystore.properties` when present (release compiles unsigned when absent, so CI/dev builds are unaffected); `apps/web/scripts/build-android-apk.mjs` generates `apps/web/android/app/warehouse-release.keystore` (keytool from `JAVA_HOME`, else the Android Studio JBR, else PATH) with two random hex passwords and writes `apps/web/android/keystore.properties`. Both files are gitignored and must be kept — Android treats an APK with the same signature as an in-place update, so losing the keystore forces a full uninstall/reinstall on every device.
- **`versionCode` auto-increments per build** (regex bump in `build.gradle` before `assembleRelease`) so each published APK is accepted as an update over the previous one; `versionName` stays manual.
- **Artifacts live in `apps/backend/public/apk/`** (gitignored): `warehouse-pda.apk` + a `version.json` (`{ versionName, versionCode, webUrl, builtAt, fileName }`) written by the build script. The prod compose stack mounts the directory read-only into the backend container (`./apps/backend/public/apk:/app/public/apk:ro`), so publishing an APK is just running `pnpm build:apk` on the host — no container rebuild.
- **JWT-protected backend routes** (`src/routes/admin/appDownload.ts`, mounted under the existing global auth middleware): `GET /admin/app-download` returns the `version.json` fields plus `sizeBytes` (404 `apk_not_available` when the version file or APK is absent); `GET /admin/app-download/file` streams the APK as `application/vnd.android.package-archive` with an attachment filename `warehouse-pda-<versionName>.apk`.
- **Admin console page `/app-download`** (Settings nav section) shows the metadata and downloads the file with an authenticated `fetch` (bearer from the stored admin token) → blob → object URL — the file endpoint is not link-navigable because the JWT travels in the `Authorization` header.
- **API base URL derivation in `docker-compose.prod.yml`**: web/admin containers default `NUXT_PUBLIC_API_BASE_URL` to `https://${PRODUCTION_URL}:3002` (still overridable via `WEB_API_BASE_URL`/`ADMIN_API_BASE_URL`), and the backend's `CORS_ORIGINS` default becomes `https://${PRODUCTION_URL}`.
- **In-app update prompt considered and deferred**: the admin page is the download channel for now; a PDA-side "new version available" check against `GET /admin/app-download` can come later if manual installs prove painful.

## Build flow (`pnpm build:apk` → `apps/web/scripts/build-android-apk.mjs`)

1. Parse `PRODUCTION_URL` from the root `.env` (exit 1 when missing); normalize to `https://…`.
2. Probe `http://127.0.0.1:3000` — abort when the web dev server answers (it pollutes `.nuxt/dist/client` with dev URLs; see AGENTS.md).
3. `pnpm --filter @warehouse/web generate`.
4. Bump `versionCode` in `apps/web/android/app/build.gradle`; capture `versionName`.
5. Generate the keystore + `keystore.properties` when absent.
6. `cap sync android` with `CAPACITOR_SERVER_URL=<webUrl>`.
7. `gradlew(.bat) assembleRelease` (JAVA_HOME fallback to the Android Studio JBR).
8. Copy `app/build/outputs/apk/release/app-release.apk` → `apps/backend/public/apk/warehouse-pda.apk` and write `version.json` next to it.

## Error codes

New: 404 `apk_not_available` (both app-download routes).

## Out of scope

- In-app update prompt / automatic APK self-update on the PDA (deferred).
- iOS (Android-only project, unchanged).
- Keystore backup/escrow automation — the keystore lives on the build machine and is the operator's responsibility.
