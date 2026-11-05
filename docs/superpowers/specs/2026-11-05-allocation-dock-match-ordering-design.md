# Allocation dock-match ordering (PO match, date-code-gated perfect match) — design

Date: 2026-11-05
Status: implemented

Supersedes the matching rules of
`2026-09-22-allocation-perfect-match-design.md` (the pinning mechanics —
`manual = true` rows, ledger reasons, pre-subtraction, admin removability —
are unchanged).

## Goal

Define a strict source-preference order for the scoped recompute
(`runScopedAllocation` — admin Re-allocate, confirm-arrival, receiving status
override) that matches the business's intent:

1. **Shelf inventory** is consumed first, pure FIFO by date code.
2. **Receiving dock stock** is consumed for the remainder, in this order:
   a. **PO match** — rows whose `receiving_invoice_items.po_no` equals the
      picking demand's PO are pinned first.
   b. **Qty perfect match** — an exact-fit source is pinned, but only at the
      oldest available dock date code.
   c. **FIFO** by date code for whatever remains.

## Motivation

The 2026-09-22 perfect-match pre-pass checked for an exact-fit source
**regardless of date code**, before the FIFO loop. A demand of 100 with lots
(dc 2501, 60 pcs) and (dc 2502, 100 pcs) got the 2502 lot pinned — newer
stock shipped while the oldest lot sat on the shelf, which is how outdated
stock accumulates. The spec never discussed this interaction; the violation
was an unconsidered gap, not intent.

Separately, shelf lots have no physical "box" identity worth protecting
(put-away merges stock into fungible lots), so exact-fit pinning on a lot
bought nothing — the protection only means something on the dock, where a
receiving order's physical boxes are kept together for the exact-fit
customer order.

## Decisions

### Level 1 — shelf inventory: pure FIFO

The lot branch of the old perfect-match pre-pass is **removed**. Shelf lots
allocate exactly as the main loop does today: `date_code ASC NULLS LAST`,
`id` tiebreak, each demand in `priority_seq` order. No pinning of any kind
on shelf stock.

### Level 2 — dock stock: three ordered passes

All passes operate on the demand's **dock remainder**: `open qty − existing
manual pins − simulated shelf FIFO take` (see "Shelf-first simulation"). A
demand fully covered by shelf stock never touches the dock passes.

**Pass PO — PO binding (new).** The demand's PO is the item's
`additional_data.po_no`, falling back to the order's `picking_orders.po_no`
(trimmed; empty → no PO). Dock rows whose `po_no` matches exactly
(trimmed, case-sensitive; `po_line` ignored) are pinned to the demand in
FIFO order, partial takes allowed — more stock than needed → take just the
remainder; less → take all and continue to the next pass. Date code is
**ignored** deliberately: the PO link is explicit business intent ("this
stock was bought for this order") and outranks FIFO. Ledger `txn_reason`:
`"recompute: po match"`; counted in the new `AllocateSummary.poMatched`.

**Pass A — whole-order qty perfect match (date-code gated).** Unchanged
from 2026-09-22 except: a receiving order's box group qualifies only when
**every box row carries the demand's oldest available dock date code**
(strict option — mixed-date-code groups never pin). "Oldest" is the first
non-null `date_code` in the demand's FIFO-ordered allocatable dock rows;
when every row's date code is NULL the gate is vacuous (all rows qualify).

**Pass B — single-row qty perfect match (date-code gated, dock only).** One
box-level or order-level dock row whose available exactly equals the dock
remainder, **and** whose date code equals the oldest available dock date
code. The shelf-lot branch is gone (see Level 1).

Pass order across the fleet: Pass PO for all demands (in `priority_seq`
order), then Pass A for all demands, then Pass B — PO binding outranks qty
exact-fit, and a big group match is not fragmented by a smaller single-row
match from an earlier-priority demand (unchanged from 2026-09-22).

**FIFO fallback.** Remainders after the passes flow into the existing main
loop: shelf lots first, then dock rows by date code.

### Shelf-first simulation

The pre-pass runs before the main loop (so an exact-fit / PO-bound demand
still outranks higher-`priority_seq` nibblers — the original 2026-09-22
guarantee), but the passes must size themselves against what shelf stock
*would* cover. The scoped core therefore runs a **no-write simulation** of
the shelf FIFO loop first: demands in `priority_seq` order consume
`loadLotSources` availability through a local `lotId → used` map; each
demand's leftover is its dock remainder. Pins only ever touch dock rows and
dock availability, so the simulation cannot be invalidated by them. The main
loop is unchanged and re-does the real shelf allocation; a demand whose pins
reduced its open remainder simply takes less shelf/dock FIFO — totals can
never exceed open qty or source availability because every take is capped by
both.

### Unchanged mechanics

- Pins are `allocations.manual = true` rows: they survive every later
  wipe/rebuild (`allocateAll` included), are pre-subtracted from the item's
  auto demand, are netted out of dock availability by
  `loadReceivingSources`' `locked_*` subqueries, and are removable via the
  admin remove-allocation action.
- All existing matching rules apply to every pass: location pair +
  share-group widening, transfer-item conversion (`resolveDemandLocation`),
  `allowDockStock()` gate, shelf-FK orphan exclusion, part-key match
  (`part_no` OR `wcl_item_no`), NULL-pair receiving rows skipped.
- `allocateAll` (dev/test-only) runs no pre-pass at all — pure
  `priority_seq` + FIFO. With lot perfect-match removed, only dock stock
  diverges between the two cores.
- Change detection: pins count as a change; re-running the same scoped
  recompute is idempotent (`changed = false`, no new rows).
- Work-locked orders are excluded from `loadDemands` — they can neither
  receive nor lose pins.

## Out of scope

- `po_line`-level matching, fuzzy/case-insensitive PO matching.
- Unified date-code FIFO across shelf + dock (shelf strictly precedes dock,
  as today).
- Perfect-match / PO matching in `allocateAll`.
- Admin-UI badges distinguishing pin kinds (ledger `txn_reason` carries it).

## Test plan

`apps/backend/src/db/allocate.test.ts`:

1. Lot exact-fit no longer pins: exact-fit lot + higher-priority partial
   demand → priority+FIFO split, `perfectMatched = 0`.
2. Whole-order group match (2026-09-22 motivating case) still pins when all
   boxes share the oldest dock date code; idempotent re-run.
3. Group/single-row match with a **newer** date code than another available
   dock row → NOT pinned; FIFO split instead.
4. PO match: demand PO matches dock rows → rows pinned (manual), beating a
   higher-priority demand and ignoring date code; partial take when the
   match holds more than needed; order-level `picking_orders.po_no`
   fallback works.
5. Shelf-first: demand PO matches dock rows but shelf stock covers part of
   the open qty → PO pins cover only the remainder.
6. Pins (PO + perfect) survive `allocateAll`.
