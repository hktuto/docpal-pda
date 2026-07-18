# Stock Search — AI Scope and Remarks

## In scope

- Search parts by part-number substring, with optional supplier and shelf
  filters (all ANDed).
- Show each matching part's on-hand quantity (Σ `totalQty` of its lots).
- Show the inventory-lot breakdown per part: three-level location
  (warehouse → section → sub-inventory, plus shelf/box), batch fields
  (date code, lot code, COO/COW), and total / allocated / available
  quantities.
- Supplier dropdown is populated from the admin suppliers CRUD read
  (`GET /admin/suppliers`).

## Out of scope

- Editing inventory from the search page.
- Real-time live query (manual reload on mount/visibility; search re-fires
  per filter change with a stale-response guard).
- Advanced filters (zone, date range, allocation status).
- Export or print.

## Key files

- `pages/stock-search/index.vue` — search page (filters + part/lot
  results).
- `services/adapters/backendWarehouse.ts` — `searchStock` (one call) and
  `getSuppliers` (dropdown).
- `services/types.ts` — `StockSearchFilters`, `StockSearchPart`,
  `StockSearchLot`, `StockSearchResult`, `SupplierListRow`.
- `apps/backend/src/routes/stocksearch.ts` +
  `apps/backend/src/db/stocksearch.ts` — `GET /stock-search`
  (`supplierId?`, `partNo?`, `shelfCode?` → `{parts, lots}`).
- `pages/index.vue` — home menu card.

## Known limitations

- Supplier-part relationship is inferred from the lots' receiving history,
  not a formal catalog.
- Zero-quantity lots are included by design.
- No image or scan evidence shown here.

## Related specs/plans

- `docs/backend/api-design.md` §Stock search
- `docs/superpowers/specs/2026-07-04-stock-search-design.md`
- `docs/superpowers/plans/2026-07-04-stock-search.md`
