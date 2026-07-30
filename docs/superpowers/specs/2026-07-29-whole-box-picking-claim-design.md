# Whole-box (exact-match) picking claim — design

Date: 2026-07-29
Status: approved

## Problem

Some receiving invoice items arrive with carton metadata (box size, net
weight, gross weight) from upstream. When a picking order's remaining demand
is **exactly** the contents of one physical shelf box, forcing the operator to
scan item by item and re-weigh the carton wastes the metadata we already have.

## Decisions

1. **Carton metadata lives in `receiving_invoice_items.additional_data`**
   (jsonb, migration 0005). Ingest already passes `additionalData` through —
   no schema change. Key convention (documented, not enforced):

   ```json
   { "boxSize": "M", "netWeight": 1200, "grossWeight": 1350, "weightUnit": "g" }
   ```

   - `weightUnit`: `"g"` | `"kg"`, default `"kg"`. Gram values are converted
     ÷1000 and rounded to 3 dp when prefilled onto a shipping box (shipping
     weights are kg end-to-end).
   - Missing keys → prefill stays NULL; measuring proceeds as today.

2. **Exact match only.** A shelf box qualifies when its *current* contents —
   `inventory_lots` rows with `box_id = <box>` and `total_qty > 0`, aggregated
   per `part_no` — exactly equal the order's full remaining open demand
   (`picking_items.qty − Σ picking_packages.qty` per item, items with 0 open
   excluded). `shelf_box_items` is the put-away manifest and is NOT decremented
   by picks, so it is never used for matching.

3. **The carton is reused as the shipping box.** Claiming creates one shipping
   box (`BOX-S-…`) prefilled with `box_size` / `net_weight` / `gross_weight`
   aggregated from the box's source receiving lines
   (`inventory_lots` → `inventory_lot_sources` → `receiving_invoice_items
   .additional_data`; weights summed per unit conversion, box size = first
   non-null), with `shipping_boxes.source_shelf_box_id` (migration 0008)
   recording the reused carton. All claimed packages are stamped into it.

4. **The picking detail page shows a hint** (`suggestedBox` on the order
   detail DTO) when a claimable exact-match box exists.

## Matching rules (shared by hint and claim)

- Order must be `pending`/`picking` with non-empty open demand.
- Location pair: when the order carries `org_id`, the box's
  `org_id` + `sub_inventory_code` must equal the order's pair; orders without
  a pair match any box.
- Customer segregation: a box in a customer-segregated sub-inventory
  (`sub_inventories.customer_code`) only serves orders of that customer.
- Fully claimable: for every lot of the box,
  `available_qty + COALESCE(this order's allocation from that lot) = total_qty`
  — no other order may reserve any piece of the box.
- Multiple matches → lowest box id wins.

## Claim transaction — `claimShelfBox(orderId, shelfBoxId, actorId)`

1. `loadOrderForWrite` + `assertOrderWritable` (409 `picking_order_has_open_issue`
   / `picking_order_already_finished`) + `assertActor`; load shelf box
   (404 `shelf_box_not_found`).
2. Re-run the match inside the tx → 409 `box_not_exact_match`; availability →
   409 `box_not_fully_available`.
3. Aggregate the weight/size prefill from the source receiving lines.
4. Insert the shipping box (open, prefilled, `source_shelf_box_id`) + log.
5. Per box lot (`total_qty > 0`): set `total_qty = 0`; insert one
   `picking_packages` row per (item of the same `part_no`, lot) with
   `source_type = 'inventory_lot'`, batch attrs snapshot from the lot, and
   `shipping_box_id` = the new box; write a `PICK` `on_hand −qty` ledger row
   per portion.
6. Delete ALL `allocations` of the order's items (claim covers the full
   remaining demand), writing a `RESERVE` `reserved −qty` ledger row per
   released row; `recomputeLot` every freed lot (work-locked orders are
   skipped by `allocateAll`, so the tx cleans up itself);
   `markShelfBoxStockChanged(boxId)` (resets verify flags, verified → closed).
7. `recomputePickingItem` per item (`picked_qty = Σ boxed packages` → full)
   then `maybeAutoFinishPickingOrder` — order `finished` + measuring/verify
   task per `FLOW_STEPS_DISABLED`, same as the scan path.
8. Return `{ shippingBoxId, packageIds }`.

## API

`POST /picking-orders/:id/claim-shelf-box` — body `{ shelfBoxId }`, actor from
the JWT. Response `{ shippingBoxId, packageIds }`. Errors are snake_case plain
text: `box_not_exact_match`, `box_not_fully_available`,
`shelf_box_not_found`, plus the existing order guards.

`GET /picking-orders/:id` gains `suggestedBox: { id, shelfCode, orgId,
subInventoryCode, contents: [{ partNo, qty }] } | null`.

## Web

Picking detail page: hint banner ("This order exactly matches shelf box …")
with a **Use whole box** button → confirm → claim → toast with the new
shipping box id → reload. Hidden when no match or the order is finished.

Verify/measuring need no special-casing: claimed packages are ordinary
`picking_packages`, so the verify re-scan and measuring flows work unchanged —
measuring just sees prefilled weights to confirm.
