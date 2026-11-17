# Internal Transfer — Transfer Items as Picking Allocation Supply (Design)

Date: 2026-11-17
Supersedes the order-level delegated picking-order link of
`2026-11-10-internal-transfer-admin-allocate-design.md` and
`2026-11-10-internal-transfer-pda-picking-design.md` §finish-branches.

## Problem

An internal transfer gathers stock for one or more picking orders, but the
mapping is per line item, not per order. The whole-order
`internal_transfer_orders.picking_order_id` link can't express one
transfer's items feeding different picking orders (or some items just being
put away). Also, upstream sync owns the `internal_transfer_*` tables —
no new columns there (insert-only writer contract).

## Decision

Make a confirmed internal transfer item a **first-class supply source** in
the picking allocation engine — the same role dock stock plays today, with
its partition resolved like TN picking orders resolve theirs:

> **Supply pair per transfer item** = `matchSubInventoryRule(to_org_id,
> item.po_no, receivingSubInventoryRules())`, falling back to the item
> order's `to_sub_inventory_code` when no rule matches.

No mapping/link UI at all: the admin transfer page keeps only "where do I
find this item" (its `from_`-partition allocations); the picking order side
allocates against the transfer item directly (Re-allocate, manual pin via
the 🔍 availability dialog, stock-search). When a transfer item is fully
allocated to picking, the transfer's put-away need disappears — allocation
actions drive the `put_away_tasks` row (never created / removed when fully
allocated; it returns when an allocation is removed).

## Schema (app-owned tables only)

`allocations` (picking allocations — ours):

- Add `internal_transfer_item_id text NULL → internal_transfer_items.id
  ON DELETE cascade`.
- Widen `chk_allocations_source` to
  `num_nonnulls(inventory_lot_id, receiving_invoice_item_id,
  receiving_order_id, internal_transfer_item_id) = 1`.
- Index `idx_allocations_internal_transfer_item`.

`internal_transfer_orders.picking_order_id`:

- Deprecated — migration NULLs it out (per-item promise is now carried by
  `allocations` rows); the column stays for the sync writer's shape but app
  code never reads or writes it again. The order-level assign endpoint and
  admin link UI are removed.

`put_away_tasks`: unchanged (unique index on `internal_transfer_order_id`
still holds — at most one task per transfer, created/removed by allocation
actions, see lifecycle below).

## Supply pool (transfer item as source)

An item is allocatable supply when its order is **confirmed** — status
`allocated | picking | issue` (the Confirm gate; admin has settled the
`from_`-partition sourcing first, per decision). Supply qty:

```
supply(item) = item.qty − Σ picking allocations on that item (any order)
```

- The order-level issue (`issue_qty`) does not pre-shrink supply; a
  recorded issue makes the physical arrival short — at finish the
  materialized lots may under-cover the picking promise, and the promised
  order's next Re-allocate reconciles (same confirm-arrival semantics as
  today's delegated branch).
- When the transfer order is `finished`, remaining supply is the
  unshelved-package qty per item (promised packages have materialized).

## Matching (picking demand → transfer item source)

Same rules as every other source (`docs/backend/allocation.md`):

- **Pair match:** the transfer item's resolved supply pair (above) must
  match the demand's pair — case-insensitive sub codes,
  `sub_inventory_share_members` widening, org-agnostic demand matches any.
- **Part key:** supplier `part_no` or `wcl_item_no` equality as usual.
- **FIFO / tier order:** transfer supply is offered **after shelved lots,
  alongside dock stock** (tier: shelf lots → dock stock → transfer items;
  the exact interleave can be tuned later — flag it in the engine).
