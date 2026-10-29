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
  (`verified` + `verify_verified`) and the rescanned credit — verify is a
  full re-measure, not a read-only check. Reopen is a verify-step-only verb
  (409 `verify_task_not_pending` otherwise).
- Per-box page (`/verify/:boxId`): the shared
  `components/MeasureBox.vue` also used by measuring — packages are verified
  by hardware/wedge scan (`matchMeasuring` via `runScanMatcher`, applied
  with `verifyPackage` by id; a closed box requires the box's pending verify
  task), measurements edited via `updateShippingBox` (kg) on the open box,
  then close.
  The verify pass is a mandatory re-scan tracked by the mode-agnostic
  `picking_packages.rescanned_qty` counter (2026-10-03 aggregate design —
  the close (or, with measuring off, the finish) that spawns the verify task
  resets the credit to zero, so the
  verify pass re-scans from scratch; `verified`/`verify_verified` flags are
  still set per mode on first credit). Scanning works on **closed** boxes
  too (checking contents against the sealed box is the normal verify pass).
  Matching is **aggregate** (spec
  `docs/superpowers/specs/2026-10-03-picking-scan-truth-and-aggregate-verify-design.md`):
  totals per part + batch fields, not physical labels — a scan matches when
  the part matches (batch fields constrain only when both sides carry a
  value) and the scanned qty fits the matching packages' total remaining
  (`utils/measuringAggregateMatch.ts`); the apply step credits it FIFO
  across the packages, partial credits allowed (`POST /packages/:id/verify`
  with `{qty}`, capped at the package qty; fully credited → 409
  `package_already_verified`). Since 2026-10-14 the batch fields anchor to
  the pick-time scanned values carried on each package
  (`scannedDateCode`/`scannedLotCode`/`scannedCoo`/`scannedCow` from
  `picking_packages.scanned_*`, falling back to the stored source snapshot
  for legacy rows) — the re-scan is judged against the physical label that
  was picked, not upstream lot data (spec
  `docs/superpowers/specs/2026-10-14-picking-scan-batch-validation-design.md`).
  `label_barcode` stays on the schema for
  traceability/display but no longer drives matching.
- **Label mode (2026-10-30, spec
  `docs/superpowers/specs/2026-10-30-label-source-and-label-verify-design.md`)**:
  per package, verify splits by whether the package's order matches ≥ 1
  active **internal** label rule (evaluated live per box load; the detail
  packages carry `labelMode`). Unlabeled packages (rule-less or external-only
  orders) are presented as per-item totals rows (grouped client-side via
  `apps/pda/utils/verifyDisplayGroups.ts`) — matching is the unchanged
  aggregate matcher. Label-mode packages stack label verification on top of
  the qty re-scan: scanning a printed label (`POST /verify-tasks/:id/scan-label`
  — raw-string equality against ANY string param value of the recorded
  `label_prints` payload rows, template-agnostic; carton rows for the box
  match first and stamp `shipping_boxes.carton_label_verified`, item/item_box
  rows mark `picking_packages.label_verified` and return the label's anchored
  expectations; idempotent, 404 `label_print_not_found` on a miss) is required
  before its item scans, which pass their batch fields to
  `POST /packages/:id/verify` for a server-side hard compare
  (part_no/wcl_item_no + COO + date code → 409 `label_item_mismatch` with the
  differing fields). A carton label also opens the box from the verify list
  (`GET /verify-tasks/lookup-by-label?raw=`, tried before box-id matching).
  `completeVerifyTask` adds 409 `labels_not_all_verified`;
  `reopenShippingBox` resets the label/carton flags with the existing resets;
  label-mode packages with NO print record (labeling finished without
  printing) fall back to plain aggregate matching. Measuring-mode boxes (no
  verify task yet) intercept carton-label scans only; item labels are checked
  during the verify pass.
- Complete the verify task once **every package is fully re-scanned**
  (`rescanned_qty >= qty`) — 409 `packages_not_all_rescanned` otherwise; the
  page's complete button mirrors this guard. The box must be closed when the
  measuring step is on (409 `shipping_box_not_closed`); with measuring off
  the task sits on the still-open box and completing closes it (no
  weights/size — nothing was measured). The box then appears in the admin
  shipping feed.
