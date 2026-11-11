# Packaging + Shipping steps — implementation plan

Spec: `docs/superpowers/specs/2026-11-10-packaging-shipping-steps-design.md` · 2026-11-10

Ordered so each phase lands green (typecheck + tests). CN-only enablement is config (Phase 1), never a code branch.

## Phase 1 — Backend config + schema

1. `apps/backend/src/config.ts`: `FLOW_STEPS += "packaging", "shipping"` (after `verify`);
   `defaultFlowConfig()` → `steps["packaging"] = { enabled: false }` (shipping default-on);
   `pdaViewConfig.lists` catalog += `packaging` (default `{title:"[order_no]", meta:["[ship_to]","[customer_code]"], chip:"none"}`,
   field allow-list `order_no|ship_to|customer_code|po_no|box_count|package_count`).
2. `apps/backend/src/db/schema/picking.ts`: `packagedAt`, `packagedBy` (FK users), `packedWeight real`,
   `packedBoxCount integer`, `packedPalletCount integer` on `picking_orders` (all nullable).
   `pnpm --filter @warehouse/backend db:generate` → migration 0063.
3. No `seed.ts` change (both seed configs keep the default-off `packaging` step; CN enablement is
   operator-side via admin flow-config).
4. `config.test.ts`: new defaults + parse round-trip for both step keys.

## Phase 2 — Backend domain + routes

5. New `apps/backend/src/db/packaging.ts`: `listPackagingOrders` (queue per spec §3.3 — copy the
   measuring-queue SQL shape from `taskAssignments.ts` "measuring" + status IN ('picking_finished','measuring_finished'),
   `assigneeFilter` + `pickingOrderOrgFilter`), `getPackagingOrderDetail`, `confirmPackaging`
   (tx: readiness re-check 404/409, validate weight/palletCount, recompute box count, UPDATE,
   `transaction_logs`, `emitEvent picking_order.packaged` topics `/packaging-orders`,`/picking-orders`,`/shipping-orders`).
6. New `apps/backend/src/routes/packaging.ts` (3 endpoints, `actorFrom(c)`); register import +
   `app.route("/", packagingRoute)` in `src/index.ts`; add `/packaging-orders` to the SSE topic list
   where other queues are registered (mirror how `/labeling-orders` is wired).
7. `apps/backend/src/db/shipping.ts`: packaging clause in `readyToShipWhere()` (spec §3.4);
   `packaged` on `ShippingOrderRow`; per-order packaged fields on `getShippingOrderDetail` order rows.
8. Reopen guard in `apps/backend/src/db/picking.ts` `reopenShippingBox:3098`: when
   `isStepEnabled("packaging")` and any order with packages in the box has `packaged_at` →
   409 `order_already_packaged` (before any writes).
9. `apps/backend/src/db/taskAssignments.ts` + `routes/admin/taskAssignments.ts`: `TaskAssignmentFlow +=
   "packaging"`, `FLOW_TABLES.packaging = { table: picking_orders, entityType: "picking_order", step: "packaging" }`
   (labeling's `picking_tasks` upsert path), list case mirroring the queue.
10. Tests: `packaging.test.ts` (new), `shipping.test.ts` (gate cases incl. shared box + cancelled-order
    escape), reopen-guard case, `user-scope`/task-assignments packaging row.
    Verify with `pnpm --filter @warehouse/backend build && pnpm --filter @warehouse/backend test`.

## Phase 3 — PDA

11. `apps/pda/services/types.ts` `FlowStep` union + `composables/useFlowSteps.ts` defaults: `packaging`, `shipping`.
12. `apps/pda/utils/viewConfig.ts` packaging list entry (mirror step 1's catalog).
13. `services/warehouse.ts` + `services/adapters/backendWarehouse.ts`: `getPackagingOrders(status)`,
    `getPackagingOrder(id)`, `confirmPackaging(id, { weight, palletCount })`.
14. `pages/packaging/index.vue` (AppListPage, `:topics="['/packaging-orders','/picking-orders']"`,
    view-config rows, pending/completed toggle) + `pages/packaging/[orderId].vue`
    (DetailRow summary, weight input, 箱/卡板 toggle, confirm dialog; completed = read-back view).
15. `pages/index.vue`: home tile `v-if="flowSteps.packaging"` → `/packaging`.
16. i18n `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`: `home.menu.packaging.*` + `packaging.*`
    (打包 / Packaging / Packaging).
17. vitest: adapter payload/URL tests + view-config row rendering; `pnpm --filter @warehouse/pda test`,
    `pnpm --filter @warehouse/pda nuxt prepare`.

## Phase 4 — Admin

18. `apps/admin/utils/flowApi.ts`: packaging methods + `TaskAssignmentFlow` union + packaged fields on
    shipping types.
19. `apps/admin/pages/flow-config.vue` `STEPS` += both keys; `pages/task-assignments.vue` `FLOWS` += packaging.
20. Nav: `utils/entities.ts` `navSections` packaging link + i18n titles; `app.vue`
    `NAV_STEP_GATES: { "/packaging": "packaging", "/shipping": "shipping" }`.
21. `apps/admin/utils/viewConfig.ts` + `utils/listRowTemplate.ts` packaging entries.
22. `pages/packaging/index.vue` (useAdminTable + DataTable + Pager + ChangeNotice, per-row Pack) +
    `pages/packaging/[orderId].vue` (weight / auto box count / pallet form + confirm + history) —
    clone the `pages/shipping/` structure.
23. `pages/shipping/index.vue`: `packaged` column + filter; `pages/shipping/[id].vue`: packaged block +
    copy-summary `<pre>` with copy button (`navigator.clipboard.writeText`, select-fallback).

## Phase 5 — Verify + docs + UAT

24. Manual flow check on CN config (`FLOW_CONFIG` env override with `receiving-cn`-style JSON or admin
    flow-config page on the demo DB): picking → measuring → verify → packaging (PDA + admin, both modes)
    → ship gate blocks/releases on a shared box. Chrome-101 API sanity on the PDA pages (no new Web APIs).
25. Docs: `docs/backend/api-design.md`, `event-catalog.md`, `schema-tables.md`, `flow-config.md`,
    `apps/admin/TOC.md`, `docs/app-docs/` (new flow dir + registry + code-map), `docs/dev-guide-zh/flows/packaging.md`,
    AGENTS.md schema-conventions line (packaging assignee → `picking_tasks` side row).
26. `docs/uat/functions.json` += packaging function entries (PDA + ADM), one-line mention of shipping review;
    `node scripts/gen-uat-xlsx.mjs`; commit spec+plan+code together, record delivery in the tracker.

## Definition of done

- HK/DBs with the step off behave byte-identically today (gate clauses short-circuit on `!isStepEnabled("packaging")`).
- CN: packaged order shows weight + auto box count or pallet count everywhere it matters (PDA detail, admin
  packaging page, admin shipping review), ship feed respects the gate, one confirm = one audit row + one SSE event.
