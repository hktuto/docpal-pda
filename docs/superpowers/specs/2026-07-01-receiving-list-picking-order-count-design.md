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
An allocation counts as pending if `allocation.qty > 0`. Fully-picked allocations are removed or reduced by the picking flow, so any allocation row with positive quantity still represents outstanding demand.

The count includes both direct allocations (`allocations.receiving_invoice_item_id`) and allocations linked indirectly through `inventory_lots` / `inventory_lot_sources`.

## UI Design
Add a small badge on the receiving list card, positioned with the existing status/date/remaining badges on the right side.

- The badge is only rendered when the count is greater than zero.
- Text: `1 picking order` or `N picking orders` (pluralized).
- Style: existing `.badge` class with a new color to distinguish it from the "remaining qty" badge.

## Query Design
Extend the existing SQL in `pages/receiving/index.vue` to compute `pending_picking_orders` per receiving order.

The query uses a correlated subquery with a `UNION ALL` of two allocation paths:
1. Direct allocations: `allocations.receiving_invoice_item_id` → `receiving_invoice_items`.
2. Lot-source allocations: `allocations.inventory_lot_id` → `inventory_lots` → `inventory_lot_sources` → `receiving_invoice_items`.

The outer query wraps the union in `COUNT(DISTINCT po_id)` and filters by `picking_orders.status IN ('pending', 'picking')`.

The `useLiveQuery` hook keeps the count reactive as allocations and pick quantities change.

## Edge Cases
- No allocations: count is zero, badge hidden.
- Multiple allocations to the same picking order: counted once.
- Fully picked allocation: excluded.
- Receiving order status `pending` or `completed`: the count is still computed based on allocations. It naturally becomes zero when all allocations are picked/put away.

## Scope
- Only the receiving list page (`pages/receiving/index.vue`) is changed.
- No new DB functions or composables are required; the computation is added to the existing inline query.
