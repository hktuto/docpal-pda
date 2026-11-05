# In-app bug report button (2026-11-05)

## Problem

Bugs found on the warehouse floor / admin console today reach the developer only verbally or via hand-written `docs/uat/bugs/BUG-*.json` rows. A report says "the scan was wrong" but carries no context: which screen, which user, what was scanned, which API call returned what. The developer cannot reproduce it.

## Decision

A floating **Report a bug** button on PDA and admin that submits a *self-contained* report: a short user note, a category chip chosen from a per-page curated list, and machine-captured context — current route, user, app version, and a ring-buffer activity trail (scans, API calls, route changes, JS errors). Reports land in a new `bug_reports` table, are triaged on a new admin page, and optionally get a `uat_ref` pointing at the UAT tracker row.

Explicitly **not** in v1 (considered and rejected):

- **Voice recording.** `getUserMedia`/MediaRecorder on the NLS-MT95 WebView class is a permission + codec + playback project to test on hardware we can't cheaply test against. Text + photo covers the same need.
- **Automatic screenshots.** DOM capture needs html2canvas (new dep, unreliable on stale WebViews); route + trail gives the developer more.
- **Sentry / GlitchTip.** Sentry answers "which JS exception fired", not "the decoded date code is wrong". The trail's `error` entries plus `window.onerror` capture cover the exception case inside the report itself. (If proactive alerting is ever wanted, GlitchTip is the light door.)
- **Server-side request logging.** The client trail already carries path/status/ms; `transaction_logs` is the mutation truth; correlate by user + time.
- **Admin-editable category vocabulary / per-flow config.** The curated lists are a static map in each app's `utils/`; a `warehouse_config` knob or CRUD page is unneeded flexibility (flow-config pattern deliberately not reused here).

## Category model

Shared snake_case vocabulary, identical on both apps, stored verbatim in `bug_reports.category`:

`scan_failed` (scanner dead / wrong decode) · `date_code` · `wrong_data` (screen shows incorrect values) · `missing_data` (rows/items missing) · `duplicate` · `label_print` · `blocked` (cannot proceed: disabled button, error loop) · `slow` · `ui_text` (layout/translation) · `login` · `other`

Each app has `utils/bugReportCategories.ts`: route-prefix → curated subset (worst ~6, always ending `other`); no match → generic shortlist `[scan_failed, wrong_data, blocked, slow, other]`. PDA examples: `put-away` → scan_failed/blocked/wrong_data/duplicate/other; `receiving` → scan_failed/date_code/wrong_data/duplicate/other; `label-printing` → label_print/blocked/other. Admin example: `receiving` → wrong_data/missing_data/duplicate/date_code/other. Single-select chips above the note field. i18n keys in all three locales (`layers/i18n`).

## Activity trail (what the developer sees)

One module-level ring buffer per app (`utils/activityLog.ts` mirrored in a `sessionStorage` key, cap ~150 entries / ~40KB) pushed from the existing choke points — **no page-level instrumentation**:

| Entry kind | Hook (existing file) | Content |
|---|---|---|
| `api` | `services/apiClient.ts` request wrapper (PDA) / `composables/useApi.ts` (admin) | `METHOD path → status in Nms`; on 4xx/5xx the short error message |
| `scan` | `useHardwareScanner` `deliver()` (PDA only) | source (`broadcast`/`wedge`/`sim`) + raw scanned value |
| `route` | `router.afterEach` wired in `layouts/default.vue` (admin: `app.vue`) | `to → fullPath` |
| `error` | `window.onerror` + `unhandledrejection` in the same layout wiring | message + `filename:lineno` |

Each entry: `{t, k, m, r}` with `r` = route at emit time, plus `session_id` (uuid, sessionStorage, one per app start) in the report context. Request/response **bodies are not logged** — path/status/ms only; a flow that needs more logs one explicit entry. Ceiling: the buffer does not survive WebView process death, so a crash report can arrive with a short trail — `transaction_logs` remains the backstop (`shortcut:` comment in `activityLog.ts`).

