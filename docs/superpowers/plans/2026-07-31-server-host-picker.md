# Server host picker — implementation plan

## Goal

Let the user choose which backend environment the PDA app connects to, from a list of 5 predefined regional hosts (HK/SZ/SH/GZ/BJ), persisted on-device so the app boots into the chosen environment every launch. Login page gets a "change server" button. The release APK becomes environment-agnostic (no baked `server.url`).

Predefined hosts:

- HK `https://wms-hk.docpal.weltronics.com`
- SZ `https://wms-sz.docpal.weltronics.com`
- SH `https://wms-sh.docpal.weltronics.com`
- SH = sh, GZ = gz, BJ = bj (same pattern)
- plus a `http://127.0.0.1:3000` "Local (dev)" entry only when `import.meta.dev`

No free-text custom URL entry.

## Key design constraint (validated against the code)

localStorage is origin-scoped, so the saved host can only be read by pages on the origin where it was written. Therefore:

- The release APK boots **bundled** (`CAPACITOR_SERVER_URL=off`, WebView origin = `http://localhost`). A boot plugin on that origin reads the saved host and hard-redirects. Picker page and `maintenance.html` also live on the bundled origin, so all three share one localStorage key.
- The login-page button, when the app is currently served from a remote host, navigates the WebView back to the bundled picker via `http://localhost/?picker=1` (`allowNavigation: ['*']` in `capacitor.config.ts:29` already permits this).
- Dev live reload is unaffected: `capacitor.config.ts` keeps its `http://127.0.0.1:3000` dev default; the boot plugin only redirects when the origin is the bundled `localhost`, which the dev-server origin is not.
- API base URL needs no handling: the chosen host serves the app with its own `apiBaseUrl` runtime config, so content and API always match.

## Changes

### 1. `apps/web/utils/serverHost.ts` (new)

- `SERVER_HOST_STORAGE_KEY = "pda-server-host"`.
- `SERVER_HOSTS`: array of `{ id: "hk" | "sz" | "sh" | "gz" | "bj", url }` with the 5 hosts above.
- `getServerHostOptions()`: returns `SERVER_HOSTS`, plus `{ id: "local", url: "http://127.0.0.1:3000" }` when `import.meta.dev`.
- `getSavedServerHost()` / `saveServerHost(url)` / `clearSavedServerHost()`: localStorage wrappers (try/catch, SSR-safe).
- `isBundledOrigin()`: `Capacitor.isNativePlatform() && window.location.hostname === "localhost"`.

### 2. `apps/web/plugins/serverHost.client.ts` (new)

Client plugin, runs before mount. Only when `isBundledOrigin()`:

- If URL has `?picker=1` → `return navigateTo("/server")` (show picker even though a host is saved).
- Else if a host is saved → `window.location.replace(savedHost)` (hard navigation; app mount aborts).
- Else → `return navigateTo("/server")` (first launch: no choice yet).

Non-native / non-bundled contexts (browser dev, live reload, remote-served app): no-op.

### 3. `apps/web/pages/server.vue` (new)

- `definePageMeta({ layout: false })`, styled like `login.vue` (same card/gradient idiom).
- Lists `getServerHostOptions()` as large tap targets: region label (i18n `server.regions.hk` etc. — 香港/深圳/上海/廣州/北京/Local) + URL in mono; radio-style highlight of the currently saved host.
- Tap a host → `saveServerHost(url)` → `window.location.href = url`.
- When on bundled origin this is the whole flow; when reached in browser dev it just saves + navigates.

### 4. `apps/web/middleware/auth.global.ts`

Add `/server` to the public-route bypass (like `/login` — always allowed, no redirect-to-`/`) so the picker is reachable logged in or out.

### 5. `apps/web/pages/login.vue`

- Add a secondary "變更伺服器" button under the submit button (i18n `login.changeServer`).
- Handler: `isBundledOrigin()` or non-native → `navigateTo("/server")`; otherwise (native, remote origin) → `window.location.href = "http://localhost/?picker=1"`.
- Optionally show the current host under the button (small muted text, `window.location.origin` when remote) — helps support confirm which env a device is on.

### 6. `apps/web/public/maintenance.html`

- `targetUrl()` prefers `localStorage["pda-server-host"]`, then the legacy `pda-server-url-override`, then `DEFAULT_URL` (build-stamped).
- The advanced override input now writes `pda-server-host`; "回復預設" clears both keys.
- Keeps working standalone (plain JS, no imports) since it shares the bundled origin's localStorage.

### 7. `apps/web/scripts/build-android-apk.mjs`

- Step f: sync with `CAPACITOR_SERVER_URL: "off"` instead of `webUrl` — the APK now boots bundled and the picker chooses the environment. Update the step comment.
- Keep the maintenance-page `DEFAULT_URL` stamping (step c2) as the last-resort fallback, and keep `webUrl` in `version.json`.

### 8. i18n — `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`

- `login.changeServer` ("Change server" / 更改伺服器 / 更改服务器).
- New `server` section: `title`, `subtitle`, `current`, `select`, `regions.{hk,sz,sh,gz,bj,local}`.

### 9. Docs (per project workflow)

- `docs/superpowers/specs/2026-07-31-server-host-picker-design.md` — the design (origin-scoping rationale, boot flow, key unification).
- `docs/superpowers/plans/2026-07-31-server-host-picker.md` — this plan.
- `AGENTS.md`: update the `build:apk` description (APK no longer bakes `PRODUCTION_URL` as the WebView URL; server chosen via first-launch picker; `PRODUCTION_URL` only stamps the maintenance fallback) and note the picker page where the maintenance-page override is described.

### 10. Test — `apps/web/utils/serverHost.test.ts` (new, vitest)

- Options list: 5 hosts in order; localhost entry present/absent by dev flag.
- save/get/clear round-trip with a localStorage stub; `isBundledOrigin` logic (mock `Capacitor.isNativePlatform` + `window.location`).

## Verification

1. `pnpm --filter @warehouse/web test` and `pnpm --filter @warehouse/web nuxt prepare`.
2. Build + install on the connected device (`MFM5PRE526010002`):
   - temp-set `PRODUCTION_URL` port in `.env`, `PATH` incl. `apps/web/node_modules/.bin`, `pnpm build:apk`, restore `.env`, `adb install -r` (signature now matches, in-place update).
3. On device:
   - First launch (after clearing app data) → picker appears; choose HK → app loads from `https://wms-hk.docpal.weltronics.com`.
   - Kill + relaunch → boots straight into HK.
   - Login page → 變更伺服器 → picker reopens on bundled origin → choose another region → app switches.
   - With the chosen host unreachable → maintenance page shows and retries the chosen host.

## Out of scope / deliberate non-changes

- `capacitor.config.ts` keeps the dev `server.url` default (live reload depends on it).
- No `@capacitor/preferences` native plugin — localStorage suffices because boot, picker, and maintenance all live on the bundled origin.
- No custom free-text host entry in the picker (per decision); the maintenance page's advanced override remains as the escape hatch.
