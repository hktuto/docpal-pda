# Scoped allocation on confirm-arrival + global allocation status — design

Date: 2026-09-10. Status: implemented.

## Problem

Confirming a receiving order in_hand triggered a full background
`allocateAll`. Users got no feedback: the mutation returned before the
recompute finished, the run could take a long time, and nothing on screen
said whether allocation was still running — navigating away and back lost
even the local indicator. Separately, the only completion signal
(`allocation.computed`) is change-gated, so an idempotent recompute is
invisible.

## Decisions

1. **Scoped synchronous recompute on confirm-arrival.** Confirm-arrival only
   makes one order's stock allocatable, and allocation sources/demands are
   per-part (a lot, receiving item, and picking item each carry one part
   number; parts never compete for stock). So the only allocations that can
   change are those for the confirmed order's part keys (`part_no` ∪
   `wcl_item_no` of its invoice items). `allocateForReceivingOrder(db,
   receivingOrderId)` runs the same wipe/rebuild rules as `allocateAll`
   restricted via `loadDemands(tx, partKeys)` and returns
   `{...AllocateSummary, partKeys, changed, durationMs}`. Small enough to
   await in `POST /receiving-orders/:id/confirm-arrival`, whose response now
   carries `allocation` — the UI just reloads with final data.
   - Fallback: if the scoped run throws, the route schedules a background
     `allocateAll` and returns `allocation: null`; the UI waits for
     `allocation.finished` over SSE instead.
   - `allocateAll` was deliberately NOT refactored; the scoped core mirrors
     it (keep them in sync when rules change). Full background recompute
     remains for cross-part changes: order create/cancel, priority reorder,
     picks, sync batches, dev reset.
   - Known limit: an order with very many distinct parts approaches the full
     run's cost. Measured via `durationMs` in the response; revisit with a
     size threshold fallback if real orders get there.

2. **Global runner status for background runs.** `scheduleAllocateAll`
   records `{running, queued, trigger, startedAt, lastRun{...summary,
   finishedAt, durationMs, trigger}}` (in-memory), exposed at
   `GET /allocation/status`, and emits `allocation.started` over SSE before
   each run. UIs fetch the status once on load (catches runs already in
   flight) then follow `allocation.started` / `allocation.finished`. A
   `finished` handler must re-fetch the status rather than assume idle — a
   scoped run's `finished` can arrive while a background run is still going.

3. **Events.** `allocation.finished` fires on every run (scoped and full)
   with `{...summary, changed}` (+ `scope`/`receivingOrderId` for scoped
   runs). `allocation.computed` stays change-gated for cache invalidation.

## Admin UI

- Receiving detail: confirm-in-hand awaits the response; shows
  "finished in N ms" when `allocation` is present, else the running banner +
  SSE wait (fallback path).
- `AllocationIndicator` chip in the sidebar (app.vue): visible while the
  background runner is active, from status fetch + SSE.
- `useAdminEvents`: lazy singleton EventSource on `/events?token=`; per-type
  listeners; backlog replay dropped (listener subscribe time − 15 s skew).

## Testing

`src/db/allocate.test.ts` — scoped run allocates the confirmed order's part
from the receiving line, leaves unrelated demands untouched, and is
idempotent (`changed: false` on re-run). The `scheduleAllocateAll` test now
waits for run 1 asynchronously (the runner awaits the `started` event first).
