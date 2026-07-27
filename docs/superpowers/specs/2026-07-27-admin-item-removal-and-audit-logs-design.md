# Admin audit logs, mark-issue, and receiving item removal

Date: 2026-07-27
Status: approved by user in chat
Follows: `2026-07-27-admin-issue-handling-design.md`

## Problem

1. Issue actions are recorded in `transaction_logs` (mismatch report/edit/confirm/cancel; picking `*→issue` / `issue→pending`), but no endpoint exposes them, so the admin cannot see that an order had an issue in the past.
2. Admin can only confirm/cancel mismatches reported on the PDA — it cannot mark an item as having an issue itself.
3. There is no way to remove a wrong/unwanted item from a receiving order (e.g. `not_found` / `over_shipment` mismatches).

## Backend changes (`apps/backend`)

### 1. Audit-log endpoints

- `GET /admin/receiving-orders/:id/logs` — `transaction_logs` rows where (`entity_type='receiving_order'` AND `entity_id=:id`) OR (`entity_type='receiving_invoice_item'` AND `entity_id` in the order's item ids).
- `GET /admin/picking-orders/:id/logs` — rows where (`entity_type='picking_order'` AND `entity_id=:id`) OR (`entity_type='picking_item'` AND id in the order's item ids) OR (`entity_type='picking_package'` AND id in the order's package ids) OR (`entity_type='shipping_box'` AND id in the order's box ids).
- Both in `src/routes/admin/issues.ts` (or a new `logs.ts`), domain queries in the respective `src/db/*.ts` modules. Row shape: `{id, entityType, entityId, fromState, toState, actorId, actorName, metadata, createdAt}` — `actorName` = `users.display_name` (LEFT JOIN), newest first.

### 2. `DELETE /admin/receiving-invoice-items/:id`

- Domain fn in `src/db/receiving.ts`, route in `src/routes/admin/issues.ts`.
- 404 `receiving_invoice_item_not_found`; 409 `item_work_started` when any of: `received_qty > 0`, `picked_qty > 0`, `put_away_qty > 0`, allocations reference the item, shelf_box_items reference the item (mirrors `itemWorkStarted` in `src/db/ingest.ts:281-283`).
- In one tx: delete the item row; write a `transaction_logs` row against the **order** (`entity_type='receiving_order'`, toState `item_removed`, metadata `{itemId, invoiceId, partNo, poNo, poLine, hadMismatch}`) so the audit trail survives the deletion.
- After commit: `emitEvent` `receiving_order.item_removed` (topics `["/receiving-orders"]`).
- Known behavior (same as ingest line removal): if upstream re-sends the order via `PUT /receiving-orders/:batchNo`, the item is re-created.

### 3. Tests

- Logs endpoints: rows for order + child entities, actor name joined, desc order.
- Delete: happy path (row gone, order log row written, event emitted); 409 for each guard condition; 404 unknown id.

## Admin changes (`apps/admin`)

1. `utils/flowApi.ts`: `TransactionLogRow` type + `listReceivingOrderLogs(orderId)` / `listPickingOrderLogs(orderId)`; `reportReceivingMismatch(itemId, body)` (POST mismatch); `removeReceivingItem(itemId)` (DELETE).
2. Audit-log table at the bottom of `pages/receiving/[id].vue` and `pages/picking-orders/[id].vue`: time, actor name, `fromState → toState`, compact metadata rendering (reason / qty / resolutionNote / field from→to). Reuse the existing `logStates.*` i18n keys from the shared layer where applicable.
3. Receiving detail: per-item "Mark issue" button (shown when the item has no mismatch) opening a small inline form/modal — reason dropdown (`not_found`, `damaged`, `qty_mismatch`, `wrong_part`, `over_shipment`, `quality_rejection`), qty, wrong part no, note — then `reportReceivingMismatch` + reload. Client-side validation mirrors `apps/web/utils/mismatch.ts` (wrong_part ⇒ wrongPartNo required; qty rules per reason).
4. Receiving detail: per-item "Remove" button on mismatch items, `confirm()` guard, then `removeReceivingItem` + reload.
5. i18n keys in all three locales under `admin.pages.receiving.*` / `admin.pages.*.auditLog*`.

## Docs

- `AGENTS.md` + `docs/backend/README.md` (new endpoints, `receiving_order.item_removed` event) and the receiving/picking `ai-scope.md` files.
