# Manual-Only Allocation — Design

Date: 2026-11-03
Status: implemented (PR 1; PR 2 deferred)

## Problem

`allocateAll` (fleet-wide wipe/rebuild) ran automatically in the background
after nearly every stock- or order-changing mutation — ~10 `scheduleAllocateAll`
triggers across picking, put-away, CN put-away, ad-hoc put-away, shelf exchange,
receiving scan/confirm-arrival, admin reorder / issue-resolve / status-override /
order-edit and test-order creation — plus a "Allocate all" button on the admin
picking list.

In practice allocation is a **user-confirmed step**: the admin reviews sourcing
via the per-order Re-allocate buttons and the allocate forms on receiving/picking
details. The silent fleet-wide recompute then became pure liability: it wiped
and rebuilt allocations nobody asked for (re-shuffling priorities, re-flowing
dock rows after put-away), cost multi-second transactions under load, and
surprised operators with allocation rows changing underneath open pages.

## Decision

Allocation is manual-only. Two run types remain:

1. **Scoped sync runs** (`runScopedAllocation` — rebuilt ALL open demand for the
   affected part keys in `priority_seq` order, perfect-match pre-pass included):
   - `POST /receiving-orders/:id/confirm-arrival` (`allocateForReceivingOrder`)
   - `POST /admin/picking-orders/:id/reallocate` (`allocateForPickingOrder`)
   - `POST /admin/receiving-orders/:id/reallocate`
   - `PATCH /admin/receiving-orders/:id/status` (scoped, on change)
   - `POST /admin/test-picking-order` — now awaits `allocateForPickingOrder`
     synchronously (try/catch, creation never fails on allocation) so demo/test
     orders still enter the pipeline.
2. **Dev/test fleet run**: `allocateAll` itself is kept and callable via
   `POST /dev/allocate`; it is no longer scheduled by any production route.

Removed:

- All ~10 `scheduleAllocateAll` trigger call sites (+ the two
  `reallocateBestEffort` route helpers and the adhoc/shelfExchange re-exports).
- The `allocateAll` fallbacks in confirm-arrival and receiving-status-override
  catch blocks — scoped failure now just logs; demand stays stale until the
  next Re-allocate (`allocation: null` in the confirm-arrival response).
- `POST /admin/allocation/run` + the "Allocate all" button, `flowApi.allocateAll`
  / `AllocateAllSummary` and the `allocateAll*` locale keys (en-US/zh-CN/zh-HK).

Kept as-is: the serialized allocation runner (`scheduleAllocateAll` /
`awaitAllocateAll` / `awaitAllocationTask` / `GET /allocation/status`) —
allocation-snapshot restore still serializes through it, so
`AllocationIndicator.vue` and the `allocation.started` / `allocation.finished`
SSE events keep working (`started` now only fires for restore tasks). PDA needs
no change (`allocation.computed` is still emitted by every run).

## Behavioural changes (accepted)

- Upstream-synced picking orders are **unallocated** until an admin presses
  Re-allocate — no automatic first allocation anymore.
- Put-away / shelf-exchange / ad-hoc put-away no longer re-flow dock
  allocations onto new shelf lots; pick scans are capped at the allocated qty,
  so operators of stale allocations need a Re-allocate of the affected order.
- Priority reorder and issue-resolve take effect at the next Re-allocate
  (scoped runs rebuild demand in current `priority_seq` order anyway).
- Freed stock (cancel, removal) no longer auto-tops-up partial orders.

## PR 2 (deferred)

Delete `allocateAll` and migrate the ~17 test files that use it directly
(~40 call sites, fixtures + multi-order contention tests), if ops does not miss
the fleet-wide escape hatch after a burn-in period.
