# Stock Search: Server Paging + Drawing No — Design

Date: 2026-09-25

## Problem

1. `GET /stock-search` always returns **all** matching lots in one response.
   On real data (thousands of lots) the admin stock-search lots table pays the
   full transfer + client-side paging cost on every search.
2. `inventory_lots.drawing_no` exists in the schema but is not exposed
   anywhere in stock search — admins cannot see or filter by it.

## Design decisions

### Opt-in paging (backward compatible)

The paged mode is **opt-in**: `GET /stock-search` only switches to the paged
response `{ rows, total }` when the `page` query param is present (1-based;
`pageSize` default 50, clamped 1..200). Without `page` the response is the
legacy full `{ parts, lots }` exactly as before — the PDA web app
(`apps/web`) consumes that shape and keeps working untouched.

The paged response deliberately has **no `parts` array**: it is a
whole-result aggregate the admin doesn't use, and computing it would require
reading every matching row (defeating the point of paging).

Implementation follows the repo's existing conventions (`logParams` in
`src/routes/admin/issues.ts`, `listReceivingOrderLogs` paged variant in
`src/db/receiving.ts`): the page query and a `COUNT(*)` over the same
FROM/WHERE run in `Promise.all`; the shared
`FROM … JOIN … LEFT JOIN … WHERE TRUE ${stockFilterClauses(filters)}` is
factored into one fragment so legacy, count, and page queries cannot drift.

### Sorting whitelist

Sort keys are the admin lots-table column keys, mapped to SQL expressions
(each rendered `<expr> ASC|DESC NULLS LAST`, `dir` default asc):

`partNo` → `p.wcl_item_no` (the column displays `wclItemNo ?? partNo`;
`wcl_item_no` is NOT NULL), `description` → `p.description`, `brand` →
`p.brand`, `drawingNo` → `il.drawing_no`, `dateCode` → `il.date_code`,
`lotCode` → `il.lot_code`, `shelfCode` → `il.shelf_code`, `zone` → `s.zone`,
`boxId` → `il.box_id`, `orgSubInventory` → `il.org_id, il.sub_inventory_code`,
`totalQty`/`allocatedQty`/`availableQty` → the matching `il` columns.

Unknown/missing `sort` falls back to the existing default order
(`il.part_no, il.date_code NULLS LAST, il.shelf_code, il.box_id`); when a
sort IS active the default order is appended as tiebreakers so pagination is
stable.

### drawing_no

`drawingNo` is added to the lot row (`il.drawing_no`) and as a filter with
the same normalized-substring semantics as `partNo` (query normalized with
`normalizePartNo`; column side uppercased + whitespace-stripped in SQL via
`strpos(regexp_replace(upper(il.drawing_no), '\s', '', 'g'), …) > 0`).

### Admin UI split by mode

- **Ungrouped lots table** (`groupBy === "none"`): server-paged via
  `useAdminTable({ server: { total } })` (manualSorting + manualPagination,
  same idiom as `AuditLogTable`). Page/page-size/sort changes refetch the
  current page; a new search resets to page 1.
- **Group-by mode**: unchanged — per-group client-side tables over the legacy
  full fetch (`defaultPageSize: 1000`, no pager).
- **Excel export**: still exports ALL matching lots; in server mode it does a
  legacy full fetch at export time.
- The sorting ref is shared column state between the main table and the group
  tables (`syncKey`), so the refetch watchers are guarded to no-op in
  group-by mode.

## Scope

- Backend: `src/db/stocksearch.ts`, `src/routes/stocksearch.ts`, tests in
  `src/db/stocksearch.test.ts`.
- Admin: `utils/flowApi.ts`, `pages/stock-search.vue`, i18n keys in
  `layers/i18n`.
- Web: type-only addition (`drawingNo` on `StockSearchLot`); no behavior
  change.
