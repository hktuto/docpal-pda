# PDA list-row display templates — implementation plan (2026-09-21)

Spec: `docs/superpowers/specs/2026-09-21-pda-list-row-templates-design.md`.

## Backend

1. `apps/backend/src/config.ts` — add `pdaListTemplates` to `FlowConfig`:
   `PDA_LIST_KEYS = ["receiving","picking","put-away","goods-verify","verify","measuring"]`,
   per-list `{title, meta}` defaults (today's rendering), validation in
   `mergeFlowConfigJson` (top-level object; unknown list key → throw; per-list
   value object with optional non-empty-string `title`/`meta`; partial lists
   merge over defaults), accessor `pdaListTemplates()`, header comment.
2. `apps/backend/src/routes/config.ts` — `GET /config` gains
   `listTemplates: pdaListTemplates()` (fully resolved, defaults filled).
3. Tests: `src/config.test.ts` (defaults, partial merge, validation errors);
   `src/routes/admin-flow-config.test.ts` (round-trip via PUT + `GET /config`
   exposes the resolved value).

## Web (PDA)

4. `apps/web/utils/listRowTemplate.ts` — list keys, default templates, per-list
   placeholder catalog (snake token → camelCase field + optional `date` /
   `datetime` kind), `formatListRowTemplate(fields, template)` (empty→"",
   arrays comma-join, unknown tokens literal) and `formatListRow(listKey,
   slot, fields)` implementing the title fallback chain (custom → default
   template → primary id) and meta-hide (returns "" → caller hides the line).
5. `apps/web/composables/useListTemplates.ts` — module-level resolved-templates
   ref (defaults until loaded) + `applyListTemplates(config)`; wired into
   `useFlowSteps.loadFlowSteps()` (the existing `GET /config` fetch point).
   `useListTemplates()` returns `formatRow(listKey, slot, row)`.
6. `apps/web/services/types.ts` — `FlowConfig.listTemplates?`.
7. Six list pages (`pages/receiving|picking|put-away|goods-verify|verify|measuring/index.vue`)
   — replace hardcoded title/meta with `formatRow`; meta div gets `v-if` for
   the empty-meta collapse. Put-away's task and candidate lists share the
   `put-away` key.
8. Web tests: `tests/listRowTemplate.test.ts` (vitest) — placeholders, arrays,
   date/datetime kinds, fallback chain, meta-empty.

## Admin

9. `apps/admin/utils/listRowTemplate.ts` — preview copy of the formatter +
   catalogs + per-list sample rows (full + missing-fields).
10. `apps/admin/utils/flowApi.ts` — `FlowConfigState.config.pdaListTemplates`.
11. `apps/admin/pages/display-config.vue` — third card "PDA list rows": list
    picker, title + meta inputs, placeholder chips per selected list, live
    preview (full + missing-fields sample). Save merges `pdaListTemplates`
    over the stored row.

## i18n

12. `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — section keys for the
    new card (labels, hints, list names, placeholder labels).

## Docs

13. `docs/backend/api-design.md` (`GET /config` row + flow-config paragraph),
    `docs/backend/schema-tables.md` (warehouse_config keys), `AGENTS.md`
    (flow-config bullet), `docs/app-docs/ai/{feature-registry,code-map}.md`,
    flow ai-scope bullets.

## Verify

14. `pnpm --filter @warehouse/backend build` + `test`;
    `pnpm --filter @warehouse/web test` (vitest);
    `pnpm --filter @warehouse/web build` + `pnpm --filter @warehouse/admin build`.
