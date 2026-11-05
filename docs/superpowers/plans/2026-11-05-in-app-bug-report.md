# In-app Bug Report Button — Implementation Plan

Date: 2026-11-05
Spec: `docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md`

## Backend (`apps/backend`)

1. `src/db/schema/bug-reports.ts` (new): `bugReports` table — `id` (uuid v7 via `id()`), `app` (check `pda`/`admin`), `route`, `category`, `note`, `reporter`, `context` jsonb, `trail` jsonb, `photo` bytea, `photo_mime`, `status` (check `open`/`triaged`/`closed`, default `open`), `uat_ref`, `created_date`/`last_update_date`; index on `(status, created_date)`. Export from `schema/index.ts`; `db:generate` → migration 0054.
2. `src/db/bugReports.ts` (new, no tx needed): `createBugReport(input, actorUsername)` — validate note non-empty, category ∈ vocabulary (`scan_failed|date_code|wrong_data|missing_data|duplicate|label_print|blocked|slow|ui_text|login|other`), trail ≤ 200 KB serialized, photo ≤ 5 MB after base64 decode (413); insert with reporter from `actorUsername`. After successful insert, fire-and-forget `fetch(process.env.BUG_REPORT_WEBHOOK, …)` with `{reporter, app, route, category, note: note.slice(0,200)}` — env unset = skip, errors swallowed (a dead webhook never fails the report). List/detail/patch/delete helpers.
3. `src/routes/bugReports.ts` (new) + mount in `src/server.ts` (or routes index, follow neighbours): `POST /bug-reports` (any authenticated user; username from JWT per auth convention), `GET /admin/bug-reports` (light columns, newest-first), `GET /admin/bug-reports/:id` (full row + photo base64), `PATCH /admin/bug-reports/:id` (`{status?, uat_ref?, category?}`), `DELETE /admin/bug-reports/:id`.
4. Tests `src/db/bugReports.test.ts`: happy path stores token username over body-supplied one; empty note 400; unknown category 400; photo > 5 MB 413; trail cap; PATCH status/uat_ref round-trip; list omits trail/photo.
5. `.env.example`: `BUG_REPORT_WEBHOOK` (optional, one-line comment).

## PDA (`apps/pda`)

6. `utils/activityLog.ts` (new): ring buffer (cap 150 entries / ~40KB, drop oldest), mirrored to sessionStorage (`bug-trail`), entries `{t, k, m, r}`; `pushLog(k, m)` reads current route from a module-level setter (set by the afterEach wiring); `getSessionId()` uuid persisted in sessionStorage at app start. `shortcut:` comment: buffer lost on WebView process death; upgrade path = native log store. Vitest: cap drops oldest; sessionStorage round-trip.
7. `utils/bugReportCategories.ts` (new): `categoriesForRoute(path)` — prefix table → curated subset ending `other`; miss → `[scan_failed, wrong_data, blocked, slow, other]`. Fill the table from the spec examples (put-away, receiving, receiving-cn-scan, picking, goods-verify, measuring, label-printing, labeling, stock-search…). Vitest: prefix hit, dynamic `[id]` routes, fallback.
8. Choke-point instrumentation (each = one `pushLog` line): `services/apiClient.ts` request wrapper (method+path+status+ms; on error append short message), `composables/useHardwareScanner.ts` `deliver()` (source + raw value).
9. `layouts/default.vue`: `router.afterEach` route push + `window` `error`/`unhandledrejection` listeners (message + filename:lineno) + session-id touch; wire `pushLog` route context. Do not attach on `/login` and `/server` (button hidden there anyway).
10. `services/types.ts` + `WarehouseService` + `services/adapters/backendWarehouse.ts`: `reportBug(input)` → `POST /bug-reports` with captured `{app:"pda", route, category, note, context:{userAgent,sessionId,appVersion?}, trail, photo?, photoMime?}`. Photo: canvas resize ≤1280px JPEG q0.8 → base64.
11. `components/AppHeader.vue`: top-right 🐞 button (hidden on login/server pages), emits open. `components/BugReportModal.vue` (new, styled like `ReportIssueModal.vue`): category chips (single-select, from `categoriesForRoute`), note textarea (required), one photo input `accept="image/*" capture="environment"`, submit → `useWarehouse().reportBug` → success toast, error path keeps the modal open.
12. i18n: `bugReport.*` block (categories, labels, buttons, toast) in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`.

## Admin (`apps/admin`)

13. `utils/activityLog.ts` + `utils/bugReportCategories.ts`: small copies of PDA versions (apps share no code except the i18n layer; keep both files <80 lines, tests only on the PDA copy). Route table for admin pages (receiving, receiving-cn, picking-orders, shipping, stock-search, shelf-boxes, task-assignment, flow-config…).
14. Choke points: `composables/useApi.ts` response path + `app.vue` afterEach/error listeners (same entries as PDA minus scan).
15. `app.vue`: fixed bottom-left 🐞 button (hidden when `isLogin`) + `components/BugReportModal.vue` (same shape, plain file input, no `capture`).
16. `pages/bug-reports.vue` (new): light list newest-first; `SearchableSelect` filters for status + category; row expand → note / context / trail rendered as preformatted lines / photo; inline `PATCH` for status + `uat_ref`; delete button. Plain fetch via `useApi()` — **not** CrudTable (queue, not CRUD).
17. Nav: `utils/entities.ts` navSections entry + `TOC.md`; unread badge (open-count) on the link — copy the `OutdatedWarningsBadge.vue` pattern (`components/BugReportsBadge.vue`).
18. i18n: reuse `bugReport.*` keys + admin page keys in the three locale files.

## Docs / tracker

19. `docs/backend/api-design.md`: add the five routes to the catalog (no new SSE events — page refetches on mount).
20. `docs/app-docs`: feature-registry + code-map entries; brief mention in the relevant flow docs if a `ai-scope.md` boundary changes; `docs/uat/functions.json`: append `PDA-bug-report` + `ADM-bug-reports` rows (never renumber).

## Verify

21. `docker compose up -d`; `pnpm --filter @warehouse/backend test` + `build`; `pnpm --filter @warehouse/pda test` + `nuxt prepare` + `build`; admin `test`/`build`.
22. Manual: PDA put-away — scan a label, trip one failed request, press 🐞, report with category + photo → check the admin `#16` page shows the trail in order (route → scan → api error), reporter from token, status PATCH works, webhook log line appears when `BUG_REPORT_WEBHOOK` points at a local echo.
