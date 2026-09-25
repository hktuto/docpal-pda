# Stock Search: Server Paging + Drawing No — Plan

Date: 2026-09-25
Spec: `docs/superpowers/specs/2026-09-25-stock-search-paging-drawing-no-design.md`

1. Backend db (`apps/backend/src/db/stocksearch.ts`)
   - `StockSearchLotRow` += `drawingNo`; SELECT += `il.drawing_no`.
   - `StockSearchFilters` += `drawingNo` + normalized-substring WHERE clause.
   - Factor shared FROM/WHERE fragment; add `StockSearchPaging` /
     `StockSearchPage`; overload `searchStock` (legacy vs paged); `LOT_SORTS`
     whitelist + default-order tiebreakers; page query + COUNT in
     `Promise.all`.
2. Backend route (`apps/backend/src/routes/stocksearch.ts`): parse
   `drawingNo`; `page` present → paged call with clamped page/pageSize and
   validated `dir`.
3. Tests (`apps/backend/src/db/stocksearch.test.ts`): `drawingNo: null` in
   the six expected rows; drawingNo filter test (case/whitespace
   normalization, no-match); paging test (pages 1/3/4, totalQty desc sort
   with tie-break, unknown sort fallback, paged row carries `drawingNo`).
4. Admin (`apps/admin/utils/flowApi.ts`): `drawingNo` on `StockSearchLot` /
   `StockSearchParams`; `StockSearchPageParams` / `StockSearchPage`;
   `stockSearchQuery` serializes the new params; `stockSearchPage` in
   `useFlowApi()`.
5. Admin page (`apps/admin/pages/stock-search.vue`): drawingNo filter input;
   drawingNo column; ungrouped mode on `server: { total }` with
   `reloadPage()` + page/sort watchers; group-by/export stay on the full
   fetch; results wrapper renders on `searched`.
6. i18n (`layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`): `drawingNo` /
   `drawingNoPlaceholder` keys.
7. Web types (`apps/web/services/types.ts`): `drawingNo` on `StockSearchLot`.
8. Docs: `docs/backend/api-design.md` §Stock search,
   `docs/app-docs/flows/stock-search/ai-scope.md`,
   `docs/app-docs/admin-user-menu/index.md` (庫存查詢).
9. Verify: `pnpm --filter @warehouse/backend build`, backend tests (needs
   Postgres), `pnpm --filter @warehouse/admin build`. Do not commit.
