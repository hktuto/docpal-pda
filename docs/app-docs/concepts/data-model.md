# Data Model (Business View)

These are the core entities an operator works with. For the full database schema, see the [backend schema reference](../../backend/schema.md).

## Receiving order

An incoming shipment from a supplier. It contains one or more invoices, and each invoice contains line items (parts).

## Picking order

An outgoing shipment to a customer/supplier. It contains line items that must be picked from inventory.

## Inventory lot

A quantity of a specific part, identified by part number, date/lot code, origin, and location (shelf or box).

## Allocation

A reservation of stock for a picking item. An allocation points to an inventory lot or directly to a receiving invoice item.

## Shelf box

A box created during put-away that groups items moved onto a shelf.

## Shipping box

A box created during picking that groups packages shipped to a customer — it may hold packages from several picking orders (cross-order packing). It is weighed and closed in measuring (closing IS the measuring completion — there is no measuring task) and re-checked in verify before being shipped per box.

## Verify task

A second re-scan pass over one closed shipping box (one task per box, created when the box is closed). Another worker re-scans every package before the task can be completed and the box goes to shipping.

## Transition log

An audit trail of status changes for orders, boxes, and tasks.
