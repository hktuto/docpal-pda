# Admin date format setting — design spec

Date: 2026-09-16
Status: implemented
Scope: admin console (`apps/admin`) + backend profile endpoints. The web PDA app is unchanged.

## Problem

Dates render all over the admin console via ad-hoc `new Date(...).toLocaleString()` /
`toLocaleDateString()` calls and the shared `formatCell` helper, producing browser-locale,
inconsistent output. Warehouse staff want one consistent, configurable format for all table
date columns.

## Decision

Two **per-user** settings, stored server-side on `user_profiles` so they follow the user
across devices, edited on the existing personal Settings page (`/settings`):

| Setting | Column | Default |
|---|---|---|
| Date format | `user_profiles.date_format` | `dd/MMM/yyyy` → `16/Sep/2026` |
| Date and time format | `user_profiles.date_time_format` | `dd/MMM/yyyy HH:mm` → `16/Sep/2026 15:09` |

NULL/absent column = the default (server fills it in on read).

### Pattern syntax

Unicode-style tokens, date-fns semantics, implemented in a zero-dependency formatter
(`apps/admin/utils/dateFormat.ts`):

`yyyy yy MMM MM M dd d HH H hh mm m ss a`

- `MMM` is always the English 3-letter month (`Jan`–`Dec`); month names are not localized.
- `mm` = minutes, `MM` = month number (standard token semantics; the default
  `dd/MMM/yyyy HH:mm` renders the requested `16/Sep/2026 15:09`).
- Backend validation (`parseDateFormat` in `src/db/user-profile.ts`): pattern must be ≤ 64
  chars, letters must form known tokens → 400 `invalid_date_format`.

## Backend

- `user_profiles` gains `date_format` / `date_time_format` text columns (migration
  `drizzle/0010_chilly_speed_demon.sql`).
- `src/db/user-profile.ts`: `getUserDateFormats` (defaults filled), `upsertUserDateFormats`
  (upserts only the two format columns by username, pre-provisioning allowed — never touches
  `sub_inventory_scopes`).
- `GET /auth/me/profile` returns `dateFormat` / `dateTimeFormat` alongside
  `subInventoryScopes`.
- `PUT /auth/me/profile` merges: only fields present in the body are updated, so saving the
  scope never wipes formats and vice versa.
- Tests: `src/db/user-profile.test.ts` (defaults, round-trip, merge, validation).

## Admin frontend

- `apps/admin/utils/dateFormat.ts` — pure `formatWithPattern(date, pattern)` +
  `isDateOnlyString` / `toValidDate` helpers.
- `apps/admin/utils/datePreferences.ts` — module-level reactive store; `loadDatePreferences`
  (fetches `/auth/me/profile`), `applyDatePreferences`, and the sync entry points
  `formatDate(value)` (date-only ISO strings use the date pattern, everything else the
  date-time pattern) and `formatDateTime(value)`. Sync on purpose: `formatCell` runs inside
  table cell rendering and cannot await.
- `app.vue` loads the prefs once a token exists (route-watch + mounted, guarded so the
  login page never calls the authed endpoint).
- Every date render goes through the formatter:
  - `utils/format.ts` `formatCell` now formats date-only `YYYY-MM-DD` strings too
    (previously only `...T...` datetimes), covering all default CRUD cells.
  - Hand-written cells converted: receiving list/detail, picking-orders list/detail,
    shipping list/detail, issues/picking, picking/reorder, `AuditLogTable`,
    `receiving/PartDemandTables`.
  - Deliberately untouched: `.slice(0, 10)` usages feeding `<input type="date">` (must stay
    ISO), and `SupplierProfileEditor.vue` (formats a number, not a date).
- Settings page: two preset dropdowns (stored custom values stay selectable) with a live
  preview per pattern; saving applies the new prefs immediately so open tables re-render.

## Verification

- `pnpm --filter @warehouse/backend build` + `pnpm --filter @warehouse/backend test`.
- Manual: change formats on `/settings`, confirm tables re-render; `dd/MMM/yyyy` shows
  `16/Sep/2026`, `dd/MMM/yyyy HH:mm` shows `16/Sep/2026 15:09`.