## Data model (migration 0054)

`bug_reports`: `id` (uuid v7) · `app` (`pda`/`admin`) · `route` · `category` (nullable = legacy/other) · `note` (text, required) · `reporter` (username from JWT, never body) · `context` jsonb (`{userAgent, sessionId, appVersion}`) · `trail` jsonb (entry array) · `photo` bytea + `photo_mime` (nullable) · `status` (`open`/`triaged`/`closed`, default `open`) · `uat_ref` (nullable text — `BUG-0xx` cross-reference) · `created_date`/`last_update_date`.

Photo is stored in the row (not disk) at UAT volume: no volume mount, no path handling, it rides pg backups. PDA resizes via canvas (≤1280px, JPEG ~0.8 → a few hundred KB) before base64-encoding into the JSON POST; server caps the decoded blob at 5 MB (413).

## API

Thin routes in `src/routes/bugReports.ts` over a tx-free insert module `src/db/bugReports.ts` (no ledger rows — this is not a business mutation):

- `POST /bug-reports` — any authenticated user; JSON `{app, route, category, note, context, trail, photo?: base64, photoMime?}`; validates note required, category in vocabulary, trail ≤ 200 KB, photo ≤ 5 MB.
- `GET /admin/bug-reports` — light list (`id, created_date, app, route, category, status, reporter`) newest-first.
- `GET /admin/bug-reports/:id` — full row incl. trail and photo (photo inline base64).
- `PATCH /admin/bug-reports/:id` — `{status?, uat_ref?, category?}`.
- `DELETE /admin/bug-reports/:id`.

No SSE topic; the admin page refetches on mount.

## UI

- **PDA**: icon button in `AppHeader` (top-right — bottom-right belongs to `ScanFab`) opening `BugReportModal.vue` (styled like `ReportIssueModal.vue`; unrelated to the operational mismatch modals). Fields: category chips, note textarea, optional `<input type="file" accept="image/*" capture="environment">`. Toast on success. Hidden on `/login` and `/server`.
- **Admin**: fixed bottom-left "🐞" button + `BugReportModal.vue` (same shape, `capture` attr dropped, file picker only). Auto-captures current route.
- **Admin triage page** `/bug-reports`: plain list (status filter chips + `SearchableSelect` category filter), row expands to note / trail (preformatted lines) / photo / context; status + `uat_ref` inline edit. Not a `CrudTable` — it's a queue, not CRUD. Register in `utils/entities.ts` nav + `TOC.md`.

## Files touched

Backend: `db/schema/bug-reports.ts` (+`schema/index.ts` export), migration 0054, `db/bugReports.ts`, `routes/bugReports.ts`, route mount. PDA: `utils/activityLog.ts`, `utils/bugReportCategories.ts`, `services/apiClient.ts` (push), `useHardwareScanner` deliver (push), `layouts/default.vue` (route/error wiring), `components/AppHeader.vue`, `components/BugReportModal.vue`, `services/WarehouseService` + `backendWarehouse.ts` (`reportBug`). Admin: same set minus scanner (`app.vue`, `composables/useApi.ts`, `components/BugReportModal.vue`, `pages/bug-reports.vue`, `utils/entities.ts` nav). i18n: three locale files, both-app key blocks. `docs/uat/functions.json`: new `PDA-*`/`ADM-*` function rows (ids appended).

## Tests

- Backend (`src/db/bugReports.test.ts` + route test): POST happy path stores reporter from token not body; note required 400; bad category 400; photo > 5 MB 413; admin PATCH/DELETE; list omits trail.
- PDA (`vitest`): `activityLog` ring cap (drops oldest at 150); `bugReportCategories` prefix match → curated list, miss → generic shortlist.
- Manual: report from a PDA put-away screen, verify in admin page the trail shows the route change, the scan, and any failed API call before submit.
