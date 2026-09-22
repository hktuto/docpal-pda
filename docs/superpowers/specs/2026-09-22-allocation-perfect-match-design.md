# Allocation perfect-match pinning (scoped recompute) — design

Date: 2026-09-22
Status: implemented

## Goal

When allocation is recomputed **scoped** — confirm-arrival / re-allocate of a
receiving order, or the admin Re-allocate of a picking order — prefer
**perfect matches**: a demand whose open qty exactly equals a source's
available qty should win that source whole, even over higher-`priority_seq`
demands that would otherwise nibble it apart.

Motivating case: receiving order `01M311PVMVSM6NZ3EBQTM6ADWW` received 10,000
pcs of `KOA/SR732BTTD R845F` (4 boxes). Picking orders HK2609-0448 and
HK2609-0449 rank higher in `priority_seq` and each took a slice, although
HK2609-0477 needed exactly 10,000. The pure priority+FIFO greedy engine
(`allocateAll`) has no look-ahead, so the exact-fit order lost its lot.

## Decisions

- **Scoped runs only; `allocateAll` untouched.** The pre-pass lives in
  `runScopedAllocation` (`apps/backend/src/db/allocate.ts`), the shared core
  of `allocateForReceivingOrder` (confirm-arrival at
  `POST /receiving-orders/:id/confirm-arrival`, admin
  `POST /admin/receiving-orders/:id/reallocate`) and `allocateForPickingOrder`
  (admin `POST /admin/picking-orders/:id/reallocate`). The background
  full-fleet `allocateAll` keeps pure `priority_seq` + FIFO behavior. The two
  cores deliberately diverge now (the "keep them in sync" note is updated):
  the scoped core is the interactive, admin/PDA-triggered path where the
  perfect-match preference is wanted; the background engine stays the simple
  deterministic baseline.

- **Perfect matches are written as pinned (`allocations.manual = true`).**
  This is what makes "leave `allocateAll` as-is" coherent: `allocateAll`
  wipes every non-manual allocation of open items on nearly every warehouse
  event (receiving scans, put-away, picks, goods-verify, admin edits), so an
  unpinned perfect match would be silently reverted within minutes. As manual
  rows they survive every wipe, are pre-subtracted from the item's
  auto-allocation demand, and are netted out of dock availability by
  `loadReceivingSources`' `locked_*` subqueries — all existing machinery, no
  schema change. They are removable with the existing per-allocation remove
  action (`removePickingAllocation` is flag-agnostic), giving admins the
  escape hatch when a match was wrong. The RESERVE ledger row uses
  `txn_reason = "recompute: perfect match"` so perfect-match pins are
  distinguishable from admin pins (`"admin: manual allocation"`) in the
  ledger; in the admin allocation lists they render like other pinned rows
  (a separate UI badge is out of scope).

- **Two match levels, group before single.** The pre-pass runs two passes
  over the demands (each in `priority_seq` order, after
  `resolveDemandLocation` and after pre-subtracting existing manual pins):
  - **Pass A — whole-receiving-order group match (dock stock only):** group
    the demand's box-level (`ctn_no`) receiving source rows by
    `receiving_order_id`; if the summed available of one order's rows exactly
    equals the demand's remaining open qty, pin ALL of that order's rows to
    the demand. Covers the motivating case (4 boxes × 2,500 = 10,000).
  - **Pass B — single-row match:** one source row — a shelf lot, a box-level
    receiving item, or an order-level (no `ctn_no`) receiving row — whose
    available exactly equals the remaining open qty; pin that row.
  Pass A runs for all demands before Pass B starts, so a big whole-order
  match is not fragmented by a smaller single-row match from an
  earlier-priority demand (deliberate: the exact-fit preference outranks
  `priority_seq`; pins are admin-removable when that choice is wrong).

- **Exact equality only.** No best-fit / subset-sum: a source larger than
  the demand, or a group summing past it, is not a match — the main
  priority+FIFO loop handles those as today. Keeps the rule explainable
  ("the numbers are exactly equal") and the implementation small.

- **All existing matching rules apply unchanged.** The pre-pass loads
  sources with the same `loadLotSources` / `loadReceivingSources` queries as
  the main loop: location pair + share-group widening + case-insensitive
  codes, transfer-item conversion (`resolveDemandLocation`),
  `allowDockStock()` gate for pass A/receiving rows, shelf-FK orphan
  exclusion, part-key match (`part_no` OR `wcl_item_no`), NULL-pair receiving
  rows skipped (counted in `skippedReceivingSources`). Work-locked orders
  never appear in `loadDemands`, so they can't receive or lose pins.
  Tie-breaks inside a pass: demands in `priority_seq` order; sources/groups
  in the queries' FIFO order (`date_code ASC NULLS LAST`, then id), first
  exact candidate wins.

- **In-run availability.** Lot pins apply their `allocated_qty` UPDATE
  immediately inside the tx (same shelf-FK-guarded UPDATE as the main loop),
  so later demands' `loadLotSources` see the reservation. Receiving pins are
  visible to later `loadReceivingSources` calls through the existing
  `a.manual` netting in `locked_ii` / `locked_ro`, so no separate in-run
  tracker is needed.

- **Change detection + summary.** Pre-pass pins count as a change
  (`changed = keyChange || perfectMatchPins > 0`) so `allocation.computed`
  fires even when the pins are the run's only effect (they are manual rows
  and therefore excluded from the before/after key multisets). A new
  `AllocateSummary.perfectMatched` field counts demands that received a
  perfect-match pin (0 in `allocateAll`). Re-running the same scoped
  recompute is idempotent: the pins already cover the demand (remaining =
  0), nothing is re-created, `changed = false`.

- **Receiving status override routes through the scoped run.**
  `PATCH /admin/receiving-orders/:id/status` previously scheduled a full
  `allocateAll` on change. A receiving status flip only adds/removes sources
  for that order's own part keys (parts never compete), so the scoped run is
  provably equivalent — and it brings the perfect-match pre-pass to the
  "admin sets an order in_hand" path. On scoped failure it falls back to
  `scheduleAllocateAll(db, "admin_status_override")`, mirroring the
  confirm-arrival pattern (`allocation: null` semantics; the response body
  itself is unchanged). The picking status override keeps
  `scheduleAllocateAll` (reopening/closing an order changes demand, and
  `allocateForPickingOrder`'s 409 guards don't fit an any→any override).

## Out of scope

- Perfect-match in `allocateAll` (deliberate — see above).
- Best-fit / subset-sum matching (only exact equality).
- An admin-UI badge distinguishing perfect-match pins from admin pins
  (ledger `txn_reason` carries the distinction).

## Test plan

`apps/backend/src/db/allocate.test.ts`:

1. Group match: 4 box rows (2,500 each) of one part in a confirmed receiving
   order; a low-priority picking item needs 10,000, two higher-priority items
   need 4,000/6,000 → scoped recompute pins all 4 rows (manual) to the
   10,000 demand; the higher-priority demands get nothing from that order.
2. Single-row match on a shelf lot (available == open qty) beats a
   higher-priority partial demand in a scoped run.
3. Pins survive `allocateAll`: run the full recompute after the scoped run;
   the pinned rows are intact, other demands rebuilt around them.
4. No exact match → scoped run behaves exactly as before (pure priority+FIFO
   split).
5. Idempotency: second scoped run creates nothing, `changed = false`.
6. Admin receiving status override to `in_hand` allocates via the scoped
   path (perfect-match pin present) — route-level behavior covered by unit
   test on the swap helper or manual verification.
