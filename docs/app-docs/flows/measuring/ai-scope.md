# Measuring — AI Scope and Remarks

## In scope

- List measuring tasks for finished picking orders (server-computed box
  counts: `boxCount` / `closedBoxCount`).
- Task detail as **one consolidated read** (`GET /measuring-tasks/:id`):
  the task, its picking order, and all shipping boxes with their packages
  (part identity embedded on each package). Scanning a box QR/id on this
  page (`useHardwareScanner`) opens that box directly — exact id match,
  else a unique substring match.
- Per-box page (`/measuring/:taskId/box/:boxId`): packages shown as a table
  that listens to hardware/wedge QR scans — each scan is parsed with the
  supplier templates (`parseRawValue`), matched client-side against the
  box's unverified packages (`matchMeasuring` via `runScanMatcher`), and
  applied immediately with `verifyPackage` by id. The camera/OCR flow
  (`useLabelScanReview` + per-row Scan buttons) remains as fallback.
- Record box measurements (box size, net/gross weights in **kilograms** —
  decimals, 3 dp; destination country) via the shared picking verbs
  (`updateShippingBox` with `netWeightKg`/`grossWeightKg`), then close the
  box. The measurements modal is a single **Confirm box** action (update +
  close); the net weight is pre-filled from the box's `suggestedNetWeightKg`
  — Σ `(formula.weight / formula.qty) × pkg.qty` grams from
  `net_weight_formula` ÷ 1000, computed per box in the task detail (parts
  without a formula contribute 0; `null` when none have one) — and stays
  editable.
- No manual complete button: closing the order's last open box (nothing left
  unboxed) auto-completes the pending measuring task server-side inside the
  same transaction (`completeMeasuringTaskTx`, shared with
  `POST /measuring-tasks/:id/complete`, which still exists for API clients) —
  when the verify step is enabled this spawns a verify task
  (a second re-measure pass before shipping; see
  [Verify AI scope](../verify/ai-scope.md)).

## Out of scope

- Carrier rate shopping.
- Label printing for shipping boxes.
- Integration with scales or dimensioners.
- Multi-package shipment optimization.

## Key files

- `pages/measuring/index.vue` — task list.
- `pages/measuring/[id].vue` — task detail (boxes overview; no complete
  action — the task auto-completes on the last box confirm).
- `pages/measuring/[taskId]/box/[boxId].vue` — thin wrapper over
  `components/MeasureBox.vue`, the box page body (package verify by scan,
  measurements, close) shared with the verify flow via its
  `mode: 'measuring' | 'verify'` prop (which per-package flag —
  `verified` vs `verifyVerified` — gates the scan).
- `components/BoxMeasurementsModal.vue` — measurement entry (kg inputs,
  `suggestedNetWeightKg` pre-fill, single Confirm-box action).
- `composables/useScanMatchers.ts` — client-side `matchMeasuring`
  (read-only match against the box's packages; apply calls
  `WarehouseService.verifyPackage`; the `flow` context field selects the
  skip flag for the measuring vs verify pass).
- `services/adapters/backendWarehouse.ts` — measuring reads reuse the
  picking verbs for box mutations.
- `apps/backend/src/routes/measuring.ts` + `apps/backend/src/db/measuring.ts` —
  `GET /measuring-tasks?status=`, `GET /measuring-tasks/:id` (computes
  `suggestedNetWeightKg` from `net_weight_formula`),
  `POST /measuring-tasks/:id/complete` (endpoint wrapper over the shared
  `completeMeasuringTaskTx`). Box mutations live with picking
  (`/packages/:id/verify`, `PATCH /shipping-boxes/:id`,
  `/shipping-boxes/:id/close`).
- `apps/backend/src/db/picking.ts` — finishing a picking order (manual or
  auto when the last package is boxed) inserts the `measuring_tasks` row;
  `closeShippingBox` auto-completes a pending measuring task when it closed
  the order's last open box; `parseKg` + the kg fields on
  `updateShippingBox`.

## Known limitations

- Measurements are typed manually; no real weight or dimension capture (the
  net weight is only pre-filled from the formula master).
- Completing a task spawns a `verify_tasks` row when the verify step is
  enabled (the verify flow is the second re-measure pass before shipping);
  with `verify` in `FLOW_STEPS_DISABLED`, completed measuring tasks go
  straight to the admin shipping feed.
- No SSE events — pages reload on visibility.

## Related specs/plans

- `docs/backend/api-design.md` §Measuring
- `docs/superpowers/specs/2026-07-28-measuring-verify-refinements-design.md`
- `docs/superpowers/specs/2026-07-28-verify-step-and-flow-step-config-design.md`
- `docs/superpowers/specs/2026-07-02-measuring-flow-design.md`
- `docs/superpowers/specs/2026-07-03-boxes-section-redesign-design.md`
- `docs/superpowers/plans/2026-07-12-picking-execution.md`
