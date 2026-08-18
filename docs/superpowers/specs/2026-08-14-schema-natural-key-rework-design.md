# Schema natural-key rework — design

Date: 2026-08-14
Status: implemented

## Summary

Three schema corrections to align with upstream reality:

1. `created_date` → `creation_date` column rename in `parts`, `supplier_profiles`, `suppliers` (matching the existing `sub_inventories.creation_date` naming; TypeScript prop renamed to `creationDate` too).
2. `parts.part_no` is **not unique** — the same supplier part number can exist under several WCL item numbers. `parts.wcl_item_no` is the unique business key.
3. `picking_orders.order_no` is **not unique**.

## Consequences

### Dropped foreign keys

Postgres requires a unique FK target, so with `parts.part_no` no longer unique, every FK referencing it is dropped. The columns stay `text NOT NULL` plain text (app-level existence checks where they already exist, e.g. ingest's `assertPartNo`):

- `net_weight_formula.part_no` (keeps its own UNIQUE — one formula row per part number)
- `inventory_lots.part_no`
- `shelf_box_items.part_no`
- `goods_verify_tasks.part_no`
- `receiving_invoice_items.part_no`
- `picking_items.part_no`
- `shipping_box_items.part_no`
- `inventory_transactions.part_no`

`parts.part_no` gains a plain btree index (`idx_parts_part_no`) for the remaining equality lookups.

### Ingest keying

- **Picking orders**: dedup key is the caller-supplied UUID `id` — `PUT /picking-orders/:id` / `DELETE /picking-orders/:id`. `orderNo` moves into the body (`order.orderNo`, required) and is reconciled like any other order field (re-upsert with a different `orderNo` renames the order). Since the route id IS the lookup key, there is no `id_already_exists` conflict at order level; item-level caller ids remain INSERT-only. The priority-queue insert still tiebreaks on `order_no` (duplicates harmless).
- **Parts**: keyed by `wclItemNo` in the JSON body — `PUT /parts` and `DELETE /parts?wclItemNo=` (wcl_item_no contains `/`, e.g. `ABBYY/BC2`, so it cannot be a path param). `partNo` is a regular required body field, updatable on reconcile. Deleting a part no longer hits FK violations (no references remain).
- **Receiving** is untouched (`receiving_orders.batch_no` stays unique).

## Migration

`drizzle/0012_young_vision.sql`: three column renames, drop `parts_part_no_unique` + `picking_orders_order_no_unique`, drop the 8 part_no FKs, add `idx_parts_part_no`, add `parts_wcl_item_no_unique` (nullable-unique — multiple NULLs allowed). Seed data verified clean for the new unique constraint (100,267 rows, no null/duplicate wcl_item_no).

## Out of scope

- Re-keying referencing tables to `wcl_item_no` (columns stay plain text by decision).
- Admin/web UI behavior (no displayed fields changed).
