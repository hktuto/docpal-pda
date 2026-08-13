# Plan: put-away shelf suggestion (shelf org affinity + same-part box)

Spec: `docs/superpowers/specs/2026-08-12-put-away-shelf-org-suggestion-design.md`

1. Backend schema: `shelves.org_id` nullable integer in
   `apps/backend/src/db/schema/master.ts`; `pnpm --filter @warehouse/backend db:generate`.
2. Backend suggestion: extend `getPutAwayTaskDetail` in
   `apps/backend/src/db/putawaytasks.ts` — per-item `suggestedBoxId` +
   `suggestionReason`, ranking same-part-box → same-part-stock → org-shelf.
3. Backend admin: shelves `createCrudRouter` create/update accept `orgId`
   (`apps/backend/src/routes/admin/index.ts`).
4. Backend tests: extend `apps/backend/src/db/putawaytasks.test.ts` (box
   match, org-shelf fallback, off gate returns all nulls).
5. Web: `services/types.ts` item fields; `PutAwayLotsPanel.vue` box hint;
   i18n keys in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`.
6. Admin: shelves `EntityConfig` orgId number field + `admin.fields.orgId`
   i18n key.
7. Verify: backend test suite, web vitest, `nuxt prepare` (web + admin),
   backend `tsc` build.
8. Docs: AGENTS.md put-away bullet + `docs/app-docs/flows/put-away/ai-scope.md`.
