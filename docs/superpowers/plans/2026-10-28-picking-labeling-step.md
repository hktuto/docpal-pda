# Picking labeling step （待贴标签） — implementation plan

- Date: 2026-10-28
- Spec: `docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md` (approved; open questions resolved: keep the immediate print prompt, no tile badge in v1, any operator may finish labeling)

## API contract (agreed shapes)

- `POST /picking-orders/:id/finish` → `{ id, status, labelingPending }` (new field).
- `POST /picking-orders/:id/labeling-finish` → 200 `{ id, status: "picking_finished", labelingPending: false }`; 404 `picking_order_not_found`; 409 `labeling_not_pending`.
- `GET /labeling-orders?search=&limit=&offset=` → `{ rows, total }`; row: `{ id, orderNo, pickingOrderType, customerCode, shipTo, deliveryDate, itemCount, totalQty, labelMatches: LabelPrintRuleMatch[], lastUpdateDate }`. Rows: `status='picking_finished' AND labeling_pending`, org-filtered like the picking list, ordered `last_update_date DESC`. `labelMatches` = live `resolveLabelPrintRulesForOrder` per row.
- `GET /picking-orders/:id` gains `labelingPending`, `labelingDoneAt`, `labelingDoneBy`, `labelingDoneByName`.
- SSE: new event `picking.labeling_finished`, topics `["/picking-orders", "/labeling-orders"]`.

## Steps

### 1. Backend (`apps/backend`)

1. `src/config.ts`: add `"labeling"` to `FLOW_STEPS` (default enabled via the existing `Object.fromEntries` default loop — verify no hardcoded exclusion); add `"labeling"` to the pdaViewConfig list keys + `PDA_LIST_CHIP_FIELDS` catalog (chips: reuse the picking order field catalog + `labelCount`).
2. `src/db/schema/picking.ts`: `picking_orders` += `labeling_pending` boolean NOT NULL DEFAULT false, `labeling_done_at` timestamptz NULL, `labeling_done_by` text NULL. Run `pnpm --filter @warehouse/backend db:generate`.
3. `src/db/picking.ts`:
   - Extract the measuring-off verify-task spawn block out of `finishPickingOrder` into `advanceAfterPickingFinish(tx, orderId)`; extend its cross-order gate with `AND po2.labeling_pending = false`.
   - `finishPickingOrder`: after the status stamp, if `isStepEnabled("labeling")` and `resolveLabelPrintRulesForOrder` (import from `./labelPrint.js`) matches → set `labeling_pending = true`, log transition `labeling_pending` (metadata: rule ids), skip the spawn; else call the helper. Return `{ id, status, labelingPending }`.
   - New `finishLabeling(db, { pickingOrderId, actorId })`: guards (404 / 409 `labeling_not_pending` unless `picking_finished` + pending), clear flag, stamp done at/by, log transition, call `advanceAfterPickingFinish`, emit `picking.labeling_finished`.
   - New `listLabelingOrders(db, opts)` — query per the contract above (reuse the `listPickingOrders` aggregates + `pickingOrderOrgFilter`; live rule matches per row).
   - `getPickingOrderDetail`: add the four labeling fields (+ join users for done-by name).
4. `src/db/measuring.ts` `listMeasuringBoxes`: add `AND po2.labeling_pending = false` to the NOT EXISTS gate.
5. `src/routes/admin/flowEdits.ts` picking status override: clear `labeling_pending` on any override (keep done at/by).
6. `src/routes/picking.ts`: `POST /picking-orders/:id/labeling-finish`, `GET /labeling-orders` (scope via `getUserScope` like the picking list).
7. Tests (`src/db/picking.test.ts` / new `labeling.test.ts`): per spec §Tests.

### 2. PDA (`apps/pda`)

1. `services/types.ts`: `FlowStep` += `"labeling"`; finish response type += `labelingPending`; `PickingOrderDetail` += labeling fields; new `LabelingOrderRow`; `viewConfig.lists` key `labeling`.
2. `services/warehouse.ts` + `adapters/backendWarehouse.ts`: `finishPickingOrder` return type, `getLabelingOrders`, `finishLabeling`.
3. `composables/useFlowSteps.ts`: default `labeling: true`.
4. Refactor `components/picking/LabelPrintPrompt.vue`: extract the match list + print logic into `components/picking/LabelPrintRulesPanel.vue` (props: `order`, `matches`); the modal keeps header/footer (skip / print-all) and embeds the panel.
5. `pages/labeling/index.vue`: list page (search, 50-row load-more, `useVisibleReload(load, ["/labeling-orders", "/picking-orders"])`), chip with label count from `labelMatches`.
6. `pages/labeling/[id].vue`: order header, `LabelPrintRulesPanel`, zero-live-matches info line, "Finish labeling" confirm → `finishLabeling` → toast → `/labeling`. 409 `labeling_not_pending` treated as already-done (toast + back to list).
7. Finish wiring (`pages/picking/unified/[id].vue`, `pages/picking/[id].vue`): read `labelingPending` from the finish response; when true, after the print prompt closes navigate to `/labeling/[id]` instead of `/verify`.
8. `pages/index.vue`: Labeling tile between Picking and Measuring.
9. i18n (`layers/i18n/i18n/locales/*.ts`): `home.menu.labeling.title` ("Labeling"/"待贴标签"/"待貼標籤") + `labeling.*` keys.
10. Tests (vitest): finish routing on `labelingPending`, labeling list/detail behavior.

### 3. Admin (`apps/admin`)

1. Flow-config page: verify the steps list picks up `labeling` automatically (it iterates the fetched config); add the label/i18n if hardcoded.
2. `pages/pda-view-config.vue`: add the `labeling` list section (title/meta/chip) following the existing six.
3. Picking order detail: read-only labeling state line (pending / done at+by).

### 4. Verify

- `pnpm --filter @warehouse/backend build` (tsc) + `pnpm --filter @warehouse/backend test` (needs Postgres; 2 pre-existing admin-docpal-url failures are known-unrelated).
- `pnpm --filter @warehouse/pda test` + `pnpm --filter @warehouse/pda nuxt prepare`.

### 5. Docs + commit

`docs/backend/api-design.md`, `docs/backend/event-catalog.md`, `docs/backend/schema-tables.md`, `AGENTS.md`, `docs/app-docs/` (new `flows/labeling/`, picking/verify/measuring flow notes, `ai/feature-registry.md`, `ai/code-map.md`). Commit as one change; leave the untracked `scripts/move-inventory-subinventory-orgs.mjs` and `task-list-2026-09-01-to-2026-10-26.xlsx` alone.
