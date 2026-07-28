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

A box created during picking that groups packages shipped to a customer; it is weighed and closed in measuring and re-checked in verify.

## Measuring task

A packing task created when a picking order is finished. The operator weighs shipping boxes (net/gross in kg — the net weight is pre-filled from the part net-weight master), records dimensions, and closes them. The task completes automatically when the last box is confirmed.

## Verify task

A second re-measure pass created when a measuring task completes (or when a picking order finishes, if measuring is disabled). Another worker scans each box and re-scans every package before the task can be completed and the order goes to shipping.

## Transition log

An audit trail of status changes for orders, boxes, and tasks.
