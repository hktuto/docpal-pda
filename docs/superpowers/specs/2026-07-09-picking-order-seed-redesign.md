# Picking Order Seed Data Redesign

## Objective

Replace the existing synthetic picking orders and clean up legacy seed data so
the demo contains only:

- One real receiving order (`04958166`) from the WCL client files.
- 23 real picking orders extracted from the client transfer-note (TN) PDFs.
- No pre-existing shelf inventory or legacy receiving/picking data.

## Source files

- `docs/picking_example/TN/SZ-26070040.pdf` through `SZ-26070052.pdf` — 15 files
- `docs/picking_example/TN/GZ-26070045.pdf` through `GZ-26070054.pdf` — 8 files

The two invoice PDFs under `docs/picking_example/invoice/` are image-based and
not processable with available tooling, so they are intentionally excluded per
user direction.

## Scope

### Cleanup (remove)

- Receiving orders `04958058-W-01`, `1080082369`, and `52600142`, plus their
  invoices, items, and mismatches.
- Picking orders `PICK-001` through `PICK-005`, plus their items.
- Pre-existing shelf inventory lots (`preExistingLots`).
- Pre-existing shelf boxes (`preExistingShelfBoxes`).
- Pre-existing put-away scans (`putAwayScans`).

### Keep

- Users (`operator`, `admin`).
- Supplier list (KOA and others remain available; picking orders use KOA).
- Parts from the WCL receiving order (`04958166`) — all 59 TN parts are already
  present in this set.
- Shelves (the shelf grid itself stays).
- Receiving order `04958166` with its invoices and carton-level items, kept in
  `pending` status per user request.

### Add

- 23 `pickingOrders` rows, one per TN file.
- `pickingItems` rows aggregated by part number per picking order.

## Source-to-schema mapping

| Source | Seed field | Notes |
|---|---|---|
| TN filename prefix (`SZ` / `GZ`) | `pickingOrders.shipTo` | `SZ` → `SZ`, `GZ` → `GZ`. |
| Fixed value | `pickingOrders.destinationCountry` | `China` for all orders. |
| TN `Reference No.` | `pickingOrders.refNo` | e.g. `SZ-26070040`. |
| Fixed value | `pickingOrders.supplierId` | `supplierByCode.KOA.id`. |
| TN `Planned Date` | `pickingOrders.deliveryDate` | `2026-07-13`. |
| Fixed value | `pickingOrders.status` | `pending`. |
| TN line items | `pickingItems` | Aggregate by `KOA ITEM CODE`, sum `Quantity`. |
| Fixed value | `pickingItems.requiredDateCode` | `null`. |
| Fixed value | `pickingItems.sourceShelfCode` | `null`. |

## Data volume

- 1 receiving order (`04958166`)
- 16 receiving invoices
- ~129 parts
- 264 receiving invoice items
- 23 picking orders
- ~59 unique parts × 23 orders (aggregated per order, actual count depends on
  overlap)

## Allocation behavior

Because `04958166` remains in `pending` status and shelf inventory is removed,
`allocatePickingOrder()` will find no available stock. Picking orders will be
seeded as `pending` with zero allocations. This matches the user's explicit
choice to keep the receiving order pending.

## Verification

1. `pnpm nuxt prepare` passes without TypeScript errors.
2. `pnpm test` passes.
3. Clear the browser's IndexedDB (or use a private window) and reload the app.
4. Log in as `operator` / `DocPal2026!`.
5. Spot-check:
   - Receiving list shows only `04958166`.
   - Picking list shows 23 orders (`SZ-26070040`–`SZ-26070052`,
     `GZ-26070045`–`GZ-26070054`).
   - Stock search / goods-verify flows have no pre-existing shelf stock.

## Out of scope

- Processing the image-based invoice PDFs.
- Changing the allocation logic to source from `pending` receiving orders.
- Adding new suppliers or parts beyond what already exists from `04958166`.
