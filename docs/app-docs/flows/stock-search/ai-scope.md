# Stock Search — AI Scope and Remarks

## In scope

- List all suppliers as expandable cards.
- Search/filter by keyword, supplier, and item.
- Show parts associated with a supplier (derived from receiving and picking history).
- Show inventory-lot breakdown per part (location and quantity).
- Toggle to hide items with no inventory.

## Out of scope

- Editing inventory from the search page.
- Real-time live query (manual reload on mount/visibility).
- Advanced filters (zone, date range, allocation status).
- Export or print.

## Key files

- `pages/stock-search/index.vue` — search page.
- `db/stockSearch.ts` — query helpers.
- `pages/index.vue` — home menu card.

## Known limitations

- Supplier-part relationship is inferred from historical receiving/picking orders, not a formal catalog.
- No image or scan evidence shown here.

## Related specs/plans

- `docs/superpowers/specs/2026-07-04-stock-search-design.md`
- `docs/superpowers/plans/2026-07-04-stock-search.md`
