# Verify — AI Scope and Remarks

## In scope

- List the boxes with a pending verify task (box-scoped — one
  `verify_tasks` row per shipping box, `shipping_box_id` unique; spec
  `docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`).
  List rows carry server-computed counts: `packageCount` /
  `verifyVerifiedCount` plus the aggregated `orderNos[]` and the box's
  `destinationCountry` (a box may hold packages from several picking orders
  — cross-order packing).
- Box detail as **one consolidated read** (`GET /verify-tasks/:id`):
  `{task{id, status, shippingBoxId, createdDate}, box{...,
  suggestedNetWeightKg}, packages[]}` with part identity plus the
  `verified`/`verifyVerified` flags embedded on each package. The PDA page
  is keyed on the box (`/verify/:boxId`) and resolves the box's pending task
  from the list before loading the detail.
- Reopen a closed box (`POST /shipping-boxes/:id/reopen`) while its task is
  pending: box → `open`, its packages lose both verified flags
  (`verified` + `verify_verified`) — verify is a
  full re-measure, not a read-only check. Reopen is a verify-step-only verb
  (409 `verify_task_not_pending` otherwise).
- Per-box page (`/verify/:boxId`): the shared
  `components/MeasureBox.vue` also used by measuring — packages are verified
  by hardware/wedge scan (`matchMeasuring` via `runScanMatcher`, applied
  with `verifyPackage` by id; a closed box requires the box's pending verify
  task), measurements edited via `updateShippingBox` (kg) on the open box,
  then close.
  The verify pass is a mandatory re-scan against the
  `picking_packages.verify_verified` flag (migration 0004): the component's
  `mode: 'verify'` prop and the matcher's `flow` context field switch the
  gating flag, and scanning works on **closed** boxes too (checking contents
  against the sealed box is the normal verify pass — `verifyPackage` sets
  `verify_verified` alongside `verified` so a reopened box can re-close).
- Complete the verify task once the box is closed and **every package has
  been re-scanned** (`verify_verified`) — 409 `packages_not_all_rescanned`
  otherwise; the page's complete button mirrors this guard. The box then
  appears in the admin shipping feed.
- Flow-step config: `useFlowSteps` fetches `GET /config` once per login;
  `pages/index.vue` hides the tiles of disabled steps.

## Out of scope

- Carrier rate shopping.
- Label printing for shipping boxes.
- Integration with scales or dimensioners.
- Un-shipping a box — `shipped` is terminal for the POC (mark-shipped
  itself lives in the admin shipping feed via
  `POST /shipping-orders/:boxId/ship`, not in the PDA verify flow).
- Step-config editing — the flow config lives in the backend
  `warehouse_config` row `"flow"` (or the `FLOW_CONFIG` env override); there
  is no admin UI.

## Key files

- `pages/verify/index.vue` — box list (pending verify tasks).
- `pages/verify/[boxId].vue` — the box page: resolves the box's pending
  task, wraps `components/MeasureBox.vue` (`mode="verify"`), and adds the
  reopen + complete actions.
- `components/MeasureBox.vue` — box page body (package verify by scan,
  measurements, close); the `mode: 'measuring' | 'verify'` prop selects the
  gating flag (`verifyVerified` in verify mode) and allows scanning closed
  boxes.
- `composables/useFlowSteps.ts` — flow-step config state, loaded from
  `layouts/default.vue`'s session watch.
- `services/adapters/backendWarehouse.ts` — `getVerifyTasks` /
  `getVerifyTask` / `completeVerifyTask` / `reopenShippingBox` /
  `getFlowConfig`.
- `apps/backend/src/routes/verify.ts` + `apps/backend/src/db/verify.ts` —
  `GET /verify-tasks?status=`, `GET /verify-tasks/:id`,
  `POST /verify-tasks/:id/complete` (guards: 404 `verify_task_not_found`,
  409 `verify_task_not_pending`, 409 `shipping_box_not_closed`, 409
  `packages_not_all_rescanned` until every package is re-scanned).
- `apps/backend/src/db/picking.ts` — `closeShippingBox` spawns the box's
  pending verify task when the verify step is enabled (`ON CONFLICT DO
  NOTHING`); `reopenShippingBox` (box-scoped: requires THIS box's pending
  verify task, resets both verified flags); the `verifyPackage` closed-box
  branch setting `verify_verified` (409 `no_pending_measure_or_verify_task`).
- `apps/backend/src/config.ts` (flow config from the `warehouse_config` row
  `"flow"`, `isStepEnabled`) +
  `apps/backend/src/routes/config.ts` (`GET /config`).
- `apps/backend/src/db/shipping.ts` + `apps/backend/src/routes/shipping.ts` —
  the per-box shipping feed (`GET /shipping-orders*` — closed unshipped
  boxes, gated on the box's completed verify task when the verify step is
  on) plus mark-shipped (`POST /shipping-orders/:boxId/ship` → box
  `shipped_at`/`shipped_by`, excluded from the feed), consumed by
  `apps/admin/pages/shipping/*` via `utils/flowApi.ts`.

## Known limitations

- Config-driven: the verify step can be disabled in the flow config
  (`steps.verify.enabled=false`) —
  then no verify tasks are created and the home tile is hidden. Disabled
  steps' endpoints stay reachable; the toggle is UI-level except for the
  close → verify-task chain, the shipping-feed gating, and goods-verify
  generation gating.
- No SSE events for verify (same as measuring) — pages reload on visibility.
- Measurements are typed manually; no real weight or dimension capture.

## Related specs/plans

- `docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`
- `docs/superpowers/specs/2026-07-28-verify-step-and-flow-step-config-design.md`
- `docs/superpowers/specs/2026-07-28-measuring-verify-refinements-design.md`
- `docs/backend/api-design.md` §Verify
- [Measuring AI scope](../measuring/ai-scope.md)
