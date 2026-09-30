# Web (PDA) stock search — admin parity, mobile-first

Date: 2026-09-30

## Background

The admin console (`apps/admin/pages/stock-search.vue`) and the PDA (`apps/web/pages/stock-search/index.vue`) both read `GET /stock-search`, but the PDA only exposed `supplierCode` / `partNo` / `shelfCode` (single values), while the admin exposes the full filter set (`brand[]`, `location[]` as `orgId:code` pairs, `shelfCode[]`, `zone[]`, `drawingNo`, WWYY `dateCodeFrom/To`). Given identical params the backend runs identical SQL, so the differing "results" users saw were entirely the differing filter surface — plus the PDA's `apiClient` could not even send repeated (multi-value) params.

## Design

No backend change. `/stock-search`, `/stock-search/options` (already limited to the caller's `user_profiles` sub-inventory scope), and `/stock-search/summary` already support everything needed.

### Web client

- `apiClient.buildUrl` appends each element of an array-valued param separately (backend expects repeated params, any-of `IN`).
- `StockSearchFilters` gains `drawingNo`, multi-value `shelfCode`/`zone`/`brand`/`location` (`"orgId:code"` strings), and WWYY `dateCodeFrom`/`dateCodeTo`; `supplierCode` stays single (it drives the scanner symbology whitelist). `StockSearchLot` gains `description`/`brand`/`zone`/`officeCode`/`shelfDisplayName` (already returned by the backend). New `StockSearchOptions` / `StockSearchSummary` DTOs mirror the admin's (`apps/admin/utils/flowApi.ts`).
- New service methods: `getStockSearchOptions()` → `GET /stock-search/options`, `getStockSearchSummary(filters)` → `GET /stock-search/summary`.
- New `apps/web/utils/dateCode.ts` (`dateToDateCode`, ISO-week → WWYY) copied from the admin util.

### PDA page (`apps/web/pages/stock-search/index.vue`)

- Same collapsed-by-default expandable filter panel and instant partNo search (with the stale-response guard).
- Expanded panel, vertical stack, full-width fields:
  - Supplier — unchanged single `<select>` (still feeds `useSupplierSymbologyScope`).
  - Brand / Location / Shelf — multi-select via the new `FilterChipGroup` component (toggle chips, optional search box when > 8 options, scrollable list), options from `/stock-search/options`. Location values are exact `"orgId:code"` pairs, labels `officeCode / subInventoryCode`, grouped by org.
  - Drawing no — text input.
  - Date-code range — two native `<input type="date">` pickers converted to WWYY.
- Results paginate through the paged `GET /stock-search?page=&pageSize=` variant
  (`{rows, total}` lot rows): the first page loads with the search and a
  mobile "load more" button appends the next page, with "Showing X of Y"
  feedback. The loaded rows are still grouped into part cards client-side
  (default row order sorts by part, so a part's lots arrive mostly
  contiguously); per-part on-hand shows the loaded lots' Σ totalQty while
  the summary strip carries the authoritative filtered totals. A compact
  one-line summary strip (items / on-hand / available) comes from
  `/stock-search/summary` with the same filters — the admin's card grid,
  outdated counts, group-by, and Excel export stay desktop-only.

### i18n

The admin's stock-search labels move from `admin.pages.stockSearch` to the shared top-level `stockSearch` domain in `layers/i18n` so both apps reuse one key set; the three admin consumers (`pages/stock-search.vue`, `components/PartAvailabilityModal.vue`, `components/receiving/PartSearchModal.vue`) are re-pointed. No duplicated keys.

## Out of scope

Group-by, Excel export, and outdated-stock summary cards (desktop admin
features), and any backend change. Lot-row sorting controls stay admin-only;
the PDA uses the backend default order (part no → date code → shelf → box),
which paginates stably and keeps a part's lots (mostly) contiguous.
