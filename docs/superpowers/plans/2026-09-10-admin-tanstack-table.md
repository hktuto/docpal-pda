# Admin tables: TanStack Table adoption — implementation plan

Date: 2026-09-10
Spec: `docs/superpowers/specs/2026-09-10-admin-tanstack-table-design.md`
Branch: `feat/admin-tanstack-table`

## Steps

1. `pnpm --filter @warehouse/admin add @tanstack/vue-table@9.2.4 @tanstack/table-core@9.2.4` (done — v9, with agent skills wired into root `AGENTS.md`).
2. i18n: add `columns`, `resetColumns` under `admin.common` in
   `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`.
3. `apps/admin/composables/useAdminTable.ts` — v9 `useTable` wrapper (read
   the bundled skills first — see AGENTS.md "Skill Loading"):
   client/server modes, `admin-table:<tableId>` localStorage persistence of
   `{ sorting, sizing, order, visibility }`, `orderedLeafColumns(table)`
   helper for the column menu.
4. `apps/admin/components/DataTable.vue` — sortable/resizable
   headers, `#cell-<key>` scoped slots, visibility + ▲/▼ reorder dropdown,
   empty row, optional select column + row click. Scoped styles for the new
   affordances.
5. Refactor `apps/admin/components/CrudTable.vue` onto `useAdminTable` +
   `DataTable` (column defs from `EntityConfig` as today; client search /
   clientFilters stay pre-table; server mode keeps query-param reload; keep
   search bar, bulk bar, `Pager` rewired to table state, `CrudForm`,
   `row-actions`/`bulk-actions` slots).
6. Convert `apps/admin/pages/picking-orders/index.vue` (derived accessors for
   `pickedRatio`/`allocation`, cell slots for dates/progress, row click →
   detail). Keep the pre-existing uncommitted `admin.common.*` →
   `admin.fields.*` i18n tweak lines intact.
7. Convert `apps/admin/pages/receiving/index.vue` (same caveat) and
   `apps/admin/pages/shipping/index.vue`.
8. Docs: update `docs/app-docs/ai/code-map.md` / `feature-registry.md` where
   they mention admin tables; note `DataTable` in root `AGENTS.md` admin
   bullet if needed.
9. Verify: `pnpm --filter @warehouse/admin exec vue-tsc --noEmit`,
   `pnpm --filter @warehouse/admin build`, then manual browser pass
   (`pnpm dev:backend` + `pnpm dev:admin`): sort cycle, server sort/paging
   params, resize, reorder, visibility, persistence across reload, row
   clicks, bulk select, empty state, zh-HK/en-US labels.

Do NOT delete `useColumnSort`/`usePaging` (still used by unconverted pages).
Do NOT commit the unrelated dirty file `apps/web/composables/useServerHealth.ts`
or the standalone i18n tweaks as their own change.
