# Admin receiving item re-allocate form — design

Date: 2026-10-12
Status: implemented
Related: `2026-09-15-admin-picking-item-actions-design.md`,
`2026-10-06-admin-availability-dialog-improvements-design.md`,
`2026-10-12-admin-availability-dialog-location-filter-design.md`

## Problem

The receiving-order detail 🔍 dialog (`apps/admin/components/receiving/PartSearchModal.vue`)
lets an admin point a receiving item's stock at an open picking demand row, one row at a
time. Two gaps make it unusable for the job admins actually want it for:

1. **A row that is already fully allocated cannot be topped up.** The qty input is capped
   at `remainingQty = qty − picked − allocated` and disabled when that is 0. The intent —
   "I want this receiving item to cover this order instead of whatever covers it now" —
   is unreachable.
2. **Redistribution is one dialog round-trip per row.** Moving 100 pcs from order SO-1 to
   order SO-2 means: open SO-1's allocation, delete it, come back, allocate to SO-2. Each
   step is a separate confirm, and an intermediate state where the item's stock is
   double-counted or idle.

The picking-side modal (`PartAvailabilityModal.vue`) has an Override button, but it does
**not** solve this. Its override targets a *source* shortfall (qty above a lot's
available) and reclaims other items' allocations *on that lot*. It cannot bypass
`addManualPickingAllocation`'s second guard, `allocated + qty > openQty` → 409
`over_allocation` (`apps/backend/src/db/allocate.ts:1088`), which is unconditional. So the
picking-side Override cannot rescue an already-allocated demand row either.

## Decision

Turn the dialog into a **re-allocation form**: list every allocatable demand row, let the
admin type the *desired final total* this receiving item should supply to each row, and
apply the whole set in one all-or-nothing transaction.

### Final-state inputs, not deltas

Each input is the **total** the receiving item should hold on that row after the change,
not an increment. This is what makes the operation coherent:

- Releasing before allocating means the per-item `over_allocation` guard is satisfied by
  construction — we only ever add qty to a row that has room below `qty − picked`.
- The pool identity `Σ(final totals) ≤ receivedQty − pickedQty` is self-balancing: what
  one row gives up, another row can take. No reclaiming from unrelated orders, so no
  unrelated picking order is left short.
- It matches the mental model: "distribute *this* receiving item's stock across these
  picking orders".

A delta form would keep hitting the `over_allocation` wall described above.

### Scope of rows: unchanged

The form lists the same rows the dialog lists today — the part's open picking demand
(`pending`/`picking`/`allocated`) filtered to the `matched` flag, i.e. the receiving item's
org plus the same sub-inventory or a sibling in the same share group. Fully-allocated rows
are included; they were always listed, only their input was dead.

Rows outside that partition stay excluded. A manual pin into a different partition is
something the allocation engine would never create and would fight on every recompute.

### All-or-nothing

The admin is moving one pool of stock around. A half-applied redistribution is much harder
to reason about afterwards than a rejected form, so the whole set commits in one
transaction or not at all. When any touched row is invalid the response names every
invalid row and why.

## Data model

### `GET /admin/part-demand` — two new fields

Optional `fromReceivingItemId` query param adds a per-row `fromItemQty`: the qty that row
currently holds **from that receiving item** (not from all sources). The form is a
final-state form, so it must show the current value per row; without this the form cannot
be rendered or diffed.

Also added unconditionally, so the UI can mark rows it must not edit rather than letting
the admin type into a row that will reject the whole batch:

- `locked` — the order has a live PDA work lock (`working_by` set and `working_at` not
  expired).
- `workingByName` — the holder, for the row badge.

### `POST /admin/receiving-orders/:id/items/:itemId/reallocate-demand`

Body `{rows: [{pickingItemId, qty}]}`. `qty` is the desired final total from this
receiving item; rows absent from `rows` are left at their current value.

Validation, all before any write, all reported together:

| Check | Error code |
| --- | --- |
| receiving item belongs to the receiving order | 404 `receiving_invoice_item_not_found` |
| every `pickingItemId` is a real item | 404 `picking_item_not_found` |
| each order status ∈ `pending`/`picking`/`allocated` | 409 `order_not_open` |
| no live work lock on any touched order | 409 `lock_held` |
| `qty >= 0` integer | 400 `invalid_qty` |
| per row `qty <= item.qty − item.picked` | 409 `over_allocation` |
| `Σ final totals (touched + untouched) <= receivedQty − pickedQty` | 409 `insufficient_available` |

