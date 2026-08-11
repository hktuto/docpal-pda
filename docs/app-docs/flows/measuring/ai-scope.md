# Measuring — AI Scope and Remarks

## In scope

- List the open shipping boxes that contain packages (box-scoped — no
  measuring task exists; spec
  `docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`).
  List rows carry server-computed counts: `packageCount` / `verifiedCount`
  plus the aggregated `orderNos[]` (a box may hold packages from several
  picking orders — cross-order packing).
- Box detail as **one consolidated read** (`GET /measuring-boxes/:id`): the
  box and its packages with part identity and the `verified`/`verifyVerified`
  flags embedded, plus `suggestedNetWeightKg` per box. Scanning a box QR/id
  on the list page (`useHardwareScanner`) opens that box directly — exact id
  match, else a unique substring match.
- Box page (`/measuring/:boxId`): packages shown as a table that listens to
  hardware/wedge QR scans — each scan is parsed with the supplier templates
  (`parseRawValue`), matched client-side against the box's unverified
  packages (`matchMeasuring` via `runScanMatcher`), and applied immediately
  with `verifyPackage` by id. The camera/OCR flow (`useLabelScanReview` +
  per-row Scan buttons) remains as fallback.
- Record box measurements (box size, net/gross weights in **kilograms** —
  decimals, 3 dp; destination country) via the shared picking verbs
  (`updateShippingBox` with `netWeightKg`/`grossWeightKg`), then close the
  box. The measurements modal is a single **Confirm box** action (update +
  close); the net weight is pre-filled from the box's `suggestedNetWeightKg`
  — Σ `(formula.weight / formula.qty) × pkg.qty` grams from
  `net_weight_formula` ÷ 1000, computed server-side in the box detail (parts
  without a formula contribute 0; `null` when none have one) — and stays
  editable.
- No manual complete button and no task: closing the box IS the measuring
  completion (`closeShippingBox` guards non-empty, all packages verified,
  destination, box size, positive weights gross ≥ net). When the verify step
  is enabled, closing also spawns the box's pending verify task in the same
  transaction (see [Verify AI scope](../verify/ai-scope.md)).

## Out of scope

- Carrier rate shopping.
- Label printing for shipping boxes.
- Integration with scales or dimensioners.
- Multi-package shipment optimization.

## Key files

- `pages/measuring/index.vue` — box list (open boxes with packages).
- `pages/measuring/[boxId].vue` — the single box page, a thin wrapper over
  `components/MeasureBox.vue` (package verify by scan, measurements, close)
  shared with the verify flow via its `mode: 'measuring' | 'verify'` prop
  (which per-package flag — `verified` vs `verifyVerified` — gates the scan).
- `components/BoxMeasurementsModal.vue` — measurement entry (kg inputs,
  `suggestedNetWeightKg` pre-fill, single Confirm-box action).
- `composables/useScanMatchers.ts` — client-side `matchMeasuring`
  (read-only match against the box's packages; apply calls
  `WarehouseService.verifyPackage`; the `flow` context field selects the
  skip flag for the measuring vs verify pass).
- `services/adapters/backendWarehouse.ts` — `getMeasuringBoxes` /
  `getMeasuringBox`; box mutations reuse the picking verbs.
- `apps/backend/src/routes/measuring.ts` + `apps/backend/src/db/measuring.ts` —
  `GET /measuring-boxes`, `GET /measuring-boxes/:id` (computes
  `suggestedNetWeightKg` from `net_weight_formula`). Box mutations live with
  picking (`/packages/:id/verify`, `PATCH /shipping-boxes/:id`,
  `/shipping-boxes/:id/close`).
- `apps/backend/src/db/picking.ts` — `closeShippingBox` (the close guards;
  spawns the box's verify task when the verify step is enabled), `parseKg` +
  the kg fields on `updateShippingBox`, and the cross-order
  `scanIntoShippingBox` behind `POST /shipping-boxes/:id/scan`.

## Known limitations

- Measurements are typed manually; no real weight or dimension capture (the
  net weight is only pre-filled from the formula master).
- Closing a box spawns a `verify_tasks` row when the verify step is enabled
  (the verify flow is the second re-scan pass before shipping); with
  `verify` disabled in the flow config, closed boxes go straight to the
  admin shipping feed.
- No SSE events — pages reload on visibility.

## Related specs/plans

- `docs/backend/api-design.md` §Measuring
- `docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`
- `docs/superpowers/specs/2026-07-28-measuring-verify-refinements-design.md`
- `docs/superpowers/specs/2026-07-02-measuring-flow-design.md`
- `docs/superpowers/specs/2026-07-03-boxes-section-redesign-design.md`
- `docs/superpowers/plans/2026-07-12-picking-execution.md`
