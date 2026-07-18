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

A box created during measuring/packing that groups items shipped to a customer.

## Measuring task

A packing task created when a picking order is finished. The operator measures shipping boxes and records dimensions.

## Transition log

An audit trail of status changes for orders, boxes, and tasks.
