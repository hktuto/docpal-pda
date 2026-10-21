# Allocation outdated-stock (old date code) warning — design

Date: 2026-10-20
Status: implemented

## Problem

Allocations can point at stock whose lot/receiving date code (WWYY) is very old
(e.g. > 2 years). Pickers and receivers have no in-app signal that the stock
being allocated is aged. We want an advisory warning on the allocation row when
its source date code is older than a configurable threshold.

## Decisions

- **Reuse the existing flow-config key `outdatedStockYears`** (positive integer,
  default 2) — the same key that drives the admin stock-search summary outdated
  count. No new config key; admins tune it on the existing flow-config page
  (`GET/PUT /admin/flow-config`). Accessor: `outdatedStockYears()` in
  `apps/backend/src/config.ts`.
- **Age semantics identical to stock-search outdated**: valid WWYY
  (`^\d{4}$`, week 01–53), 2-digit-year window, outdated when
  `dateCodeRank(code) < outdatedThresholdRank(years)`; invalid/unparseable codes
  are never flagged. Helpers live in `apps/backend/src/db/dateCode.ts`.
- **Backend computes the flag** — single source of truth; old app builds ignore
  the extra JSON fields.
- **Scope of the date code per allocation**: lot-sourced allocations use
  `inventory_lots.date_code`; dock/receiving-sourced allocations use
  `receiving_invoice_items.date_code` (COALESCE, same as
  `GET /admin/part-allocations`).
- **Naming**: allocation rows get `outdated: boolean`; the picking order list
  row gets `hasOutdatedAllocations: boolean`. Deliberately distinct from the
  supplier scan-warning feature (`outdatedWarningCount` /
  `outdated_scan_warnings`), which is unrelated.
- **Warning only** — no blocking, no allocation change, no ledger impact.

## API changes

- `GET /picking-orders/:id` — each item `allocations[]` row gains `outdated`.
- `GET /picking-orders` — each row gains `hasOutdatedAllocations` (EXISTS over
  that order's `qty > 0` allocations whose coalesced source date code is valid
  and older than the threshold).
- `GET /receiving-orders/:id` — each invoice item `allocations[]` row gains
  `outdated` (lot join added to the allocations query).
- `GET /admin/part-allocations` — each breakdown row gains `outdated`.

## UI

- PDA picking order detail (unified + legacy item sections): ⚠️ on the
  date/lot row of an outdated allocation (mirrors the existing `shelfWarning`
  span). Client-side `mergeAllocations` OR-merges the flag.
- PDA receiving order detail picking tab: ⚠️ next to the date code.
- PDA picking order list: `warn-text` badge combined — unresolved scan warnings
  and/or outdated-stock notice.
- Admin picking/receiving detail allocation cells (flat rows + tooltip) and the
  `AllocationBreakdown` related-stock table flag outdated rows.
- i18n: new `stockAgeWarning` section in `layers/i18n` locales (en-US, zh-CN,
  zh-HK).

## Out of scope

- Admin picking order list column (detail surfaces only).
- Any hold/block on picking or receiving completion.
