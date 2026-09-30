# Stock Search — AI Scope and Remarks

## In scope

- Search parts by part-number substring, with the same filter set as the
  admin console (all ANDed): supplier (single), brand / location /
  shelf (multi-select, any-of), drawing-no substring, and a WWYY
  date-code range. Location values are exact `orgId:subInventoryCode`
  pairs.
- Filter options (brands, shelves, locations) come from
  `GET /stock-search/options`; locations are limited server-side to the
  caller's `user_profiles` sub-inventory scope.
- A compact summary strip (items / on-hand / available) from
  `GET /stock-search/summary` with the same filters.
- Show each matching part's on-hand quantity (Σ `totalQty` of its loaded
  lots — the summary strip carries the authoritative filtered totals).
- Server-paged results (`GET /stock-search?page=&pageSize=` → `{rows,
  total}`, page size 50): the first page loads with the search, a "load
  more" button appends the next page, with a "Showing X of Y" count. The
  loaded lot rows are grouped into part cards client-side.
- Show the inventory-lot breakdown per part: three-level location
  (warehouse → section → sub-inventory, plus shelf/box), batch fields
  (date code, lot code, COO/COW, drawing no), and total / allocated /
  available quantities.
- Supplier dropdown is populated from the admin suppliers CRUD read
  (`GET /admin/suppliers`). Selecting a supplier also restricts the hardware
  decoder to that supplier profile's `barcode_types` whitelist (when set);
  cleared/restored when the filter changes or the page is left
  (`useSupplierSymbologyScope`, xcheng/Movfast only).

## Out of scope

- Editing inventory from the search page.
- Real-time live query (manual reload on mount/visibility; search re-fires
  per filter change with a stale-response guard).
- Server-paged `{rows,total}` sort controls, group-by, and export/print
  (admin-console features; the PDA uses the default row order with
  load-more paging).

## Key files

- `pages/stock-search/index.vue` — search page (filter panel + summary
  strip + part/lot results).
- `components/FilterChipGroup.vue` — shared tap-to-toggle chip list used
  for the brand/location/shelf multi-selects (search box appears when
  there are more than 8 options).
- `utils/dateCode.ts` — calendar date → WWYY date-code conversion.
- `services/adapters/backendWarehouse.ts` — `searchStock` (legacy full
  read), `searchStockPage` (paged `{rows,total}` for the load-more list),
  `getStockSearchOptions`, `getStockSearchSummary`, and `getSuppliers`
  (supplier dropdown).
- `services/types.ts` — `StockSearchFilters`, `StockSearchPart`,
  `StockSearchLot`, `StockSearchResult`, `StockSearchOptions`,
  `StockSearchSummary`, `SupplierListRow`.
- `apps/backend/src/routes/stocksearch.ts` +
  `apps/backend/src/db/stocksearch.ts` — `GET /stock-search`
  (`supplierCode?`, `partNo?`, `drawingNo?`, multi-value `shelfCode?` /
  `zone?` / `brand?` / `location?` (exact `orgId:code` pairs) /
  `dateCodeFrom?` / `dateCodeTo?` → `{parts, lots}`). Opt-in server paging
  (`?page=&pageSize=&sort=&dir=` → `{rows, total}`) serves both the admin
  lots table and the PDA load-more list.
- `pages/index.vue` — home menu card.

## Known limitations

- Supplier-part relationship is inferred from the lots' receiving history,
  not a formal catalog.
- Zero-quantity lots are included by design.
- No image or scan evidence shown here.

## Related specs/plans

- `docs/backend/api-design.md` §Stock search
- `docs/superpowers/specs/2026-07-04-stock-search-design.md`
- `docs/superpowers/specs/2026-09-30-web-stock-search-admin-parity-design.md`
- `docs/superpowers/plans/2026-07-04-stock-search.md`
