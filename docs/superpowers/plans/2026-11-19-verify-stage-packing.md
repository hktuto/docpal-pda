# Verify-Stage Packing — Implementation Plan

Date: 2026-11-19
Spec: `docs/superpowers/specs/2026-11-19-verify-stage-packing-design.md`

## 1. Config

- [ ] Add `packingStage` (`"picking" | "verify"`, default `"picking"`) to the
  flow-config parser/validator in `apps/backend/src/config.ts` + flow-config
  docs (`docs/backend/flow-config.md`).
- [ ] Reject `packingStage: "verify"` combined with the verify step disabled
  (boot validation + admin flow-config PUT 400).

## 2. Schema migration

- [ ] Migration: `verify_tasks.shipping_box_id` → nullable; add
  `verify_tasks.picking_order_id` (nullable FK); replace
  `idx_verify_tasks_shipping_box` with two partial unique indexes
  (box-keyed / order-keyed).
- [ ] Update `apps/backend/src/db/schema` types +
  `docs/backend/schema-tables.md`.

## 3. Backend domain (`apps/backend/src/db/`)

- [ ] `picking.ts` `finishPickingOrder`: skip the packed requirement and the
  box-task spawn when `packingStage=verify`; instead spawn the order-keyed
  verify task (after the labeling gate, measuring off).
- [ ] `verify.ts`: support order-keyed tasks — list/detail aggregate over the
  order's packages and session boxes; scan credit (`POST /packages/:id/verify`)
  accepts `boxId` and stamps `picking_packages.shipping_box_id` on first
  credit; new `createSessionBox` / `closeSessionBox` / `completeSession`
  (guards: partial package 409, all-rescanned, label gates, per-box closes,
  `packaged_at` stamp).
- [ ] Keep every box-keyed path untouched when the task is box-keyed
  (default warehouses unaffected).

## 4. Backend routes + adapter

- [ ] Routes in `src/routes/verify.ts`: `POST /verify-tasks/:id/boxes`,
  `POST /verify-tasks/:id/close-box`, `POST /verify-tasks/:id/complete`
  (order-keyed); extend `GET /verify-tasks/:id` detail and
  `POST /packages/:id/verify` body.
- [ ] Update `apps/pda/services/adapters/backendWarehouse.ts` +
  `services/warehouse.ts` for the new endpoints/fields; expose
  `packingStage` via `GET /config` consumption (`useFlowSteps` or a small
  composable).

## 5. PDA UI

- [ ] Picking unified page: hide boxes section + box actions when
  `packingStage=verify`; Finish enabled on all-picked.
- [ ] Verify packing session page (new page under `pages/verify/`): item
  totals, current box card, New box / Close box / Complete, label-first scan
  dispatch, reuse `verifyDisplayGroups` + `useScanMatchers`.
- [ ] Verify list rendering for order-keyed tasks (order no + progress).
- [ ] `pnpm nuxt prepare`, i18n locale strings for the new UI.

## 6. Tests

- [ ] Backend `verify.test.ts` / `picking.test.ts`: order-keyed spawn,
  scan-into-box credit stamping, partial-package New box 409, close-box,
  complete gates (not-all-rescanned, labels), `packaged_at`.
- [ ] Default-mode regression: existing box-keyed tests unchanged and green.
- [ ] Config validation tests (invalid combos).
- [ ] `pnpm --filter @warehouse/backend test`,
  `pnpm --filter @warehouse/pda test`, backend `tsc` build.

## 7. Docs + UAT

- [ ] `docs/app-docs/flows/verify/` + `picking/` overview/steps/ai-scope for
  the verify-packing mode; `ai/feature-registry.md`, `ai/code-map.md`.
- [ ] `functions.json` entry for the new verify-packing function; UAT feature
  row (`docs/uat/features/CR-<next>.json`); regenerate xlsx
  (`node scripts/gen-uat-xlsx.mjs`).
