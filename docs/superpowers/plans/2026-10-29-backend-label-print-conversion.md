# Backend label-print param conversion — implementation plan

Spec: `docs/superpowers/specs/2026-10-29-backend-label-print-conversion-design.md`

## Backend

1. `apps/backend/src/db/picking.ts` — `getPickingOrderDetail` packages query:
   add `scanned_date_code AS "scannedDateCode"`, `scanned_lot_code`,
   `scanned_coo`, `scanned_cow` to the SELECT; extend `PickingPackageDetail`
   with the four optional fields.
2. New `apps/backend/src/db/labelPrintParams.ts`:
   - Port `apps/pda/utils/labelPrintParams.ts` verbatim-ish as the default
     builder (identity/part/batch supersets, `packageBatch` scanned-first,
     `packageTrace`, `page`/`total`/`showTailBox`), typed against the backend
     `PickingOrderDetail`.
   - `LabelParamConverter` registry keyed by templateId (empty for now) +
     `buildLabelPrintParams(ctx)` dispatch with default fallback.
   - `printOrderLabel(db, { orderId, ruleId, scope })`: rule load (404/409),
     re-validate via `resolveLabelPrintRulesForOrder` (409
     `label_rule_no_longer_matches`), `getPickingOrderDetail(db, orderId, scope)`,
     build params (400 `printing_params_required` when empty), `dynamicPrint`
     from `src/print.ts`, return `{ jobs, labelCount }`.
   - `labelCountForMatch(db, order, match)` helper for the rules route.
3. `apps/backend/src/routes/picking.ts`:
   - `POST /picking-orders/:id/label-print` — `{ ruleId }` body, caller scope
     via `getUserScope` (mirror the detail route), returns `printOrderLabel`.
   - `GET /picking-orders/:id/label-print-rules` — augment each match with
     `labelCount` (load detail once, run the converter per match).
4. Tests: new `apps/backend/src/db/labelPrintParams.test.ts` — default builder
   parity for carton/item_box/item (port the PDA test cases), scanned-first
   batch anchoring, empty-order edge cases. Route-level test for
   `POST /picking-orders/:id/label-print` error paths (unknown rule, inactive
   rule, non-matching rule) — mock/stub the print service call or test only up
   to the 4xx paths.

## PDA

5. `apps/pda/services/types.ts` — `LabelPrintRuleMatch` += `labelCount: number`;
   add `PrintPickingLabelResult { jobs: PrintJob[]; labelCount: number }`.
6. `apps/pda/services/warehouse.ts` + `services/adapters/backendWarehouse.ts` —
   add `printPickingLabel(orderId, ruleId)` → `POST /picking-orders/:id/label-print`.
7. `apps/pda/components/picking/LabelPrintRulesPanel.vue` — remove paramsCache /
   `buildLabelPrintParams` / `dynamicPrint`; `labelCount(match)` →
   `match.labelCount`; `printMatch` → `warehouse.printPickingLabel` +
   `waitForPrintJob`.
8. Delete `apps/pda/utils/labelPrintParams.ts`,
   `apps/pda/tests/labelPrintParams.test.ts`; remove `dynamicPrint` from
   `apps/pda/utils/print.ts` (keep `getPrintJob`/`waitForPrintJob`).

## Docs

9. `docs/backend/api-design.md` — add the new route; note `labelCount` on the
   label-print-rules response.
10. `AGENTS.md` printing bullet — conversion now backend-side
    (`src/db/labelPrintParams.ts`, per-templateId registry).
11. `docs/app-docs/` — update the labeling/picking flow docs that mention
    client-side label param building (check `ai/feature-registry.md`,
    `ai/code-map.md` for `labelPrintParams.ts`).

## Verify

12. `pnpm --filter @warehouse/backend build` (tsc) +
    `pnpm --filter @warehouse/backend test` (needs Postgres).
13. `pnpm --filter @warehouse/pda test` + `pnpm --filter @warehouse/pda nuxt prepare`.
