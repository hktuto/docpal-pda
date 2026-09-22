# Date-code display template — design (2026-09-17)

Configurable policy for how a lot's date code, lot code, COO and COW render together in the
admin console. A lot's supplier label like `3626cn` is stored as separate columns
(`date_code = 3626`, `coo = cn` — split at scan time by the supplier QR template), and today
each admin screen joins them ad hoc. This spec makes the join a per-warehouse config.

## Config

New top-level key in the `warehouse_config` row `"flow"` (same storage, validation, hot-apply
and admin endpoint as the other flow-config keys — spec 2026-08-12-admin-flow-config-design.md):

```json
{ "dateCodeDisplayTemplate": "[date_code][coo]" }
```

- `dateCodeDisplayTemplate` — non-empty string. Default `"[date_code][coo]"`.
- Placeholders: `[date_code]`, `[lot_code]`, `[coo]`, `[cow]`.
- A placeholder whose field is null/empty renders as `""` → `[date_code][coo]` with no COO
  renders `3626` (no dangling separator).
- Text outside brackets is literal; unknown `[tokens]` are left as-is (the template is
  forgiving — validation only requires a non-empty string).
- `mergeFlowConfigJson` rejects non-string / blank values with
  `[config] flow config.dateCodeDisplayTemplate must be a non-empty string` (→ PUT
  `/admin/flow-config` returns 400).

Phase 1 applies the template **admin-only**:

- `apps/admin/pages/receiving/[id].vue` — item table date-code column.
- `apps/admin/pages/picking-orders/[id].vue` — allocation source cells (`dc:`) and the
  packages cell (`dc …`).
- `apps/admin/components/allocations/AllocationDetail.vue` — hover-tooltip date-code rows
  (lot and receiving variants).

Implementation: `apps/admin/utils/dateCodeDisplay.ts` (`formatDateCodeDisplay`) +
`apps/admin/composables/useDateCodeDisplay.ts` (one shared fetch of
`GET /admin/flow-config`; falls back to the default until loaded). Display only — grouping /
merge keys keep using the raw fields.

Admin editing page: `apps/admin/pages/display-config.vue` (Settings nav), saving via
`PUT /admin/flow-config` with the template merged over the **stored** JSON (the PUT replaces
the row with the raw body). Live preview on the page shows a full sample lot
(3626 / L01 / cn / tw) and a no-COO sample so the empty-placeholder behavior is visible.

## Out of scope (later phases)

- Web PDA display sites (`ReceivingItemsTab`, `PickingItemsSection.formatLotFields`, etc.).
- Excel downloads: picking-list xlsx `Date Code` column, and a new date-code column on the
  receiving shipper xlsx (which today has none).
- No change to storage, scanning, or the supplier QR split.

## Amendment 2026-09-22: COO/COW short-code placeholders

`[coo_short]` / `[cow_short]` render the single char from the new
`country_list.short_code` column (admin-editable on the Country List page,
seeded/backfilled as the first letter of the ISO code; unmapped code falls
back to the raw code). See `2026-09-22-coo-cow-short-code-design.md`.
