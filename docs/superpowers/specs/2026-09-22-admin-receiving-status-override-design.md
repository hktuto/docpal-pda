# Admin receiving-order status override — design (2026-09-22)

Status: implemented. Route tests: `apps/backend/src/routes/admin/receivingStatusOverride.test.ts`.

## Problem

Receiving orders only change status through the PDA flow (scan →
`provisional_received`, confirm arrival → `in_hand`, put-away completion →
`clear`). Admins have no way to correct a stuck or wrongly-staged order — e.g.
an order confirmed by mistake, or a cleared order that needs to re-enter the
dock supply. They need:

1. A single-order **status override** on the admin receiving-order detail page.
2. A **batch override** (multi-select → set status) on the admin receiving-order
   list page.

## Decisions

- **All 4 statuses overridable**: `pending | provisional_received | in_hand |
  clear` (the `receiving_orders.status` column is plain text, no DB constraint).
  No transition guards: any → any. The UI warns when the override would
  **reopen** a `clear` order (it re-enters allocation supply) or move an
  `in_hand`/`clear` order **backward** below `in_hand`.
- **Status stamp only.** Unlike the picking override (which releases
  allocations), the receiving override touches NOTHING but the order row:
  `received_qty` on items, `RECEIVE_TO_DOCK` ledger rows, allocations sourcing
  the order, and put-away tasks are all left as-is — the admin fixes those
  separately if needed. Rationale: reverting receipt data is unsafe (stock may
  already be on shelves or picked); the override is a staging correction tool.
- **Arrival stamps follow the status.** Entering `in_hand` stamps
  `arrived_at`/`arrived_by` (actor = the admin); moving backward to
  `pending`/`provisional_received` clears them; everything else (including
  `in_hand → clear`, matching the normal put-away path) leaves them unchanged.
- **No-op when unchanged.** Same-status call returns `changed: false` with no
  audit row, no event, no recompute (batch loops stay cheap).
- **Audit + convergence.** One tx: status UPDATE + `transaction_logs`
  transition row (`entityType: "receiving_order"`, `fromState`/`toState` =
  old/new status, `metadata.override = true`, optional `reason`) +
  `receiving_order.upserted` SSE event (topics `/receiving-orders` — the type
  the admin list/detail already subscribe to). After commit the route schedules
  `scheduleAllocateAll(db, "admin_status_override")` — entering/leaving
  `in_hand` changes dock supply, `clear` excludes the order as an allocation
  source. The `receiving_orders.update` sync-feed row is produced by the
  generic table trigger, so upstream sees the change automatically. Batch = the
  admin client loops the route per id (same contract as
  `overridePickingOrdersStatus`: attempts every id, aggregates per-id failures
  on `failed`) — no dedicated batch endpoint.

## API

`PATCH /admin/receiving-orders/:id/status` — body `{status, reason?}` →
`{id, batchNo, status, previousStatus, changed}`. 400 `invalid_status` /
`status must be a string`; 404 `receiving_order_not_found`.

## Implementation map

- `apps/backend/src/db/receiving.ts` — `overrideReceivingOrderStatus`
  (+ exported `RECEIVING_ORDER_STATUSES`).
- `apps/backend/src/routes/admin/flowEdits.ts` — the PATCH route (+ scheduling).
- `apps/admin/components/receiving/StatusOverrideModal.vue` — shared modal
  (target status + optional reason + reopen/backward warnings), used by both
  pages.
- `apps/admin/pages/receiving/[id].vue` — "Override status" head action.
- `apps/admin/pages/receiving/index.vue` — `DataTable selectable` batch
  (picking-list pattern: clickable batch-no cell instead of row-click,
  `changeBusy` guards the selection against SSE reloads).
- `apps/admin/utils/flowApi.ts` — `overrideReceivingOrderStatus` +
  `overrideReceivingOrdersStatus` (batch loop with `failed` aggregation).

## Test notes

The status change schedules the background allocateAll; its row locks can
deadlock the next reseed's TRUNCATE, so the tests wait for
`getAllocationRunStatus()` to go idle in `beforeEach` before `reseed` (same as
the picking override tests).
