# Manual-only allocation (PR 1) — implementation plan

Date: 2026-11-03

Spec: `docs/superpowers/specs/2026-11-03-allocation-manual-only-design.md`

1. Remove every production `scheduleAllocateAll` call site:
   `routes/picking.ts` (+ drop `reallocateBestEffort` helper; reorder and
   resolve-issue now only log), `routes/putaway.ts` (5 sites + helper),
   `routes/putawayCn.ts`, `routes/adhocPutaway.ts` + `db/adhocPutaway.ts`
   re-export, `routes/shelfExchange.ts` + `db/shelfExchange.ts` re-export,
   `routes/receiving.ts` (scan trigger + confirm-arrival fallback),
   `routes/admin/flowEdits.ts` (status-override fallback),
   `db/adminedits.ts` (location-change trigger).
2. `routes/admin/testPickingOrder.ts`: replace the scheduled run with a
   synchronous `allocateForPickingOrder` (try/catch — creation never fails).
3. Remove `POST /admin/allocation/run` (`routes/admin/allocation.ts`); keep the
   runner, `/allocation/status` and snapshot routes (restore still uses it).
4. Admin UI: delete the "Allocate all" button/handler/banner in
   `pages/picking-orders/index.vue`, `flowApi.allocateAll` + `AllocateAllSummary`,
   and the `allocateAll`/`allocateAllConfirm` keys in the three `layers/i18n`
   locales; refresh `AllocationIndicator.vue` header comment.
5. Keep `allocateAll`, `scheduleAllocateAll`, `awaitAllocateAll` for
   `POST /dev/allocate` + tests; migrate the 6 `/admin/allocation/run` test calls
   in `routes/admin/allocation.test.ts` to direct `allocateAll(client.db)`; fix
   stale trigger comments in the affected tests.
6. Update live docs: `AGENTS.md`, `docs/backend/{allocation,api-design,README,
   concepts,event-catalog,allocation-logic.drawio}`, `docs/app-docs` (code-map,
   feature-registry, picking/receiving/put-away ai-scopes).
7. Verify: backend `tsc` build; manual UAT of confirm-arrival, both Re-allocate
   buttons and a put-away → Re-allocate round (automated suite run skipped per
   request).
8. PR 2 (later, only if ops doesn't miss it): delete `allocateAll` and migrate
   the ~40 direct test call sites.
