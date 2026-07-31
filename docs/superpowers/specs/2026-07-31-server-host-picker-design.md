# Server host picker — design

Date: 2026-07-31
Status: implemented
Plan: `docs/superpowers/plans/2026-07-31-server-host-picker.md`

## Problem

The production APK baked one `server.url` (`PRODUCTION_URL`) into
`capacitor.config.ts`, so moving a device between environments meant
rebuilding and reinstalling the APK. The only runtime escape hatch was the
maintenance page's advanced override — visible only when the site was
already down.

## Goal

A first-launch server picker page listing 5 predefined regional hosts
(HK/SZ/SH/GZ/BJ at `https://wms-<region>.docpal.weltronics.com:3000`, plus a
`http://127.0.0.1:3000` local entry in dev builds only), persisted on-device
so every later launch boots straight into the chosen environment. The login
page gets a "change server" button. One APK build serves all environments.

## Key constraint: localStorage is origin-scoped

A value saved by the app served from `https://wms-hk...` is invisible to any
other origin, and the native WebView loads `server.url` before any JS runs —
so "read localStorage at boot and redirect" only works if the boot page,
the picker, and the storage all live on **one fixed origin**.

## Design

- **The APK always boots bundled.** `build-android-apk.mjs` syncs with
  `CAPACITOR_SERVER_URL=off`, so the WebView starts from the bundled assets
  at the fixed local origin `http://localhost` (`androidScheme: "http"`).
- **Boot plugin** (`apps/web/plugins/serverHost.client.ts`) runs before
  render, only when `isBundledOrigin()` (native + hostname `localhost`):
  saved host → `window.location.replace(host)`. Routing to the picker lives
  in **`middleware/00-server-host.global.ts`** (alphabetically before
  `auth.global.ts`): on the bundled origin, every route redirects to
  `/server` until a host is chosen or `?picker=1` is present. Any other
  context (browser dev, dev live reload at `127.0.0.1:3000`, remote-served
  app) is a no-op in both, so the dev workflow and the `server.url` default
  in `capacitor.config.ts` are untouched. The saved-host lookup
  (`getEffectiveServerHost`) falls back to the legacy
  `pda-server-url-override` key so older installs keep their setting.
  `app.vue` skips the server-health watchdog on the bundled origin so its
  placeholder `apiBaseUrl` can't raise a false overlay over the picker.
- **Picker page** (`apps/web/pages/server.vue`, public route) lists the
  hosts, highlights the saved one, and on tap saves + navigates.
- **Login page button** (`login.changeServer`): on the bundled origin or in
  a browser it routes to `/server`; from a remote-served app it navigates
  the WebView to `http://localhost/?picker=1` (allowed by
  `allowNavigation: ['*']`), because only the bundled origin can read/write
  the saved host.
- **API base URL needs no handling**: the chosen host serves the app with
  its own `apiBaseUrl` runtime config, so content and API always match.
- **Maintenance page unification**: boot page, picker, and
  `public/maintenance.html` share the bundled origin, so all use one
  localStorage key `pda-server-host`. The maintenance page still honors the
  legacy `pda-server-url-override` key and keeps its build-stamped
  `DEFAULT_URL` (from `PRODUCTION_URL`) as the last-resort fallback. A
  "選擇伺服器" button on it navigates to `/?picker=1` to open the picker.
- **Local (dev) entry**: the picker appends `http://127.0.0.1:3000` when
  served by the Nuxt dev server (`import.meta.dev`), or in bundled builds
  generated with `NUXT_PUBLIC_SHOW_LOCAL_SERVER_HOST=1` (runtime config
  `showLocalServerHost`) for on-device development via `adb reverse`.

## Trade-offs

- Brief flash of the bundled app before the boot redirect on cold start.
- If the chosen host is unreachable, the WebView error lands on the bundled
  maintenance page, which now retries the chosen host.
- localStorage instead of `@capacitor/preferences`: no new native plugin,
  sufficient because every reader/writer lives on the bundled origin.
- No free-text custom host in the picker (decided with the user); the
  maintenance page's advanced override remains the escape hatch.