Applies, in one `db.transaction`:

1. **Release** — for each row where current > desired, delete/reduce that row's allocation
   rows sourced from this receiving item, **manual pins first (oldest first), then engine
   (non-manual) allocations (oldest first)**. Manual-first because a manual pin is an
   explicit admin decision and freeing an engine allocation is the less deliberate act.
2. **Add** — for each row where desired > current, **amend** the allocation row that
   already holds this receiving item's stock on that picking item (preferring a manual
   pin, then the oldest row) instead of inserting a second one. One picking item + one
   receiving item is one allocation line: the admin UI lists each allocation row
   separately (per-allocation (x), hover detail), so a second row would render as a
   duplicated line. The amended row is forced to `manual = true` — the admin just stated
   a final total, and a non-manual row would not survive the wipe/rebuild.
3. **Bookkeeping per touched row** — `RESERVE` ledger row per change (`txn_delta` signed,
   `txn_reason: "admin: reallocate"`), `recomputePickingItem`, a `transaction_logs` entry
   (`action: "allocation_released"` / `"allocation_reallocated"`, before/after qty), and
   an `allocation.computed` SSE event on `/picking-orders`.
4. `scheduleAllocateAll` after commit so the engine tops up the freed demand from other
   sources. The new pins are `manual = true`, which the wipe/rebuild preserves and
   pre-subtracts from demand, so the form's distribution survives.

Response: `{itemId, available, fromItemQty, changed: [{pickingItemId, orderNo, from, to}]}`.

## Known limit: the form places, it does not starve

The form cannot durably hold a row **below** what the engine would give it. Manual pins
are preserved by the wipe/rebuild and pre-subtracted from demand, but the engine then
fills each item's *residual* demand from the *residual* stock. So if the form leaves part
of the pool unplaced, that leftover goes straight back out — by priority — to whichever
order is still short.

Measured on a 1000-pool with SO-RA-001 (600, priority 1), SO-RA-002 (400) and SO-RA-003
(200):

| Form asks for | After the post-commit recompute |
| --- | --- |
| SO-RA-001 = 0, SO-RA-002 = 400 (400 placed) | SO-RA-002 = 400, **SO-RA-001 = 600** |
| SO-RA-001 = 400, SO-RA-002 = 400, SO-RA-003 = 200 (whole pool) | exactly 400 / 400 / 200 |

The second row is the feature working: the engine's greedy fill would have given
SO-RA-001 its full 600, and the admin overrode that.

So the rule the form actually offers is **"move stock, don't withhold it"**: to take qty
away from an order, place it on another order in the same submit. The UI states this in
the hint and warns (`reallocPoolUnder`) whenever the planned total is under the pool.
Making a row durable-below-demand would need a "held back" concept in the allocation
engine, which is out of scope here.

## Admin UI

`PartDemandTables.vue` becomes the form (it is only used by `PartSearchModal.vue`):

- Each row gains a **From this item** column (current) beside the input (desired).
- Inputs are always enabled; the operator is never blocked from typing.
- Inline warnings, never a disabled control:
  - per row: input > that row's own `qty − picked` → over its requirement;
  - form-level: `Σ inputs > available` → the pool is oversubscribed.
- Work-locked rows render with a holder badge and are read-only (they would reject the
  whole batch, so we say so up front rather than at confirm time).
- A single **Confirm re-allocation** button in the dialog footer, disabled while the form
  is invalid or unchanged, plus a live `planned / available` counter.
- Submitting sends the whole form; a 409 renders the per-row reasons in the existing
  error banner.

The related-stock table in the dialog is unchanged.

## Tests

`apps/backend/src/routes/admin/allocation.test.ts`:

- happy path — the whole pool placed 400/400/200 against an engine that would have
  filled 600/400; the result holds after the post-commit recompute.
- raising a row the engine had already fully allocated (the guard the old per-row form
  could not pass).
- `qty = 0` releases the row and the freed qty goes to another row in the same submit.
- under-placing the pool lets the engine redistribute the leftover (documented limit).
- `Σ > available` → 409 `insufficient_available`, and **nothing** changed (all-or-nothing).
- a locked victim row → 409 `lock_held`, and the other rows in the same batch did **not**
  commit.
- `qty > row qty − picked` → 409 `over_allocation`, nothing changed.
- untouched rows keep their allocations and still count against `available`.
---

# Addendum — the picking-side modal becomes the same kind of form

