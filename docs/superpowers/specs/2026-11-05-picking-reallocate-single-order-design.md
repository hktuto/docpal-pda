# Picking Re-allocate: strictly single-order scope (2026-11-05)

## Problem

The admin picking-order detail's **Re-allocate** button (`POST /admin/picking-orders/:id/reallocate` → `allocateForPickingOrder`) was built on the part-key-scoped recompute core (`runScopedAllocation`): it collected the order's part numbers and wiped/rebuilt **every open picking item sharing those part keys**, in global `priority_seq` order (spec `2026-11-03-allocation-manual-only-design.md`). Warehouse feedback (Sean, 2026-11-05): admins expect the button to affect **only the order they selected**. Re-allocating order A silently reshuffled order B's allocations because both carried the same part number — reported as a bug.

## Decision

`allocateForPickingOrder` becomes **strictly single-order**: it wipes and rebuilds only the selected order's open picking items. Other orders — including every order sharing a part number — keep their allocation rows byte-for-byte untouched.

`allocateForReceivingOrder` (confirm-arrival / receiving re-allocate) **keeps the part-key scope**: newly arrived stock must flow to the highest-priority open demand across orders, so a single-order scope there would be wrong. `allocateAll` (`POST /dev/allocate`) is unchanged.

## Mechanics (`src/db/allocate.ts`)

- `loadDemands` gains `onlyOrderId` (replacing the now-dead `includeOrderId`): `WHERE po.id = <order>` with **no** status/work-lock clause — the route guards (404 / 409 `order_not_open` / 409 `lock_held`) already ran, and the `allocated`-status repair path (stale rows on an admin-locked order, spec `2026-09-22-picking-allocated-skip-status-design.md`) keeps working because the order's items are demands regardless of status. The open-qty filter (`qty > Σ picking_packages`) stays.
- Wipe: unchanged mechanics, but `itemIds` is now only the order's items, so only its non-manual rows are deleted.
- Dock availability: `loadReceivingSources` nets out of receiving availability the allocation rows that **survive the wipe**. Part-key scope nets manual pins + work-locked rows only (every other open demand is itself a wipe participant). Order-only scope nets **every remaining allocation row** (new `netAllRemaining` flag) — all other orders' rows survive, so they must count against availability or the run would double-book dock stock. Shelf lots need nothing: `inventory_lots.allocated_qty` already nets everything.
- Dock pre-passes (PO match / perfect match, spec `2026-11-05-allocation-dock-match-ordering-design.md`) still run for the order's demands, but in order-only scope their pins are inserted as **non-manual** rows: a manual pin would leak outside the order (never wiped by other orders' actions, outranks every later recompute fleet-wide) and would break idempotent re-runs (`changed` forced true forever). Inside a single order there is no cross-order competition for the pin to outrank. Non-manual pins ride the order's own wipe/rebuild, are included in the before/after net-change keys (so an identical rebuild reads `changed = false`), and are ordinary rows for every other engine entry point — `allocateAll` may re-claim them, same as any auto allocation.
- Trade-off (accepted, documented): a single-order re-allocate rebuilds the order against stock **net of everyone else's existing rows** but does **not** rebalance unallocated demand of other orders. If an admin reorders priorities and wants the fleet to converge, the per-order button must be pressed for each affected order (or `POST /dev/allocate` in dev/test). A fresh order with no allocations yet grabs what is physically available even when a higher-priority order for the same part is still unallocated.

## API / event surface

No shape changes: same route, same 404/409 guards, same `ScopedAllocateResult`, same `allocation.computed` / `allocation.finished` SSE payloads (`scope: "picking-order"`, `pickingOrderId`).

## Tests (`src/db/allocate.test.ts`)

- Re-allocate touches only the selected order: two orders share one scarce shelf lot; after a fleet split, re-allocating the loser leaves the winner's rows identical (same ids/qtys) and the loser keeps exactly the remainder; restocking grows only the loser's share.
- A fresh single-order re-allocate takes what is available even with higher-priority demand unallocated (pins the trade-off).
- Dock double-book guard: after a part-key run split dock boxes across two orders, a single-order re-allocate nets the other order's surviving rows (no over-allocation).
- Order-only perfect-match pin is non-manual; re-running the same order is idempotent (`changed = false`, same allocation set).
- Existing `allocated`-status repair test (`pickingStatusOverride.test.ts`) keeps passing (demands no longer filter by status in order-only scope).

## Docs

`AGENTS.md` and `docs/backend/allocation.md` updated; admin picking-order page comment reworded (the UI confirm string was already order-framed).
