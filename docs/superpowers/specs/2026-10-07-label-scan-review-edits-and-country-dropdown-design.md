# Label-scan review edits + COO/COW country dropdown — design

Date: 2026-10-07
Status: implemented

## Problem

1. **Review-form edits were lost on Apply.** In `LabelScanReviewModal.vue`
   the Apply button used the match computed from the *original* OCR parse —
   the `apply()` closure captured the parsed `dateCode`/`lotCode`/`coo`/`cow`
   at match time (`useScanMatchers.ts` `matchPutAway`/`matchPicking`). Edits
   made in the form only took effect if the operator tapped **Find Match**
   before **Apply**. Additionally the backend `recordPutAwayScan` stamped
   batch attributes with `COALESCE(existing, input)`, so once a value was set
   on the receiving invoice item, later corrections were silently ignored.
2. **COO/COW were free-text inputs.** Values are country codes (OCR parses
   `[A-Z]{2,3}`), so a dropdown over the `country_list` master is a better
   fit than free text + candidate chips.

## Decisions

- **Apply re-matches first.** `applyRecord` re-runs `runScanMatcher` with the
  edited fields; only a fresh `single` result is applied. Any other result
  (none/error/already-verified) replaces the displayed match and aborts the
  write, so the operator sees why the edit does not apply.
- **Client value wins on the backend.** `recordPutAwayScan` now writes
  `COALESCE(input, existing)` — a supplied value overwrites the stamped one
  (corrections work), a null/empty field keeps the current value (the PDA
  sends `rawCode` → null for cleared fields, so nothing is ever blanked
  accidentally).
- **Dropdown from `country_list`.** The PDA reads the admin CRUD list
  (`GET /admin/countries`) via `WarehouseService.getCountries()` — the same
  reuse trick as `getSuppliers`/`getShelves`. The select binds to
  `country_list.code` (ISO alpha-2, matching what OCR parses and what the
  batch fields store). The parsed value and OCR candidates that are not in
  the master are appended as raw extra options so a scan is never silently
  blanked. Candidate chips remain for the other fields.
- **i18n stays client-side.** The table keeps a single canonical English
  `name` (admin-editable). Display translation reuses the existing
  `countryLabels` locale map (keyed by English name, already translated in
  en-US/zh-CN/zh-HK, fallback to the raw name) — no schema change, no new
  keys; the seed `COUNTRIES` list matches the map keys exactly.

## Follow-up decisions (2026-10-07, second pass)

- **COO/COW default to empty.** Both review modals initialize `coo`/`cow`
  blank even when OCR parsed values — the operator picks explicitly; the
  parsed values stay one tap away as raw extra options in the dropdown.
- **Part no is a select too.** The possible scan targets always come from the
  parent document, so free text + chips was replaced by a dropdown: the
  receiving order's visible items for put-away, the box's packages for
  measuring, the picking order's items for picking (`partNos` prop on
  `PickingScanReviewModal`). OCR-parsed values/candidates outside the list
  remain as raw extra options. To let a corrected part actually match, the
  put-away review context now carries ALL visible order lines in
  `putAwayItems` (matching still filters to the selected part and splits FIFO
  across that part's lines — same behavior for an unchanged part).
- **Shared `CountrySelect.vue`** backs the COO/COW dropdown in both
  `LabelScanReviewModal` (put-away / measuring) and `PickingScanReviewModal`
  (picking scan page).

## Changes

- `apps/pda/components/LabelScanReviewModal.vue` — re-match on Apply; part-no
  select from the context's possible targets; COO/COW `CountrySelect`
  dropdowns defaulting to empty.
- `apps/pda/components/picking/PickingScanReviewModal.vue` — same part-no
  select (`partNos` prop = the picking order's parts) and COO/COW dropdowns.
- `apps/pda/components/CountrySelect.vue` — shared country dropdown.
- `apps/pda/composables/useCountryList.ts` — shared-cache composable
  (`ensureCountries`, `countryLabel`).
- `apps/pda/services/warehouse.ts` + `services/types.ts` +
  `services/adapters/backendWarehouse.ts` — `CountryRow` + `getCountries()`.
- `apps/pda/pages/put-away/[id].vue` — the review context's `putAwayItems`
  now carries all visible order lines (was: the scanned card's group only).
- `apps/backend/src/db/putaway.ts` — COALESCE flipped so provided batch
  values overwrite.
- Tests: `apps/backend/src/db/putaway.test.ts` (overwrite / null-keeps),
  `apps/pda/services/adapters/backendWarehouse.test.ts` (`getCountries`).
