# Admin tables: TanStack Table adoption (resize / reorder / visibility) — design

Date: 2026-09-10
Status: approved

## Problem

Every admin table is a hand-rolled native `<table class="data">` — the shared
`CrudTable.vue` (6 CRUD pages) plus 15 bespoke tables in pages. Sorting and
paging exist (`useColumnSort`, `usePaging`, `Pager`), but there is no column
resizing, no reordering, and no show/hide, and each new table-wide feature
would have to be wired into every page by hand.

## Decisions

- **Headless library, not a component suite.** Adopt `@tanstack/vue-table`
  (**v9**, 9.2.4 — current stable; v8 was initially installed by mistake) in
  `apps/admin` only. v9 is a breaking rewrite vs v8: `useTable()` (not
  `useVueTable`), explicit feature registration via `tableFeatures()`, row
  models declared explicitly. Authoritative API guidance ships with the
  package as agent skills — `apps/admin/node_modules/@tanstack/vue-table/skills/`
  and `apps/admin/node_modules/@tanstack/table-core/skills/` (wired into root
  `AGENTS.md`). It ships battle-tested column sizing / ordering /
  visibility / sorting / pagination state logic with zero styling, so the
  existing plain-CSS design (`assets/main.css` `table.data`, brand tokens)
  and all markup stay. No Element Plus / Vuetify — a full suite would fight
  the design tokens and force rewriting every form for no gain.

- **One shared wrapper, not per-page wiring.** Two new pieces:
  - `composables/useAdminTable.ts` — wraps `useVueTable`. Column defs
    (`{ key, label, sortable?, accessor?, minSize?, maxSize?, defaultHidden? }`),
    client mode (`getSortedRowModel` + `getPaginationRowModel`, replacing
    `useColumnSort`/`usePaging` inside consumers) and server mode
    (`manualSorting`/`manualPagination` + `rowCount`, bridging to the
    existing `page/pageSize/sort/dir` query params). Sort cycle stays
    none → asc → desc → none.
  - `components/DataTable.vue` — renders header/body from the table instance:
    sort arrows, resize handle (`columnResizeMode: "onChange"`), a "Columns"
    dropdown (visibility toggles + per-column ▲/▼ reorder + reset), scoped
    `#cell-<key>` slots for custom cell content, empty-state row. Select
    checkbox column and row-click navigation supported as props. Reorder
    lives in the dropdown, not header drag-and-drop — header dragging
    conflicts with the resize handles on the same `th`.

- **Persistence per table.** One localStorage key `admin-table:<tableId>`
  holding `{ sorting, sizing, order, visibility }` (same pattern as
  `useColumnSort`'s `storageKey`). `tableId` is the entity path for
  `CrudTable` and a page-specific slug for list pages. The old `admin-sort:*`
  keys are abandoned (saved sort resets once).

- **Scope of this branch.** `CrudTable` refactor (covers all 6 CRUD pages)
  plus the 3 main list pages (`picking-orders/index.vue`,
  `receiving/index.vue`, `shipping/index.vue`). Detail-page sub-tables and
  other bespoke tables keep `useColumnSort`/`usePaging` (those composables
  are NOT deleted) and adopt `DataTable` in later branches.

- **Inputs/forms untouched.** This is a table-only change; `CrudForm` and
  native-element styling stay as-is.

## Notes

- Column reorder is drag-and-drop inside the "Columns" dropdown
  (`vue-draggable-plus` / SortableJS, grip handle per row) plus a
  move-to-top button, built on TanStack's `columnOrder` state (the library
  manages the state, not the UI); header drag-and-drop was rejected because
  it conflicts with resize handles on the same `th`. Select/actions
  pseudo-columns are excluded from ordering, resizing, and hiding.
- Sorting is triggered by clicking the header **title** only, so the resize
  handle at the header edge never competes with the sort click.
- Resizing switches the table to `table-layout: fixed` (cells ellipsize), so
  columns can shrink below their longest content — impossible under auto
  layout with `white-space: nowrap`. On the first resize/fit, all columns are
  seeded from their rendered widths so the layout doesn't jump.
  Double-clicking a resize handle (or the ⇥ button in the Columns dropdown)
  auto-fits that column to its longest visible content.
- Server-mode tables keep reloading via query params; TanStack owns the
  sort/page state that produces them.
