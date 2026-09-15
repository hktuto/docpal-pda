# Admin picking-item actions: remove allocation + availability search — design

Date: 2026-09-15
Status: implemented

## Goal

Two inline actions on the items table of the admin picking-order detail page
(`apps/admin/pages/picking-orders/[id].vue`):

1. **Remove allocation** — an (x) icon next to each allocation row of an
   item, deleting that specific allocation and releasing its reserved stock
   back to available.
2. **Search availability** — a search icon on the item's part-no cell,
   opening a modal showing every stock lot and every receiving order
   containing the part, across **all** org/sub-inventory locations.

Both are operator recovery/diagnostic tools next to the order-level
Re-allocate button (spec `2026-09-14-admin-allocation-buttons-design.md`).

## Decisions

- **Per-allocation removal, inline.** No actions column: each allocation
  line in the Allocations cell gets its own (x); the part-no cell carries
  the availability search icon.
- **No order-status check.** Both actions work on orders in any status —
  admins may fix allocations on finished/issue orders too. The PDA
  work-lock guard (`409 lock_held`) is kept: a PDA with the order open
  scans against these allocation rows, so removing them mid-session is
  blocked with the holder's name.
- **Transient removal (no exclusion flag).** After removal, the next
  `allocateAll` / scoped recompute may re-allocate the item — accepted
  deliberately; the use case is freeing a specific reservation right now
  (e.g. to let a higher-priority order take it via a manual re-allocate),
  not permanently excluding the item. No schema change.
- **Modal, not navigation.** The availability result is shown in a dialog on
  the detail page instead of routing to `/stock-search`, because that page
  does not filter/show receiving orders and the operator wants to stay on
  the order.
- **All locations, no org filter.** The search is intentionally not scoped
  to the order's `orgId`/`subInventoryCode` — seeing stock in other
  locations is the point (it answers "do we have this part anywhere?").
  Rows matching the order's pair are highlighted in the modal.

## Manual (pinned) allocation from the modal

Each stock/receiving row in the availability modal has a qty input +
**Allocate** button that pins a hand-made allocation for the item against
that source — in ANY location (deliberate admin override of the engine's
location pairing).

- **Pinned, not transient.** The row is inserted with
  `allocations.manual = true` (new column, migration 0009). Both wipe/rebuild
  cores (`allocateAll`, `runScopedAllocation`) skip manual rows in the wipe
  (no delete, no RESERVE-release, excluded from the net-change keys) and
  pre-subtract their qty from the item's open demand before auto-allocating
  the rest. `loadReceivingSources` nets manual rows out of dock availability
  (the `locked_*` subqueries now cover `a.manual OR work-locked`); lot
  sources get it for free via `inventory_lots.allocated_qty`
  (`recomputeLot` counts manual rows).