- Measuring-off chain: when `steps.measuring.enabled=false` and verify is
  on, `finishPickingOrder` spawns the pending verify task directly on the
  order's still-open boxes (a cross-order box waits until every order in it
  is finished — the same gate as the measuring list) and resets the rescanned
  credit; `verifyPackage` runs the verify pass on the open box; the PDA
  finish navigates straight to `/verify`. When the order entered the
  **labeling stage** at finish (spec
  `docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md`), this
  spawn is deferred until the labeling finish — the shared
  `advanceAfterPickingFinish` helper runs it from `finishLabeling`, with the
  cross-order gate additionally requiring every order in the box to have
  cleared labeling (`labeling_pending = false`; see
  [Labeling](../labeling/ai-scope.md)).
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
  measurements, close; box title, status badge, picking-order info and the
  View picking order / Enter measurements actions registered into the app
  header via `composables/usePageHeader.ts`); the
  `mode: 'measuring' | 'verify'` prop selects the per-mode badge flag and
  allows scanning closed boxes. Completion gating is the rescanned counter
  (`rescannedQty >= qty` per package; partial credits show "rescanned/qty").
- `composables/useFlowSteps.ts` — flow-step config state, loaded from
  `layouts/default.vue`'s session watch.
- `services/adapters/backendWarehouse.ts` — `getVerifyTasks` /
  `getVerifyTask` / `completeVerifyTask` / `reopenShippingBox` /
  `getFlowConfig`.
- `apps/backend/src/routes/verify.ts` + `apps/backend/src/db/verify.ts` —
  `GET /verify-tasks?status=`, `GET /verify-tasks/:id`,
  `POST /verify-tasks/:id/complete` (guards: 404 `verify_task_not_found`,
  409 `verify_task_not_pending`, 409 `shipping_box_not_closed` (measuring
  step on only), 409
  `packages_not_all_rescanned` until every package is re-scanned, 409
  `labels_not_all_verified` until every printed label of the box's
  label-mode orders is scanned; with
  measuring off the completion closes the still-open box). Label mode:
  `GET /verify-tasks/lookup-by-label?raw=` (registered BEFORE `/:id`),
  `POST /verify-tasks/:id/scan-label`; `labeledOrderIds` /
  `cartonPrintExists` helpers; the detail carries per-package
  `labelMode`/`labelVerified` and box `cartonLabelRequired`/`cartonLabelVerified`.
- `apps/pda/utils/verifyDisplayGroups.ts` — per-item totals grouping +
  label-first scan dispatch helper (`dispatchVerifyScan`), unit-tested in
  `apps/pda/tests/verifyDisplayGroups.test.ts`.
- `apps/backend/src/db/labelVerify.test.ts` — label-mode backend coverage.
- `apps/backend/src/db/picking.ts` — `closeShippingBox` spawns the box's
  pending verify task when the verify step is enabled (`ON CONFLICT DO
  NOTHING`, and resets the packages' rescanned credit for the new pass), and
  `finishPickingOrder` does the same on the still-open box when the measuring
  step is disabled;
  `reopenShippingBox` (box-scoped: requires THIS box's pending
  verify task, resets both verified flags + the credit); the `verifyPackage`
  closed-box branch setting `verify_verified` (409
  `no_pending_measure_or_verify_task`) — also taken by an open box when
  measuring is disabled and the task is pending.
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
- `docs/superpowers/specs/2026-10-02-picking-scan-label-record-design.md`
- `docs/superpowers/specs/2026-10-03-picking-scan-truth-and-aggregate-verify-design.md`
- `docs/superpowers/specs/2026-10-14-picking-scan-batch-validation-design.md`
- `docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md`
- `docs/superpowers/specs/2026-10-30-label-source-and-label-verify-design.md`
- `docs/superpowers/specs/2026-07-28-verify-step-and-flow-step-config-design.md`
- `docs/superpowers/specs/2026-07-28-measuring-verify-refinements-design.md`
- `docs/backend/api-design.md` §Verify
- [Measuring AI scope](../measuring/ai-scope.md)
