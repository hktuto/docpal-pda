# Allocate Picking at Receiving-Order Level

## Problem

The demo receiving order `04958166` contains multiple invoice lines for the same part (e.g. `RK73H1ETTP1000F`). Current `allocations` link a picking item directly to one `receiving_invoice_item_id`. When a picker scans a physical box, the scan only identifies part + quantity; it cannot reliably guess which invoice line the box came from. This causes `quantity_exceeds_unallocated_picking_need` because the matcher picks a receiving item that is not allocated to the active picking order.

## Goal

Change allocations so they reserve quantity at the **receiving-order + part** level instead of the **invoice-item** level. At scan time, the system selects available invoice items within the receiving order and deducts quantity from them, consuming multiple invoice items if necessary.

## High-level design

1. **Schema:** Replace `allocations.receiving_invoice_item_id` with `allocations.receiving_order_id`.
2. **Picking candidate lookup:** Find picking items that have allocations tied to the current receiving order.
3. **Scan application (`applyOcrPick`):**
   - Picking item is identified by picking order + part.
   - Existing allocations to the receiving order are consumed first.
   - Any remaining quantity is matched against unallocated picking demand.
   - At scan time, select `receiving_invoice_item` rows in the receiving order for the same part, ordered by invoice date then invoice number (FIFO), and split the scan quantity across them.
   - Create packages / inventory lot sources against those concrete receiving items.
4. **Receiving allocated qty:** Re-calculate allocated quantity per receiving item by joining allocations → picking items → receiving order → invoices → invoice items, grouped by part.
5. **Seed data:** Regenerate allocations at receiving-order level.
6. **Tests:** Update all tests that create allocations directly and add a regression test for split-across-invoice consumption.

## Detailed design

### Schema changes

- In `allocations`:
  - Remove `receiving_invoice_item_id`.
  - Add `receiving_order_id text references receiving_orders(id) on delete cascade`.
- Update Drizzle relations:
  - `allocationsRelations` relates to `receivingOrders` instead of `receivingInvoiceItems`.
  - `receivingInvoiceItemsRelations` removes `allocations: many(allocations)`.
  - `receivingOrdersRelations` adds `allocations: many(allocations)`.
- Update `db/init.ts` raw SQL:
  - Replace `receiving_invoice_item_id` column with `receiving_order_id`.
  - Replace index `idx_allocations_receiving_item` with `idx_allocations_receiving_order ON allocations(receiving_order_id)`.

### Picking candidate lookup

`findPickingCandidates` / `findPickingCandidatesForOrder` currently use an EXISTS subquery that joins `allocations → receiving_invoice_items → receiving_invoices`. Replace it with a direct join `allocations → receiving_orders` via `receivingOrderId`.

### Scan application

`applyOcrPick` signature changes from `receivingInvoiceItemId: string` to `receivingOrderId: string`.

Algorithm inside the transaction:

1. Validate the picking item exists and the receiving order contains the same part with enough total available quantity.
2. Compute `remainingScan = qty`.
3. Consume existing receiving-order allocations for this `pickingItemId` + `receivingOrderId` first, reducing `remainingScan`.
4. If `remainingScan` still exceeds unallocated picking demand, throw `quantity_exceeds_unallocated_picking_need`.
5. If `remainingScan > 0` after existing allocations, insert a new allocation with `receivingOrderId` for `remainingScan` and bump `pickingItems.allocatedQty`.
6. Determine concrete invoice items to consume:
   - Query invoice items for the part in the receiving order.
   - Order by receiving invoice date ascending, then invoice number ascending, with `NULL` dates sorted last.
   - For each item, compute available qty (`received_qty - picked_qty - put_away_qty - allocated_qty - unboxed_scanned_qty`).
   - Consume items in order until the original `qty` is satisfied, possibly spanning multiple invoice items.
7. For each consumed portion, call `materializeReceivingAllocation` with the explicit invoice item and portion quantity, then `scanAllocationToPackage` to create the package.

`materializeReceivingAllocation` must be updated to accept an explicit `receivingInvoiceItemId` parameter because the allocation itself no longer stores it.

### Receiving allocated qty

- `db/helpers.ts`: `allocationsCte` and `availableReceivingQtySql` no longer aggregate by `receiving_invoice_item_id` directly. Instead, allocated qty per receiving item is the sum of allocation quantities where:
  - `allocation.receiving_order_id` matches the receiving order of the item, and
  - the allocation's picking item is for the same `part_id`.
- `db/receiving.ts`: `tryMarkReceivingOrderClear` / `tryMarkReceivingOrderInHand` use the same part-based allocation aggregation.
- `services/adapters/pgliteWarehouse.ts`: `getReceivingOrders` and `getReceivingOrder` allocation joins are updated to use `receiving_order_id` and match by part.

### Boxing / unboxing / cancellation

`removeScannedPackage` reverses a scan by looking at the package / inventory lot source to identify the concrete receiving item, not the allocation. Since allocations are now coarse-grained, restoring qty goes back to the receiving-order allocation (or creates one if missing).

### Seed data

- `scripts/generate-wcl-seed.mjs` emits allocations with `receivingOrderId` instead of `receivingInvoiceItemId`.
- Allocation generation groups picking-item demand by receiving order + part and emits one allocation per receiving order.
- Run the script and copy the allocation section into:
  - `scripts/picking-seed-output.ts`
  - `db/seed-precalc.ts`
  - `db/seed.ts`

### Service and matcher layer

- `services/types.ts`: `PickingAllocation` no longer exposes `receivingInvoiceItem`; expose `receivingOrder` instead where applicable. `ApplyOcrPickInput` changes `receivingInvoiceItemId` to `receivingOrderId`.
- `services/warehouse.ts`: `applyOcrPick` input uses `receivingOrderId`.
- `services/adapters/pgliteWarehouse.ts`: Pass `receivingOrderId` to `dbApplyOcrPick`.
- `services/adapters/apiWarehouse.ts`: Update stub signatures.
- `composables/useScanMatchers.ts`:
  - `matchPicking` allocation now has `receivingOrderId` instead of `receivingInvoiceItem`.
  - Receiving candidate selection in picking context passes the receiving order id, not a specific invoice item id, to the warehouse adapter.

### Tests

- Update allocation setup in `tests/picking.test.ts`, `tests/putAway.test.ts`, `tests/goodsVerify.test.ts`, `tests/mismatch.test.ts`, `tests/scanMatchers.test.ts`, `tests/seed-precalc.test.ts`.
- Add regression test:
  - Receiving order with two invoice items for the same part (e.g. 10k and 190k).
  - Picking order allocated to that receiving order for 200k.
  - Scan 20k.
  - Verify scan succeeds, deducting 10k from the first invoice item and 10k from the second.

## Risks and notes

- **IndexedDB reset required:** Because `db/init.ts` changed and there are no migrations, existing browser IndexedDB must be cleared. Same for any test database files.
- **Regeneration dependency:** `db/seed-precalc.ts` and `db/seed.ts` are generated partly from `scripts/picking-seed-output.ts`. Ensure all three are updated consistently.
- **Inventory lot sources remain at invoice-item level:** Allocations are coarse (receiving order), but actual consumption records (packages, lot sources) still reference the concrete invoice items selected at scan time.
- **FIFO ordering:** Invoice date ascending, then invoice number ascending. Items with null invoice dates are sorted last.
