# COO/COW short-code placeholders — design

Date: 2026-09-22
Status: implemented

## Problem

The date-code display template (`dateCodeDisplayTemplate`, spec
`2026-09-17-date-code-display-template-design.md`) renders a lot's COO/COW as
the full ISO country code (`CN`, `JP`). Warehouses want a compact single
character instead (`CN` → `C`, `JP` → `J`) so printed/displayed date-code
strings stay short. The mapping must be warehouse-configurable, not hardcoded.

## Design

### `country_list.short_code` column

- New nullable text column `short_code` on `country_list` — the single
  character a country renders as in the short placeholders.
- Migration backfills existing rows with the first letter of the ISO code
  (`upper(substr(code, 1, 1))`: CN→C, JP→J, TW→T); the seed sets the same
  value for new databases.
- Editable per country in the admin console Country List page
  (`/admin/countries` CRUD gains an optional `shortCode` field).

### New template placeholders

`dateCodeDisplayTemplate` gains two placeholders:

- `[coo_short]` — COO via the `country_list.short_code` lookup.
- `[cow_short]` — COW via the same lookup.

The existing `[coo]` / `[cow]` (full code) placeholders are unchanged.

Rendering rules:

- Field empty → renders empty (existing rule, no dangling separator).
- Field set but the code has no `country_list` row or a NULL/empty
  `short_code` → falls back to the raw code, so an unmapped country never
  renders blank.

### Where the lookup happens

The template is rendered client-side in the admin console
(`apps/admin/utils/dateCodeDisplay.ts`). `useDateCodeDisplay` now also fetches
`/admin/countries` once per session and builds a `code → shortCode` map passed
to `formatDateCodeDisplay(fields, template, shortCodes)`. The display-config
preview uses a static sample map.

The receiving order name template and PDA list-row templates are order-level
(COO/COW live on receiving items/lots, not the order) and are deliberately out
of scope — this feature targets the lot-level date-code template only, where a
lot has exactly one COO and one COW.

## Files

- `apps/backend/src/db/schema/master.ts` — `countryList.shortCode`.
- `apps/backend/drizzle/0014_*.sql` — `ALTER TABLE` + backfill `UPDATE`.
- `apps/backend/src/db/seed.ts` — seed `shortCode` from the code's first letter.
- `apps/backend/src/routes/admin/index.ts` — countries CRUD accepts `shortCode`.
- `apps/admin/utils/entities.ts` — Country List field.
- `apps/admin/utils/dateCodeDisplay.ts` — `coo_short` / `cow_short` placeholders.
- `apps/admin/composables/useDateCodeDisplay.ts` — country short-code map.
- `apps/admin/pages/display-config.vue` — placeholder chips + preview map.
- `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — labels.
