# Admin picking-order status override — design (2026-09-17)

Status: implemented. Route tests: `apps/backend/src/routes/admin/pickingStatusOverride.test.ts`.

## Problem

Picking orders only change status through the PDA flow (scan → picking, auto-finish,
ship) or the narrow admin issue report/resolve paths. Admins have no way to correct a
stuck or wrongly-staged order — e.g. an order that was finished upstream but never
picked, or a shipped order that came back. They need:

1. A single-order **status override** on the admin picking-order detail page.
2. A **batch override** (multi-select → set status) on the admin picking-order list page.

## Decisions

- **All 5 statuses overridable**: `pending | picking | issue | finished | shipped`
  (the `picking_orders.status` column is plain text, no DB constraint — the value set
  is convention, `apps/backend/src/db/schema/picking.ts:33`). No transition guards:
  any → any. The UI warns when the override would **reopen** a `finished`/`shipped`
  order (it re-enters allocation demand).
- **Work lock is stolen, not blocking.** Other admin mutations on live orders 409
  `lock_held`; the override instead force-clears `working_by`/`working_at`. Rationale:
  the override is the escape hatch for stuck orders — a forgotten PDA lock is exactly
  the stuck state being fixed. The PDA session gets a conflict on its next write.
- **Leaving open releases allocations.** Moving out of `pending`/`picking` deletes
  ALL the order's leftover allocation rows (including `manual` pins — a closed order
  is out of the demand set so no recompute would ever release them), writes
  RESERVE-release `inventory_transactions` rows (`txn_reason: "status override:
  release"`, same shape as the whole-box claim release), and recomputes the freed
  lots. `picking_items.allocated_qty` is zeroed. Picked (boxed) quantities are NOT
  touched — the override only changes status + reservations.
- **Stamps and issue fields follow the status.** Leaving `shipped` clears
  `shipped_at`/`shipped_by`; entering `shipped` stamps them (actor = the admin).
  Leaving `issue` clears the seven `issue_*` columns (same SET list as
  `resolvePickingOrderIssue`).
- **No-op when unchanged.** Same-status call returns `changed: false` with no audit
  row, no event, no recompute (batch loops stay cheap).
- **Audit + convergence.** One tx: status UPDATE + `transaction_logs` transition row
  (`fromState`/`toState` = old/new status, `metadata.override = true`, optional
  `reason`) + `picking_order.updated` SSE event (topics `/picking-orders`). After
  commit the route schedules `scheduleAllocateAll(db, "admin_status_override")` —
  reopening re-enters demand, closing frees stock for other orders. Batch = the
  admin client loops the route per id (same contract as `shipShippingBoxes`:
  attempts every id, aggregates per-id failures on `failed`) — no dedicated batch
  endpoint.

## API

`PATCH /admin/picking-orders/:id/status` — body `{status, reason?}` →
`{id, orderNo, status, previousStatus, changed}`. 400 `invalid_status` /
`status must be a string`; 404 `picking_order_not_found`.

## Implementation map

- `apps/backend/src/db/picking.ts` — `overridePickingOrderStatus` (+ exported
  `PICKING_ORDER_STATUSES`), next to `resolvePickingOrderIssue`.
- `apps/backend/src/routes/admin/flowEdits.ts` — the PATCH route (+ scheduling).
- `apps/admin/components/picking-orders/StatusOverrideModal.vue` — shared modal
  (target status + optional reason + reopen warning), used by both pages.
- `apps/admin/pages/picking-orders/[id].vue` — "Override status" head action.
- `apps/admin/pages/picking-orders/index.vue` — `DataTable selectable` batch
  (shipping-list pattern: clickable order-no cell instead of row-click,
  `changeBusy` guards the selection against SSE reloads).
- `apps/admin/utils/flowApi.ts` — `overridePickingOrderStatus` +
  `overridePickingOrdersStatus` (batch loop with `failed` aggregation).

## Test notes

The status change schedules the background allocateAll; its row locks can deadlock
the next reseed's TRUNCATE, so the tests wait for `getAllocationRunStatus()` to go
idle in `beforeEach` before `reseed`.
