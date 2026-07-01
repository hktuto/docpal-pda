# Web Demo Seed and Allocation Design

## Goal

Update the `apps/web-demo` warehouse demo so it better reflects a real receiving/picking flow:

1. Receiving order list defaults to **In hand**.
2. Seed data is richer: multiple suppliers, more items, future deliveries, existing shelf stock, and receiving orders split across several picking orders.
3. Receiving-area stock is represented by `receiving_invoice_items` until the worker physically handles it. Lot code, date code, and exact box breakdown are discovered during picking or put-away.
4. Allocation uses date code as a FIFO sort key, with optional comparison rules on picking lines.

## 1. Default receiving list filter

Change `apps/web-demo/pages/receiving/index.vue` so the initial filter is `in_hand` instead of `pending`.

## 2. Data model changes

### `allocations`

- Make `inventory_lot_id` nullable.
- Add `receiving_invoice_item_id` nullable, referencing `receiving_invoice_items(id)`.
- Each row must reference at least one of the two (enforced in application code).

### `receiving_invoice_items`

- `date_code`, `lot_code`, `origin_country` remain nullable: unknown at receipt time.
- The existing `box_id` column is nullable and currently unused; keep it as-is.
- Add `picked_qty INTEGER NOT NULL DEFAULT 0`.
- Add `put_away_qty INTEGER NOT NULL DEFAULT 0`.
- `received_qty` is the actual quantity confirmed at arrival.
- Quantity still in the receiving area:
  ```
  received_qty - picked_qty - put_away_qty - allocated_to_other_orders
  ```
  where `allocated_to_other_orders` is `SUM(allocations.qty)` for this invoice item.

### `picking_items`

- Add `allocated_qty INTEGER NOT NULL DEFAULT 0`.
- `required_date_code` can now contain a comparison operator:
  - `2406` — exact match
  - `>=2406`, `>2406`, `<=2405`, `<2405` — comparison match
- Unallocated/unpicked need:
  ```
  needed = qty - picked_qty - allocated_qty
  ```

### `picking_orders`

- Add `ship_to TEXT` (nullable) to represent the destination of the shipment.

### `inventory_lots` unique index

The unique index on `inventory_lots` is relaxed so it only enforces uniqueness for **located** lots (`shelf_code IS NOT NULL OR box_id IS NOT NULL`). Receiving-area lots (`shelf_code IS NULL AND box_id IS NULL`) can be created per materialized allocation, because each pick/put-away action materializes a dedicated lot row with its own source link.

### No new tables

## 3. Allocation behavior

For each picking item:

1. Parse the date-code rule from `required_date_code`.
2. **Phase 1 — shelved / shelf-box stock**  
   Match `inventory_lots` by `part_id` + date-code rule, where `shelf_code` or `box_id` is set.  
   Order by `date_code ASC` (FIFO), nulls last.
3. **Phase 2 — receiving-area stock**  
   Match in-hand `receiving_invoice_items` by `part_id` + date-code rule.  
   Order by `receiving_orders.delivery_date ASC`, then `date_code ASC`, nulls last.
4. Create allocation rows and update:
   - `inventory_lots.allocated_qty += take` for shelved lots.
   - Insert into `allocations` with `receiving_invoice_item_id` for receiving-area stock.
   - `picking_items.allocated_qty += take`.

When a receiving order is confirmed `in_hand`, the system sets `received_qty` and calls `allocatePendingPickingOrders`, but it **does not** create `inventory_lots`.

### Date-code comparison rule

- Parse `required_date_code` with a regex such as `^(>=|<=|>|<)?(.*)$`.
- Compare the remaining string against `inventory_lots.date_code` or `receiving_invoice_items.date_code` lexicographically.
- A null date code on a receiving invoice item matches any rule (wildcard) but is sorted after known date codes so older known stock is consumed first.

## 4. Handling goods discovered in the receiving area

### Picking from a receiving-area allocation

The worker enters the real `date_code`, `lot_code`, `origin_country`, and qty. The qty may be the full allocated amount or a partial amount.

1. Create a new `inventory_lots` row in the receiving area with those details, `total_qty = picked_qty`, `allocated_qty = picked_qty`.
2. If the pick is partial, split the original allocation:
   - Keep one allocation row pointing to the invoice item for the remaining qty.
   - Update the other allocation row to point to the new lot for the picked qty.
