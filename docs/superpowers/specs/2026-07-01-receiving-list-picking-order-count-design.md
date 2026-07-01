# Receiving List — Pending Picking Order Count

## Goal
Show, on the receiving list page, how many distinct picking orders still need items from each receiving order.

## Background
- Receiving orders contain invoices, which contain invoice items.
- Invoice items can be allocated to `picking_items` via the `allocations` table.
- Each `picking_item` belongs to a `picking_order`.
- The user wants a quick at-a-glance count of pending picking orders per receiving order.

## Data Definition
A receiving order has **pending picking orders** equal to the count of distinct `picking_orders.id` linked to that receiving order through an allocation where the allocated quantity is not yet fully picked.

### Link path
```
receiving_order
  → receiving_invoices
    → receiving_invoice_items
      → allocations
        → picking_items
          → picking_orders
```

### Inclusion rule
A picking order is counted as pending if at least one of its `picking_items` satisfies:
```
allocation.qty > picking_item.pickedQty
```
If all allocations for a picking order are fully picked, that picking order is not counted.

## UI Design
Add a small badge on the receiving list card, positioned with the existing status/date/remaining badges on the right side.

- The badge is only rendered when the count is greater than zero.
- Text: `1 picking` or `2 pickings` (pluralized).
- Style: existing `.badge` class with a new color to distinguish it from the "remaining qty" badge.

## Query Design
Extend the existing SQL in `pages/receiving/index.vue` to compute `pending_picking_orders` per receiving order.

The query uses a correlated subquery or CTE joining:
- `receiving_invoice_items` (rii)
- `allocations` (a)
- `picking_items` (pi)

It counts distinct `picking_order_id` where `a.qty > pi.picked_qty`.

The `useLiveQuery` hook keeps the count reactive as allocations and pick quantities change.

## Edge Cases
- No allocations: count is zero, badge hidden.
- Multiple allocations to the same picking order: counted once.
- Fully picked allocation: excluded.
- Receiving order status `pending` or `completed`: the count is still computed based on allocations. It naturally becomes zero when all allocations are picked/put away.

## Scope
- Only the receiving list page (`pages/receiving/index.vue`) is changed.
- No new DB functions or composables are required; the computation is added to the existing inline query.