- Allocation row granularity: one row per (transfer item, picking item)
  with `qty` — no sub-lot detail (the physical lot split happens at the
  transfer's own picking/finish, the promise is item-level).

## Shared-pool invariant (net both ways)

Every availability path that already nets `internal_transfer_allocations`
must now ALSO net picking allocations on transfer items:

- `loadReceivingSources` / `recomputeLot` (transfer's own engine): a source
  lot reserved by the transfer may itself be promised onward — the
  transfer's allocation engine is unchanged (it reserves `from_` stock;
  picking promises do not consume `from_` reservations).
- Picking manual-add cap, part-availability dock numbers, stock-search:
  subtract transfer-item qty already promised to OTHER picking orders
  (`internal_transfer_allocations` stay out of picking availability — they
  reserve `from_` stock the picking demand can't see anyway).

## Engine wiring (`allocate.ts`)

- New source loader `loadInternalTransferSources(partKeys, pair)` —
  confirmed transfer items with supply > 0, pair-resolved, FIFO by
  transfer order `priority_seq` then `created_date`.
- `allocateForPickingOrder`, `allocateAll`, manual add/remove, and the
  availability dialog all consume the loader. Work-lock rules unchanged
  (transfer order lock is independent; a picking re-allocate never wipes a
  transfer's own allocations).
- Summary: `AllocateSummary.skippedInternalTransferSources` for items whose
  order is not confirmed (surfaced, never allocated — mirrors the NULL-pair
  receiving rule).

## Put-away task lifecycle (allocation actions drive it)

New helper `syncTransferPutAwayTask(db, transferOrderId)` called inside the
same tx as any picking allocation mutation touching that transfer's items
(add/remove/manual/wipe-rebuild):

- promised qty = Σ picking allocations on the transfer's items;
- `promised < total item qty` AND order `finished` AND no task → create
  task `(to_org_id, resolved_sub)` (resolved sub = rule per the mix of
  remaining items; falls back to `to_sub_inventory_code`);
- `promised >= total` (or no unshelved remainder) → delete any pending task
  (in-progress shelve work wins — never delete a `pending` task with
  packages already shelved; treat as completed instead);
- before finish: no task exists — finish creates one only if a remainder
  remains (see below).

## Finish fan-out (`finishInternalTransferOrder`)

1. Guard unchanged (all items picked or issue recorded; status window).
2. Load the transfer's picking promises grouped by **distinct picking
   order** (from `allocations.internal_transfer_item_id`).
3. Per promised picking order: materialize that order's promised packages
   as unshelved lots at **that order's own** `(org, sub)` pair (natural
   lot-key merge, `ADJUST on_hand` ledger, referenceType
   `internal_transfer_order`) — same code path as today's delegated
   branch, per order. Promised packages are consumed (not left for
   shelving).
4. Remainder packages (unpromised qty, e.g. issue-short or unallocated
   items) → one `put_away_tasks` row as today, only when remainder > 0.
5. Post-commit: `allocateForPickingOrder` re-runs for each distinct
   promised order (awaited set, per-order try/catch). Result payload
   becomes `allocations: Record<pickingOrderId, result | null>`.
6. SSE `internal-transfer.updated` as today.

## Shelving (remainder)

`shelveInternalTransferPackages` candidate query stays as-is (promised
packages no longer exist as unshelved). Put-back/cancel and task-completion
logic unchanged.

## Stock search + availability dialog

- Stock search gains a supply row type "internal transfer" per confirmed
  transfer item: part, qty (net of promises), resolved pair, order no.
- The picking availability dialog (🔍) lists transfer items as pinnable
  rows; pinning creates an `allocations` row with
  `internal_transfer_item_id`.

## UI

**Admin transfer page (`internal-transfer-orders/[id].vue`)**

- Remove the delegated-order link UI + Unlink button (endpoint removed).
- Detail shows per item: supply qty, net promised qty, promised order(s) —
  read-only info; sourcing (allocations) unchanged.

**Picking admin detail / PDA**

- Allocations against transfer items render like any source row
  ("Internal transfer <order_no>").
- PDA finish toast: per promised order re-allocation result + remainder →
  shelving.

## Out of scope / unchanged

- Transfer's own allocation engine (`from_`-pair FIFO, manual pins) — the
  transfer page stays "where to find this item".
- No new columns on `internal_transfer_*` upstream-synced tables.
- No assignee routing, no boxes/shipping for transfer packages.
- `part-demand` still does not list transfer demand; override-steal still
  never reclaims transfer rows.

## UAT / docs

- `functions.json`: ADM-040 description (drop delegated link, add supply
  pool), PDA picking/finish description, picking-allocation function
  mentions the new source type.
- Update `docs/app-docs/flows/internal-transfer/*`, `docs/backend/allocation.md`,
  `docs/backend/flow-config.md` (rule reuse note), `ai/feature-registry.md`,
  `ai/code-map.md`; addendum in the two 2026-11-10 specs.
