# Backend server picker design (2026-08-13)

Supersedes `2026-07-31-server-host-picker-design.md` (boot redirect to a
user-chosen web host). The picker page `/server` survives, but it now only
chooses which **backend API** the app calls — the WebView never leaves its
configured origin again.

## Problem with the old design

The old picker saved a web host URL and `plugins/serverHost.client.ts` did
`window.location.replace(host)` at boot, moving the WebView from the bundled
origin (`http://localhost`) to a remote host. That silently broke every
Capacitor native plugin:

- The Capacitor JS bridge (`window.Capacitor`) is injected by the native layer
  for **exactly one origin — the app URL** (`Bridge.java`, document-start
  script with `Collections.singleton(allowedOrigin)`; the `WebViewLocalServer`
  fallback also only intercepts the local origin).
- On the remote origin `registerPlugin('ScannerBroadcast')` has no bridge and
  `addListener` throws "not implemented on android" — swallowed by the `void`
  call in `useHardwareScanner.ts`, so hardware scanning via the scanner-service
  broadcast died silently. Delivery
  (`evaluateJavascript("window.Capacitor.triggerEvent(...)")`) would no-op
  anyway. `RectangleDetection` (camera capture) and `@capacitor/app`
  back-button handling broke the same way. Only the keyboard-wedge fallback
  survived.
- `allowNavigation: ['*']` kept the navigation inside the WebView but does not
  extend bridge injection.

Key insight: the bridge follows whatever the app URL is — including a remote
one (this is why dev live-reload with `server.url = http://127.0.0.1:3103` has
working plugins on-device). What cannot work is switching origin at runtime.

## Design

- **Fixed web host at build time.** `scripts/build-android-apk.mjs` syncs with
  `CAPACITOR_SERVER_URL = ${PRODUCTION_URL}:3000` (the prod web container port,
  e.g. `http://192.168.5.116:3000`). The WebView boots directly from the hosted
  app: the bridge is injected on that origin, native plugins work, and web
  content still updates with every deploy. `allowNavigation: ['*']` removed.
- **Picker = backend switch.** `utils/serverHost.ts` `SERVER_HOSTS` now lists
  backend API base URLs (`:9002`, the prod backend port; local dev entry
  `http://127.0.0.1:3002`). The saved value under the unchanged
  `pda-server-host` localStorage key is applied by `getApiBaseUrl()` — saved
  choice, else the runtime-config `apiBaseUrl` default. All API consumers go
  through it: `useWarehouse`, `useAuth`, `useServerHealth` (`/health` ping),
  `useWarehouseEvents` (SSE `EventSource`).
- **Choosing a backend** (`pages/server.vue`) calls `switchServerHost(url)` —
  saves the URL and clears backend-scoped state (session keys
  `warehouse-token`/`warehouse-user-id`/`warehouse-user`, `wms-cache:*` SWR
  cache entries, the `wms-events-last-id` SSE cursor; locale preference kept) —
  then reloads the page. No navigation, same origin.
- **Migration:** saved values ending in `:3000`/`:3103` (web hosts stored by
  the boot-redirect builds) are discarded on read, so upgraded devices land on
  the picker again instead of calling an API at the web port.
- **First launch / forcing the picker:** `middleware/00-server-host.global.ts`
  redirects to `/server` on the native platform when no backend is saved (or
  `?picker=1`); skipped under `import.meta.dev` and in the browser.
- **Reachability surfaces:**
  - Web host down → bundled `public/maintenance.html` (`errorPath`) retries the
    configured app URL only. The free-text WebView-level override was removed —
    navigating to another origin is exactly what kills the bridge.
  - Backend down (app loaded) → `useServerHealth` overlay. The overlay now has
    a "Change server" escape hatch (native only) to `/server`, and never
    covers the picker route itself; the health watchdog doesn't start until a
    backend is chosen, so first boot isn't covered by a false overlay.
  - Login page "change server" button navigates in-app to `/server` and shows
    the effective API base URL.

## Deploy note

Backend CORS defaults to allow-all (`CORS_ORIGINS` unset; Bearer-header auth,
no cookies), so any web host origin can call any backend with no per-origin
setup. Set `CORS_ORIGINS` on a backend to restrict it to an allowlist.

## Trade-offs

- Changing the **web host** requires a rebuild/redeploy of the APK (was:
  runtime choice). Backend switching stays runtime.
- The stale-value migration keys off the port (`:3000`/`:3103`); a backend
  legitimately served on port 3000 would be discarded — not a case in any
  current environment (backends are `:9002` prod / `:3002` dev).
