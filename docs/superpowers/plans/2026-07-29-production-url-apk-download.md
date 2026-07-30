# Production URL APK build + admin-console APK download

Spec: `docs/superpowers/specs/2026-07-29-production-url-apk-download-design.md`

## What was built

- Root `pnpm build:apk` script (`apps/web/scripts/build-android-apk.mjs`): reads `PRODUCTION_URL` from the root `.env` (schemeless host → `https://…`), refuses to run while the web dev server is up, runs `nuxt generate`, bumps `versionCode`, generates the release keystore on first run, `cap sync android` with `CAPACITOR_SERVER_URL=<webUrl>`, `gradlew assembleRelease`, and publishes `warehouse-pda.apk` + `version.json` into `apps/backend/public/apk/` (gitignored).
- Release signing in `apps/web/android/app/build.gradle`: loads `keystore.properties` when present, signs the release build, stays unsigned when absent.
- Backend routes `GET /admin/app-download` (metadata + `sizeBytes`, 404 `apk_not_available`) and `GET /admin/app-download/file` (streams the APK, `application/vnd.android.package-archive`, attachment filename) — `apps/backend/src/routes/admin/appDownload.ts`, registered in `src/routes/admin/index.ts`, under the global JWT middleware.
- Admin console page `/app-download` (Settings nav): metadata display + authenticated-fetch download button; i18n keys `admin.navLinks.appDownload` / `admin.pages.appDownload.*` in en-US/zh-CN/zh-HK.
- `docker-compose.prod.yml`: `CORS_ORIGINS` default → `https://${PRODUCTION_URL}`, web/admin `NUXT_PUBLIC_API_BASE_URL` defaults → `https://${PRODUCTION_URL}:3002` (env overrides kept), backend volume `./apps/backend/public/apk:/app/public/apk:ro`.

## File list

- `apps/web/scripts/build-android-apk.mjs` (new)
- `apps/web/android/app/build.gradle` (signing config)
- `package.json` (root `build:apk` script)
- `.gitignore` (keystore + apk dir entries)
- `apps/backend/src/routes/admin/appDownload.ts` (new)
- `apps/backend/src/routes/admin/index.ts` (route registration)
- `apps/admin/pages/app-download.vue` (new)
- `apps/admin/utils/entities.ts` (Settings nav entry)
- `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` (appDownload keys)
- `docker-compose.prod.yml` (URL derivation + apk volume)
- `AGENTS.md` (build:apk command, production APK flow, prod-stack notes)

## Verification

- `node --check apps/web/scripts/build-android-apk.mjs` — script parses.
- `pnpm --filter @warehouse/backend build` (tsc) — typecheck passes.
- `pnpm --filter @warehouse/backend test` — node:test suite passes.
- `pnpm --filter @warehouse/admin nuxt prepare` — type generation passes.
- Manual: run `pnpm build:apk` with the web dev server stopped → APK + `version.json` in `apps/backend/public/apk/`; with the backend running, `GET /admin/app-download` returns the metadata and the admin `/app-download` page downloads the APK.
