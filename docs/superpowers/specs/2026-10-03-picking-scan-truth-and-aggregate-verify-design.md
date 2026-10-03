# Picking scan truth + aggregate verify — design

Date: 2026-10-03

Follow-up to `2026-10-02-picking-scan-label-record-design.md` and
`2026-10-02-picking-shelf-scan-config-design.md` (operator feedback on the
first shelf-scan cut). Three changes: a completion-UI regression fix, the
picking detail showing scan truth, and aggregate (total-qty) verify matching
that supersedes the per-package label/qty passes.

## 1. Scan-session completion card regression

The "all applied → go to boxing / back" card (`pages/picking/scan/[id].vue`)
is a `ref` set only when a confirm has zero failed rows. The shelf-scan modes
added failure paths (confirm-time 409s, scan-time rejections, stale failed
rows), so the card often never appears even with the order fully scanned.

Fix: completion becomes **progress-based** — a computed that is true when
the queue is empty and every part group has `scannedQty ≥ requiredQty`
(scanned = Σ packages from the last order fetch), independent of confirm
failure history. The card's buttons are unchanged.

## 2. Picking detail shows scan truth

Today allocations (planned lots) render prominently while an item is open,
and boxed packages render as "qty pcs · box id" with no batch fields — the
scan truth is effectively hidden once items are boxed.

Fix (`components/picking/PickingItemsSection.vue` + backend
`GET /picking-orders/:id`):

- Scanned packages become the primary per-part display: qty + batch fields
  (`dateCode`/`lotCode`/`coo`/`cow`) + `labelBarcode` + box assignment, for
  boxed and unboxed alike. `label_barcode` is added to the detail package
  select (`apps/backend/src/db/picking.ts` picking-order detail query).
- Allocations move into a collapsed "planned" subsection (still visible,
  but clearly plan-not-truth).

## 3. Aggregate verify / measuring matching

Per-package matching (exact label string, then exact single-package qty)
is replaced by one aggregate rule, per operator feedback: verify checks
**totals per part + batch fields**, not which physical labels exist.

### Grouping

Packages group by `partNo/wclItemNo` + `dateCode`/`lotCode`/`coo`/`cow`
(batch fields constrain only when both sides carry a value — existing
rule). Each group has `totalQty` (Σ package qty) and `remainingQty`
(total − already credited).

### Matching (`matchMeasuring` rewrite)

A scan (part + batch fields + qty) matches a group when the part and batch
fields match and `qty ≤ remainingQty`. The result carries the scan qty; the
apply step credits it FIFO across the group's packages, **partial packages
allowed**. This covers: 3 × identical 10k labels, the 15k label vs 2 × 7.5k
portions, and partial scans accumulating. The label pass
(`utils/measuringLabelMatch.ts`) and exact-qty pass are removed — the
aggregate rule subsumes both. `label_barcode` stays on the schema for
traceability/display but no longer drives matching.

### Partial credits need a qty counter (schema change)

Boolean verify flags can't record "7.5k of this package re-scanned", so:

- New column `picking_packages.rescanned_qty` int NOT NULL DEFAULT 0 —
  "how much of this package has been physically re-scanned" in the current
  flow (measuring or verify; the counter is mode-agnostic).
- Migration backfills `rescanned_qty = qty` where `verified` OR
  `verify_verified`.
- `POST /picking-packages/:id/verify` accepts optional `{qty}` (default:
  the package's remaining) and increments `rescanned_qty` capped at `qty`;
  `verified`/`verify_verified` flags still set for the calling mode on
  first credit (UI badges unchanged).
- Completion — client `canComplete` and backend `completeVerifyTask`
  (`packages_not_all_rescanned`) — becomes "every package
  `rescanned_qty >= qty`".

### Files

- `apps/backend/src/db/schema/picking.ts` — `rescannedQty`; migration via
  `db:generate` + backfill UPDATE.
- `apps/backend/src/db/picking.ts` — detail query adds `labelBarcode`;
  `verifyPackage` qty increment; completion checks in `db/verify.ts` +
  measuring close (wherever "all packages verified" gates).
- `apps/backend/src/routes/picking.ts` — verify body `{qty}`.
- `apps/web/services/types.ts` + adapter — `rescannedQty`,
  `labelBarcode` on packages; verify qty.
- `apps/web/utils/measuringLabelMatch.ts` — replaced by an aggregate
  matcher util (group + remaining + FIFO credit plan); tests rewritten.
- `apps/web/composables/useScanMatchers.ts` — `matchMeasuring` single
  aggregate rule; label/exact passes removed.
- `apps/web/components/MeasureBox.vue` — apply credits per package (partial
  allowed), remaining/verified UI per group.
- `apps/web/pages/picking/scan/[id].vue` — progress-based `completed`.
- `apps/web/components/picking/PickingItemsSection.vue` — packages primary,
  planned allocations collapsed.
- i18n locales; `AGENTS.md` + app-docs verify/picking ai-scope updates.
- Tests: backend verify-qty increment/cap/backfill/completion; web aggregate
  matcher (3×10k, 15k vs 2×7.5k, partial accumulate, over-remaining reject,
  batch-field relax rules); completion computed.