- **Validation** (`addManualPickingAllocation`): 400 `invalid_qty`
  (non-positive/non-integer) / `source_required` (exactly one of
  `inventoryLotId` / `receivingInvoiceItemId`); 404
  `inventory_lot_not_found` / `receiving_invoice_item_not_found`; 409
  `insufficient_available` (qty > source's available), 409
  `over_allocation` (Σ allocations + qty > item open qty = qty − Σ
  packages — "total allocated must not exceed the total"), 409 `lock_held`.
  No order-status check, same as remove. RESERVE ledger row
  (`admin: manual allocation`), audit log (`action: "manual_allocation"`),
  `allocation.computed` event. There is deliberately no part-match check —
  the manual pin is an admin override.
- **Modal UX:** the header shows the remaining open demand
  (`qty − picked − Σ allocations − allocated-this-session`); each row's
  input defaults to `min(source available, remaining)` and is hard-capped
  by both; the available column and caps update locally after each
  Allocate; the items table behind the modal reloads.
- Route: `POST /admin/picking-orders/:id/items/:itemId/allocations` →
  `{allocationId, qty}`.
- Manual rows are removed with the same (x) remove action
  (`removePickingAllocation` is flag-agnostic).

## Receiving order detail: reverse direction

The receiving order detail page (`apps/admin/pages/receiving/[id].vue`) gets
the mirror-image actions per item row:

- **Search** — the same 🔍 availability modal, extracted as
  `apps/admin/components/PartAvailabilityModal.vue` (read-only without a
  picking-item target; with one it renders the Allocate columns — the
  picking detail page now uses the shared component).
- **Allocations + (x)** — `GET /receiving-orders/:id` now embeds per-item
  `allocations: [{id, qty, manual, pickingItemId, pickingOrderId, orderNo,
  orderStatus}]` (allocation rows sourced from that receiving line); the
  allocatedQty cell lists them as `{qty} × {orderNo}` with a manual badge
  and an (x) that calls the same DELETE endpoint.
- **Allocate** — a per-row button opens a demand modal over
  `GET /admin/part-demand?partNo=&wclItemNo=` (open pending/picking picking
  items with `remainingQty > 0`), qty input + Allocate per row, pinning
  `addManualPickingAllocation(pickingOrderId, pickingItemId, {qty,
  receivingInvoiceItemId: <the receiving item>})`. Cap = `min(remainingQty,
  receivedQty − pickedQty − allocatedQty − session-allocated)`; header shows
  the item's remaining allocatable qty.

## Backend

### `src/db/allocate.ts` — `removePickingAllocation(db, pickingOrderId, pickingItemId, allocationId, actorId)`

Guards run before the transaction:

- 404 `picking_order_not_found`; 409 `lock_held` JSON
  `{error, holderId, holderName}` on a live PDA work lock (no status check).
- 404 `picking_item_not_found` when the item is missing or belongs to a
  different order.

In one transaction:

1. Read the single allocation row (same SELECT shape as the wipe block in
   `runScopedAllocation`, `WHERE a.id = :allocationId AND a.picking_item_id
   = :itemId`); 404 `allocation_not_found` when absent.
2. `DELETE FROM allocations WHERE id = :allocationId`.
3. Recompute denormalized counters via the now-exported helpers from
   `src/db/picking.ts`: `recomputeLot` for the row's `inventoryLotId` when
   lot-sourced (`allocated_qty = Σ allocations`) and
   `recomputePickingItem` for the item.
4. One RESERVE-release `inventory_transactions` ledger row with
   `txnReason: "admin: remove allocation"`.
5. `refreshAllocationStatus(tx)` recomputes open orders'
   `allocation_status` (finished orders are untouched by it).
6. `transaction_logs` audit row (`entityType picking_order`, metadata
   `{action: "remove_allocation", allocationId, itemId, partNo, qty}`) so
   the detail page's audit table shows the action.
7. `allocation.computed` SSE event (`scope: "picking-order-item"`) so open
   UIs converge.

Packages are unaffected: picked quantities already reduced stock and their
allocations are consumed at pick time, so only reserved (unpicked) rows can
be present for removal.

### Routes

| Endpoint | Description |
|---|---|
| `DELETE /admin/picking-orders/:id/items/:itemId/allocations/:allocationId` (in `src/routes/admin/allocation.ts`) | Awaits `removePickingAllocation`; 200 → `{removed: 1, qty}`; guards as above. |
| `GET /admin/part-availability?partNo=&wclItemNo=` (new `src/routes/admin/partAvailability.ts`) | Exact `part_no`/`wcl_item_no` match (`wclItemNo` optional; 400 `part_no_required` when `partNo` empty), **no** org filter. → `{stock: [...inventory_lots rows: lotId, orgId, subInventoryCode, shelfCode, boxId, partNo, wclItemNo, dateCode, lotCode, totalQty, allocatedQty, availableQty], receiving: [...receiving_invoice_items joined to invoices/orders: receivingOrderId, batchNo, supplierCode, status, invoiceNo, receivingInvoiceItemId, lineQty, receivedQty, putAwayQty, pickedQty, orgId, subInventoryCode, ctnNo, dateCode]}`. Receiving rows include all order statuses. |

## Admin UI

- `utils/flowApi.ts`: `PartAvailability*` types;
  `removePickingAllocation(orderId, itemId, allocationId)`;
  `getPartAvailability(partNo, wclItemNo?)`.
- `pages/picking-orders/[id].vue` (no actions column — the actions live
  inside the existing cells):
  - **Part-no cell** — a 🔍 icon button opens the availability modal, which
    re-fetches `GET /admin/part-availability` for the row's
    `wclItemNo ?? partNo` on every open. Header shows the part + the order's
    org/sub-inventory as context; stock and receiving tables highlight rows
    matching that pair.
  - **Allocations cell** — each allocation line gets an (x) icon button
    (busy state per allocation id): confirm dialog, DELETE, reload +
    audit-log refresh; `lock_held` error parsed like the Re-allocate
    button. No status gating.
- i18n keys under `admin.pages.pickingOrders` in all three locales.

## Tests

`src/routes/admin/allocation.test.ts` (extended): remove-allocation happy
path (one row deleted, lot/item `allocated_qty` reduced by that row's qty,
order `allocation_status` recomputed, audit row written), per-allocation
lot release (other orders' reservations on the same lot remain), 404
unknown order/item/allocation, succeeds on a finished order (no status
check), 409 `lock_held`; part-availability happy path, unknown part →
empty arrays, missing `partNo` → 400.
