# Measuring/verify refinements — kg weights, auto net weight, auto-confirm, verify re-scan

Date: 2026-07-28
Status: implemented

Follow-up to `2026-07-28-verify-step-and-flow-step-config-design.md`.

## Problem

Four rough edges in the measuring/verify chain:

1. **Weights in grams.** Shipping-box net/gross weights were entered and shown as integer grams, but warehouse scales and shipping documents work in kilograms — operators had to convert by hand, and decimal weights (e.g. 1.2 kg) were impossible.
2. **Net weight typed by hand.** The `net_weight_formula` master (per-part weight) exists and is seeded for the real parts master, but nothing consumed it — the operator typed every box's net weight from scratch.
3. **Too many confirm steps.** Closing a box needed a measurements Save, then a separate Finish; completing the measuring task needed another button after the last box. On a PDA with a hardware scanner this is dead time per box.
4. **Verify step had no re-scan enforcement.** `completeVerifyTask` only required all boxes closed — the verify pass could complete without re-scanning a single package, so the "second check" was unverifiable.

## Decisions

- **Kilograms, one unit everywhere** (user decision): shipping-box net/gross weights are kg end-to-end — API fields, PDA entry, admin display. Decimals allowed, rounded to 3 dp. The DB columns stay Postgres `real` — only the unit semantics change g → kg (POC data is re-seeded; no data migration).
- **`net_weight_formula` stays in grams** (user decision): the master is per-part source data (`weight` grams per `qty` pieces); the g → kg conversion happens once in the task-detail reads, not in the master table or its admin CRUD (whose labels now say "Weight (g)" explicitly).
- **Suggested, not forced**: the formula-derived net weight is a pre-fill (`suggestedNetWeightKg`), editable in the modal. Parts without a formula row contribute 0; the suggestion is `null` when no package in the box has a formula, so a box of unmapped parts behaves exactly as before.
- **Auto-confirm UX**: one **Confirm box** action persists the measurements and closes the box (two existing API calls client-side — no new endpoint); closing the order's last open box auto-completes the measuring task server-side, which spawns the verify task when enabled. The manual `POST /measuring-tasks/:id/complete` endpoint stays for API clients, but the PDA no longer uses it.
- **Verify re-scan with closed boxes allowed** (user decision): during a pending verify task the worker scans the box and re-scans every package — against the sealed box, without reopening it (reopen stays available for corrections). Completion is blocked until every package carries the new `verify_verified` flag.

## Backend changes (`apps/backend`)

### 1. `picking_packages.verify_verified` (migration `0004_misty_triton.sql`)

`verify_verified boolean NOT NULL DEFAULT false` — the verify-pass counterpart of `verified`. Exposed as `verifyVerified` on packages in the measuring/verify task details and the picking order detail.

### 2. Weights in kg

- `PATCH /shipping-boxes/:id` body fields renamed `netWeightG`/`grossWeightG` → `netWeightKg`/`grossWeightKg` (number or numeric string; decimals allowed; `undefined` = unchanged, `null`/`""` = clear). `parseGrams` → `parseKg` (non-negative, round to 3 dp) — 400 `invalid_net_weight_kg` / `invalid_gross_weight_kg`.
- Response DTOs unchanged (`netWeight`/`grossWeight` on the box rows) — kg by convention now. All close-time guards (`weights_required`, `weights_must_be_positive`, `gross_weight_must_be_gte_net_weight`) work unchanged on the kg values.

### 3. Suggested net weight in task details

- `getMeasuringTaskDetail` / `getVerifyTaskDetail`: each box gains `suggestedNetWeightKg: number | null` = Σ over the box's packages of `(formula.weight / formula.qty) × pkg.qty` grams ÷ 1000, rounded to 3 dp (packages → `picking_items.part_no` → `net_weight_formula`, LEFT JOIN). Parts without a formula contribute 0; `null` when no package has one.

### 4. Auto-complete measuring on last box close

- `completeMeasuringTaskTx` (`src/db/measuring.ts`): the tx-level core of measuring completion (guards + status flip + transition log + verify-task spawn), shared by the endpoint wrapper and the close hook.
- `closeShippingBox` (`src/db/picking.ts`): after closing, inside the same tx, when the order has a pending measuring task and every box is closed and no package is left unboxed → `completeMeasuringTaskTx`. Because the shared helper already spawns the `verify_tasks` row when the verify step is enabled, "last box confirmed → verify task created" falls out of the existing chain.
- `POST /measuring-tasks/:id/complete` is unchanged (same guards, idempotent 409s); the PDA stops calling it.

### 5. Verify-step re-scan (`verify_verified`)

