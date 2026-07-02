# Package-Level Picking Design

## Problem
The previous picking flow conflated "taking stock from a location" with "finishing a picking item". A single button increased `picked_qty` and consumed stock in one step, with no way to model physical packages or the pack-out step into shipping boxes.

## New flow
1. **Scan** — operator scans a physical package from receiving or a shelf. The system consumes source stock and creates a `picking_packages` row with `shipping_box_id = NULL`.
2. **Create box** — operator creates a shipping box inside the picking order. The system auto-generates `BOX-HK1-WWYY######`.
3. **Add to box** — operator assigns scanned packages to a box. The system sets `picking_packages.shipping_box_id` and recalculates `picking_items.picked_qty`.
4. **Finish item** — when the sum of boxed package quantities reaches the required quantity, the picking item is finished.
5. **Finish order** — when all items are finished, the operator finishes the order and a measuring task is created.
6. **Measure** — operator records box weights/dimensions and closes boxes, then completes the measuring task.

## Data model

### `picking_packages`
| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | package UUID |
| `picking_item_id` | text FK | the line this package belongs to |
| `picking_order_id` | text FK | denormalised for convenience |
| `source_type` | text | `receiving_invoice_item` or `inventory_lot` |
| `source_id` | text | source record id |
| `qty` | integer | package quantity |
| `shipping_box_id` | text FK nullable | NULL = scanned but not boxed |
| `date_code` | text | captured at scan |
| `lot_code` | text | captured at scan |
| `origin_country` | text | captured at scan |
| `created_at` | timestamp | scan time |

### Re-interpreted fields
- `picking_items.picked_qty` = sum of `picking_packages.qty where shipping_box_id IS NOT NULL`.
- `picking_items.allocated_qty` = reserved-but-not-yet-scanned quantity.

### Box ID format
`BOX-{location}-{WW}{YY}{######}`
- `location` = `HK1` (demo warehouse).
- `WW` = ISO week number, zero-padded.
- `YY` = two-digit year.
- `######` = per-week sequence, starting at 1.

## State transitions logged
- `picking_item`: `picking` → `scanned`
- `picking_item`: `scanned` → `boxed`
- `picking_item`: `boxed` → `scanned` (remove from box)
- `picking_order`: `picking` → `finished`
- `shipping_box`: `null` → `open`
- `shipping_box`: `open` → `closed`

## Key invariants
- A package cannot be added to a closed box.
- A package can only be added to a box in the same picking order.
- `picking_items.picked_qty` is always derived from boxed packages, never updated directly.
- `finishPickingOrder` creates the measuring task and links all existing shipping boxes to it.

## Migration note
PGlite has no migrations. The new `picking_packages` table is added to `db/init.ts`, so existing IndexedDB databases must be reset to pick up the schema change.
