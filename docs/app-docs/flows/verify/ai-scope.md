# Verify — AI Scope and Remarks

## In scope

- List pending verify tasks for finished picking orders (server-computed box
  counts: `boxCount` / `closedBoxCount`).
- Task detail as **one consolidated read** (`GET /verify-tasks/:id`): the
  task, its picking order, and all shipping boxes with their packages (part
  identity plus the `verified`/`verifyVerified` flags embedded on each
  package, `suggestedNetWeightKg` per box). Scanning a box QR/id on this page
  (`useHardwareScanner`) opens that box directly — exact id match, else a
  unique substring match.
- Reopen a closed box (`POST /shipping-boxes/:id/reopen`) while the task is
  pending: box → `open`, its packages lose both verified flags
  (`verified` + `verify_verified`) — verify is a
  full re-measure, not a read-only check. Reopen is a verify-step-only verb
  (409 `verify_task_not_pending` otherwise).
- Per-box page (`/verify/:taskId/box/:boxId`): the shared
  `components/MeasureBox.vue` also used by measuring — packages are verified
  by hardware/wedge scan (`matchMeasuring` via `runScanMatcher`, applied
  with `verifyPackage` by id; the backend accepts a pending measuring OR
  verify task), measurements edited via `updateShippingBox` (kg), then close.
  The verify pass is a mandatory re-scan against the
  `picking_packages.verify_verified` flag (migration 0004): the component's
  `mode: 'verify'` prop and the matcher's `flow` context field switch the
  gating flag, and scanning works on **closed** boxes too (checking contents
  against the sealed box is the normal verify pass — `verifyPackage` sets
  `verify_verified` alongside `verified` so a reopened box can re-close).
- Complete the verify task once every box is closed, nothing is unboxed, and
  **every package has been re-scanned** (`verify_verified`) — 409
  `packages_not_all_rescanned` otherwise; the detail page's complete button
  mirrors this guard. The order then appears in the admin shipping feed.
- Flow-step config: `useFlowSteps` fetches `GET /config` once per login;
  `pages/index.vue` hides the tiles of disabled steps.

## Out of scope

- Carrier rate shopping.
- Label printing for shipping boxes.
- Integration with scales or dimensioners.
- Un-shipping an order — `shipped` is terminal for the POC (mark-shipped
  itself lives in the admin shipping feed via
  `POST /shipping-orders/:pickingOrderId/ship`, not in the PDA verify flow).
- Step-config editing — `FLOW_STEPS_DISABLED` is a backend env var; there is
  no admin UI.

## Key files

- `pages/verify/index.vue` — task list (pending only).
- `pages/verify/[id].vue` — task detail (boxes overview, reopen action,
  complete action).
- `pages/verify/[taskId]/box/[boxId].vue` — thin wrapper over
  `components/MeasureBox.vue` (shared with measuring).
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
  `POST /verify-tasks/:id/complete` (409 `packages_not_all_rescanned` until
  every package is re-scanned).
- `apps/backend/src/db/picking.ts` — `reopenShippingBox` (resets both
  verified flags); the finish chain
  (`maybeAutoFinishPickingOrder` creates the measuring task, or the verify
  task directly when measuring is disabled); the relaxed `verifyPackage`
  task guard (409 `no_pending_measure_or_verify_task`) with the verify-branch
  closed-box scan setting `verify_verified`.
- `apps/backend/src/db/measuring.ts` — completing a measuring task spawns
  the verify task when the verify step is enabled.
- `apps/backend/src/config.ts` (`FLOW_STEPS_DISABLED`, `isStepEnabled`) +
  `apps/backend/src/routes/config.ts` (`GET /config`).
- `apps/backend/src/db/shipping.ts` + `apps/backend/src/routes/shipping.ts` —
  the config-aware shipping feed (`GET /shipping-orders*`) plus mark-shipped
  (`POST /shipping-orders/:pickingOrderId/ship` → order `shipped`, excluded
  from the feed), consumed by `apps/admin/pages/shipping/*` via
  `utils/flowApi.ts`.

## Known limitations

- Config-driven: the verify step can be disabled (`FLOW_STEPS_DISABLED`) —
  then no verify tasks are created and the home tile is hidden. Disabled
  steps' endpoints stay reachable; the toggle is UI-level except for the
  measuring/verify chain and goods-verify generation gating.
- No SSE events for verify (same as measuring) — pages reload on visibility.
- Measurements are typed manually; no real weight or dimension capture.

## Related specs/plans

- `docs/superpowers/specs/2026-07-28-verify-step-and-flow-step-config-design.md`
- `docs/superpowers/specs/2026-07-28-measuring-verify-refinements-design.md`
- `docs/superpowers/specs/2026-07-29-picking-allocation-status-design.md`
- `docs/backend/api-design.md` §Verify
- [Measuring AI scope](../measuring/ai-scope.md)