- `verifyPackage` branches on the order's pending task:
  - pending **measuring** task → unchanged (box must be open, sets `verified`).
  - else pending **verify** task → box may be open **or closed** (verifying contents against the sealed box is the normal verify pass); sets `verify_verified = true` **and** `verified = true` (so a reopened box can re-close). 409 `package_already_verified` fires per the applicable flag (`verifyVerified` in the verify branch).
- `reopenShippingBox`: also resets `verify_verified = false` for the box's packages (in addition to `verified`), so a corrected box must be fully re-scanned in both passes.
- `completeVerifyTask`: new guard on top of the existing ones — every package of the order must have `verify_verified = true`, else 409 `packages_not_all_rescanned`.

## Web changes (`apps/web`)

- `components/BoxMeasurementsModal.vue`: kg inputs (`step="0.001"`, labels "Net weight (kg)" / "Gross weight (kg)"); new `suggestedNetWeightKg` prop pre-fills the empty net field (with an "auto-calculated from part weights" hint that clears once the operator edits the value); validation is numbers > 0 with gross ≥ net; the Save/Finish split becomes a single primary **Confirm box** action (`updateShippingBox` with kg values, then `closeShippingBox`, then `finished`).
- `components/MeasureBox.vue`: new `mode: 'measuring' | 'verify'` prop (the two wrapper pages pass it). Per-row badges, `verifiedCount`/`allVerified`, and the scan targets read `pkg.verified` in measuring mode and `pkg.verifyVerified` in verify mode; scanning is allowed on open boxes in both modes and on closed boxes in verify mode; the closed-box card and the measurements modal show/pass kg.
- `composables/useScanMatchers.ts`: `ScanTaskContext` gains `flow?: 'measuring' | 'verify'` (default `'measuring'`); `matchMeasuring` skips already-done packages by the mode-appropriate flag (`verifyVerified` in verify, `verified` otherwise). Matching rules otherwise unchanged (part + exact qty + lot/date constraints).
- `pages/measuring/[id].vue`: the manual Complete button and `canComplete` are gone — the task auto-completes when the last box is confirmed; box rows show weights in kg.
- `pages/verify/[id].vue`: `canComplete` mirrors the backend guard (pending && every box closed && every package `verifyVerified`); per-box progress counts `verifyVerified`; hint text tells the worker to scan the box and every item.
- Services/adapter: `updateShippingBox` args renamed to `netWeightKg`/`grossWeightKg`; `MeasuringBox.suggestedNetWeightKg`, `MeasuringPackage.verifyVerified` added to the DTO types.
- i18n (3 locales): kg labels/placeholders, `common.kg`, the confirm-box button key, the auto-calc hint, and the new error-code keys (`invalid_*_kg`, `packages_not_all_rescanned`).

## Admin changes (`apps/admin`)

- Picking-order detail shipping-boxes column header `"Net / Gross (g)"` → `"Net / Gross (kg)"`; shipping detail box title now shows `net {n} kg / gross {n} kg`.
- The `net-weight-formulas` CRUD stays in grams (it is the per-`qty`-pieces source data) — field labels made explicit ("Weight (g)") so the master is not read as kg.
- `utils/flowApi.ts` package types gain `verifyVerified`.

## Error codes

New: 400 `invalid_net_weight_kg`, 400 `invalid_gross_weight_kg` (rename the gram-era `invalid_net_weight_g`/`invalid_gross_weight_g`), 409 `packages_not_all_rescanned` (verify completion guard). Reused unchanged: 409 `no_pending_measure_or_verify_task`, 409 `package_already_verified`, 409 `shipping_boxes_not_all_closed`, 409 `picking_items_not_fully_packed`, 409 `verify_task_not_pending`, the close-time weight guards.

## Migration note

`drizzle/0004_misty_triton.sql` adds `picking_packages.verify_verified boolean NOT NULL DEFAULT false`. The weight columns keep their `real` type — the g → kg change is unit semantics only; POC data is re-seeded (`POST /dev/reset` / `pnpm db:seed`), so no data migration.

## Tests

- `picking.test.ts` / `measuring.test.ts` / `verify.test.ts` updated for the kg fields and extended for: the auto-complete chain (closing the last box completes the measuring task and spawns the verify task; a manual complete afterwards 409s), the suggested-net-weight calculation (formula join, 3-dp rounding, null without formulas), and the verify re-scan lifecycle (scan during verify works on a closed box; complete 409s `packages_not_all_rescanned` until every package is re-scanned; reopen resets both flags).
- Web: adapter test body fields renamed to kg.

## Out of scope

- Scale/dimensioner hardware integration — weights are still typed (only pre-filled).
- Data migration for previously recorded gram weights (POC re-seed only).
- A `shipped` state / shipper Excel download (existing placeholder — unchanged).
