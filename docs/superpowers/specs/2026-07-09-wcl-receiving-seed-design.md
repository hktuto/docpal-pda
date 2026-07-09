# WCL Receiving Order Seed Data Update

## Objective

Add a real receiving order from the client-provided WCL Excel files to the demo
seed (`db/seed.ts`), keeping the existing synthetic/demo receiving orders intact
as a backup.

## Source files

- `docs/receiving example/WCL HK.xlsx` — invoices `04958166-W-01` through `W-05`, 43 rows
- `docs/receiving example/WCL MCO.xlsx` — invoices `04958166-W-06` through `W-16`, 221 rows

Both files belong to a single receiving order (`04958166`) and contain only KOA
parts with delivery date `2026-07-10`.

## Scope

- **Keep existing data**: do not remove or alter the current receiving orders
  (`04958058-W-01`, `1080082369`, `52600142`), their invoices, items, parts,
  suppliers, shelf inventory, picking orders, or put-away scans.
- **Add new receiving order**: `04958166` for supplier KOA, status `pending`,
  delivery date `2026-07-10`.
- **Add new invoices**: 16 receiving invoices (`W-01` through `W-16`) linked to
  the new order.
- **Add new parts**: all distinct KOA item codes found in the two files, added to
  the existing `partRecords` array. `defaultCoo` is `CN` (the source documents
  are marked "MADE IN CHINA").
- **Add new items**: one `receivingInvoiceItems` row per Excel row, preserving
  carton-level granularity. The user explicitly requested carton-level items
  rather than aggregating by PO line.

## Source-to-schema mapping

| Excel column | Seed field | Notes |
|---|---|---|
| `INVOICE NO.` | `receivingInvoices.invoiceNo` | Common prefix `04958166` becomes `receivingOrders.refNo`. |
| `P/O NO.` | `receivingInvoiceItems.poNo` | As-is. |
| `P/O LINE` | `receivingInvoiceItems.poLine` | Converted to string. |
| `KOA ITEM CODE` | `parts.partNo` + item `partId` | Clean part number; added to `parts` if missing. |
| `QTY` | `receivingInvoiceItems.qty` | Expected quantity. |
| `CARTON NO.` | `receivingInvoiceItems.boxId` | Preserved per carton row. |
| `DELIVERY DATE` (serial `46213`) | `receivingOrders.deliveryDate` | `2026-07-10`. |
| n/a | `receivingInvoiceItems.receivedQty` | `0` because the order is seeded as `pending`. |
| n/a | `receivingInvoiceItems.coo` | `CN` for all rows. |
| n/a | `receivingInvoiceItems.cow` | `USA` (consistent with existing seed). |

## Data volume

- 1 new receiving order
- 16 new receiving invoices
- ~129 new parts
- 264 new receiving invoice items (one per Excel row)

## Verification

1. `pnpm nuxt prepare` passes without TypeScript errors.
2. Clear the browser's IndexedDB (or use a private window) and reload the app.
3. Log in as `operator` / `DocPal2026!`.
4. Spot-check:
   - Receiving list shows the new `04958166` order plus the 3 existing orders.
   - `04958166` detail shows 16 invoice sections with carton-level line items.
   - Existing orders (`04958058-W-01`, `1080082369`, `52600142`) still appear
     with their original items.

## Out of scope

- Changing picking orders, shelf inventory, or allocations.
- Updating supplier records other than ensuring KOA exists.
- Modifying the UI or schema.