3. Confirm the pick on the new lot:
   - Reduce the lot's `total_qty` and `allocated_qty`.
   - Increment `picking_items.picked_qty`.
   - Decrement `picking_items.allocated_qty`.
   - Increment `receiving_invoice_items.picked_qty` by the picked qty.

This also fixes the current demo behavior where confirming a pick does not reduce the inventory lot.

### Put-away from a receiving-area allocation

Put-away only moves **unallocated** receiving-area quantity. If a quantity is already allocated to a picking order, the worker should pick it first, not put it away.

For the unallocated quantity, the worker enters `date_code`, `lot_code`, `origin_country`, qty, and target shelf.

1. Create the shelf-box `inventory_lots` row directly (`shelf_code` + `box_id`).
2. Insert the `shelf_box_items` row.
3. Increment `receiving_invoice_items.put_away_qty` by the moved qty.

## 5. Seed data plan

### Suppliers

| Code | Name | Behavior |
|------|------|----------|
| ALP | Alpha Electronics | Japan parts; combines items on invoices; sometimes mixed date codes |
| BET | Beta Semiconductor | Malaysia; one item per invoice |
| GAM | Gamma Precision | Germany; sensors; future shipment |
| DEL | Delta Components | China; large MCU shipment; unknown packing |
| EPS | Epsilon Connectors | Taiwan; connectors; some already on shelf |

### Parts (sample)

| Part no | Description | Default origin |
|---------|-------------|----------------|
| RES-0603-10K | Resistor 10K 0603 | JP |
| CAP-0805-100N | Cap 100nF 0805 | JP |
| IC-LM358DR | Op-amp | MY |
| MOS-IRLML6244 | MOSFET | MY |
| MCU-STM32F103 | MCU | CN |
| SNS-BMP280 | Pressure sensor | DE |
| CON-PH2.0-4P | 4-pin connector | TW |

### Receiving orders

| Ref | Supplier | Status | Delivery | Notes |
|-----|----------|--------|----------|-------|
| RO-240701-001 | ALP | in_hand | today | 2 invoices; one line has mixed/unknown date code |
| RO-240701-002 | BET | in_hand | today | 3 invoices, one item each |
| RO-240705-001 | GAM | pending | +4 days | sensors |
| RO-240710-001 | DEL | pending | +9 days | 80k MCU, unknown date/boxes |
| RO-240615-001 | EPS | in_hand | -15 days | connectors |

### One item split across multiple picking orders

- **Receiving order** `RO-240701-001` from ALP includes `RES-0603-10K`, qty **40,000**.
- Three picking orders consume it:
  - `TN-240701-002` → `ZH`, `RES-0603-10K` 20,000
  - `TN-240701-003` → `SH`, `RES-0603-10K` 1,200
  - `TN-240701-004` → `BJ`, `RES-0603-10K` 800

### Existing shelf stock

A few inventory lots on shelves with older date codes so Workflow B (picking order arrives first) has stock to allocate.

### Picking orders

A mix of exact and comparison date-code rules, with some satisfied from shelf stock and some from new arrivals.

## 6. UI / query updates

- **Receiving list** — default to *In hand*; remaining qty comes from `received_qty - picked_qty - put_away_qty - allocated`.
- **Receiving detail** — Receiving view shows each invoice line with received / allocated / picked / put away / available; Picking view includes allocations against invoice items.
- **Put-away** — candidate list and detail use invoice-item availability instead of `inventory_lots`.
- **Picking detail** — allocations against invoice items show the source receiving order and a pick action that prompts for discovered date/lot/origin.
- **Picking by receiving** — query unions allocations against both `inventory_lots` and `receiving_invoice_items`.
- **Measuring** — shipping boxes already record destination, but picking list/detail now also show `ship_to`.

## 7. Migration

PGlite bootstraps the schema once from `db/init.ts` when the `users` table does not exist. Because the schema changes, the IndexedDB database must be cleared. The app will re-initialize with the new schema and seed on the next load. The existing **Reset local DB** menu handles this.

## Notes and limitations

- This is still a demo; no camera/barcode integration, no backend API, no real migrations.
- Allocation is greedy and FIFO by date code. It does not yet implement full lot-priority rules beyond the date-code comparison.
- Unknown date codes are allowed to match any rule but are consumed after known date codes.