The receiving side of this design went first; the picking-side availability
modal (`apps/admin/components/PartAvailabilityModal.vue`) was then converted to
the same shape, so both dialogs read and behave identically: **state the final
total per row, one Confirm, all-or-nothing.**

## What changed

The per-row **Allocate** button (and its per-row 覆寫分配 **Override** variant) is gone.
Each row keeps an always-enabled qty input whose value is the **total this
picking item should hold from that source afterwards**, and a single
**確認分配** sits at the bottom next to **取消**, applying every row at once.

The Override capability is preserved, not dropped: a row whose growth exceeds
its source's availability is flagged inline ("Will reclaim N from other
orders"), and Confirm asks once for all such rows before sending
`override: true` only on those.

## `POST /admin/picking-orders/:id/items/:itemId/allocate-form`

`apps/backend/src/db/pickingAllocateForm.ts` — `allocatePickingItemFromSources`.

```jsonc
{ "rows": [ { "inventoryLotId": "…", "qty": 300, "override": false } ] }
// or     { "receivingInvoiceItemId": "…", "qty": 0 }
// → { pickingItemId, openQty, allocated, changed: [{key, inventoryLotId, receivingInvoiceItemId, from, to}] }
```

Same final-state rules as the receiving side, with one important difference in
what "absent" means:

| | receiving `reallocate-demand` | picking `allocate-form` |
|---|---|---|
| Key | picking item | SOURCE (lot / receiving item) |
| Row cap | that order's own requirement (`qty − picked`) | the source's max (lot `totalQty`; receiving `received − picked`) |
| Budget | the receiving item's pool (`received − picked`) | the item's open qty (`qty − Σ packages`) |
| Rows omitted | keep their current value | keep their current value |
| Post-run engine call | `allocateForReceivingOrder` (backfill) | none — the pins are enough |

**Omitted rows keeping their value matters more here.** The dialog filters rows
by date-code range and by the order's location match (`matched`), so a source
the admin cannot see must never be released by a submit. The client sends only
the rows it renders.

Release-before-grow is what lets a row that is already fully allocated be
raised at all: the over-allocation guard is evaluated once, against the FINAL
total (`Σ desired ≤ openQty`), instead of once per increment.

Growing a row **amends** the allocation line that already holds that source on
that picking item (preferring a manual pin, then the oldest row) rather than
inserting a second one, and forces it to `manual = true`. One picking item +
one source is one allocation line; the admin UI lists allocation rows
separately, so a second row would render as a duplicated line — and a
non-manual row would not survive the next wipe/rebuild, silently discarding
the admin's decision.

## Override reachability is pre-validated

On the receiving side every row is bounded by the pool, so there is nothing to
steal. Here a row may legitimately ask for more than a source's free qty — that
is the whole point of Override.

So before applying anything, each override row's shortfall is checked against
what can actually be reclaimed (other items' non-manual allocations on that
source, skipping orders whose PDA holds a live work lock — the same rule
`stealAllocationsOnSource` applies when it moves them). A row that cannot be
covered is rejected with a per-row `insufficient_available` reason instead of
failing the batch halfway through the apply loop.

The steal itself is the shared `stealAllocationsOnSource` helper, extracted
from `addManualPickingAllocation` so both paths keep identical victim
selection, ledger rows, victim-order audit entries and SSE events.

## Known limits (same family as the section above)

- **It moves stock, it does not withhold it.** Releasing a row leaves the freed
  demand open for the next engine run to fill from anywhere.
- **No engine recompute is scheduled**, matching the old per-row action: the
  changed rows are all pins, so nothing is lost and the rest of the item's
  allocation is left as the engine left it.
- Rows hidden by the date-code / `matched` filters keep their allocations —
  which is exactly why they are excluded from the payload.

## Tests

`apps/backend/src/routes/admin/allocation.test.ts`:

- the whole form applied at once (300/300), then moved onto one source (600),
  asserting the row COUNT stays one per source and every surviving row is a pin.
- a row left out of the payload keeps its qty across a later submit, and an
  empty payload is a no-op.
- one invalid row (over the item's open demand) rolls the whole batch back —
  including the rows that were individually valid.
- 400 `source_required` / `duplicate_source` / `invalid_qty`, 404 unknown
  source, 409 `allocate_rejected` with the offending row's `l:<lotId>` key.
- an override row reclaims the other order's allocation inside the same call.
- 404 unknown order / item, 409 `lock_held`.
