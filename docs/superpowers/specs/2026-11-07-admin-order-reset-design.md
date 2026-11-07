# Admin order reset (2026-11-07)

CR-050. Adds a **Reset order** button on the admin **picking order detail** and **CN receiving order detail** pages that returns an order to its initial state so users can re-test the flow. UAT record: `docs/uat/features/CR-050.json`.

## Problem

During UAT, testers need to re-run the picking and CN receiving flows on the same order. The existing status override only flips the status — packages, boxes, verify tasks and CN scan state stay behind, so the order is not really re-testable without re-seeding.

## Decision

Two new admin endpoints, each one all-or-nothing transaction. Reset **removes all picked/boxed (or scanned/received) progress but KEEPS allocations** — the operator re-picks against the same reservations instead of waiting for a recompute.

### `POST /admin/picking-orders/:id/reset`

`resetPickingOrderProgress` (`apps/backend/src/db/picking.ts`), thin route in `apps/backend/src/routes/admin/flowEdits.ts` (next to the status override).

- 404 `picking_order_not_found`; 409 `picking_order_shipped` — a shipped order's stock is gone, nothing to restore.
- Every `picking_packages` row of the order is reversed exactly like `removeScannedPackage` — the per-package reversal core is extracted into the shared `reverseScannedPackageTx` (source restore: `inventory_lots.total_qty` / `receiving_invoice_items.picked_qty`; allocation restored via `bumpAllocation`; reverse PICK ledger rows with `txn_reason = 'admin order reset'`; package deleted; item recomputed) — but **without** the boxed/verified 409 guards (reset must clear boxed and verified packages too).
- Packages of **other** orders packed into this order's boxes (cross-order packing) are unboxed first so their order keeps them; then `shipping_box_items` and `shipping_boxes` of the order are deleted (`verify_tasks` and `shipping_box_items` also cascade).
- `picking_items`: `picked_qty = 0`, `status = 'pending'`; `allocated_qty` untouched (the per-package bump already restored the rows).
- The order goes to `pending` with the work lock (`working_by/at`), the labeling / label-printing stage flags **and** their done stamps, the shipped stamps, and all issue columns cleared. Allocation columns/rows are NOT touched.
- Audit `logTransition` (`picking_order`, metadata `{reset: true, packagesRemoved, boxesRemoved}`) + SSE `picking_order.updated` on `/picking-orders`.

### `POST /admin/receiving-cn/orders/:batchNo/reset`

`resetCnOrder` (`apps/backend/src/db/receivingCn.ts`), route behind the `cnReceiving()` 404 guard in `apps/backend/src/routes/admin/receivingCn.ts`.

- 404 `receiving_cn_order_not_found`; 409 `order_already_clear` — a `clear` order's stock is already in `inventory_lots`, out of scope for a reset.
- All `receiving_invoice_items_cn` of the order's invoices: scan columns cleared back to unresolved (same shape as `resetCnItemScan`) and `received_qty` / `picked_qty` / `put_away_qty` zeroed.
- `receiving_cn_scan_events` of the order deleted; the order's `put_away_tasks_cn` row deleted (it can only be `pending` — `clear` is guarded).
- Order → `pending`, `arrived_at`/`arrived_by` cleared.
- Audit row (`receiving_order_cn`, `{reset: true}`) + SSE `receiving_cn.updated` on `/admin/receiving-cn`, `/receiving-cn-scan-tasks`, `/put-away-tasks`.

### Admin UI

- `apps/admin/pages/picking-orders/[id].vue`: **Reset order** button in `.head-actions` (hidden once `shipped`), `window.confirm` → `flow.resetPickingOrder(id)` → reload + logs refresh. i18n keys `admin.pages.pickingOrders.resetOrder` / `resetOrderConfirm`.
- `apps/admin/pages/receiving-cn/[batchNo].vue`: same, hidden when `clear`, calling `flow.resetCnOrder(batchNo)`; keys under `admin.pages.receivingCn` (+ done/failed banners).
- Wrappers `resetPickingOrder` / `resetCnOrder` in `apps/admin/utils/flowApi.ts`.

## Rejected alternatives

- **Reuse the status override to pending.** It leaves packages/boxes/scan state behind — the whole point of reset is to clear them.
- **Release allocations too.** Re-testing the flow is faster when the reservations survive; an admin who wants them gone can use the status override (leaving the holding statuses releases them) or Re-allocate.
- **Resetting shipped / clear orders.** Stock has physically left (or been put away) — restoring it would corrupt inventory. Hard 409 instead.
