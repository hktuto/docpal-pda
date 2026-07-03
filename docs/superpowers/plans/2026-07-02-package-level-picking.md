# Package-Level Picking with Auto-Generated Shipping Boxes

> **Status:** Completed. This plan was executed. Some later refactors may have changed minor details; refer to the current source for the latest implementation.

## Goal
Change the picking flow so operators scan individual physical packages (e.g. ten 2k reels) into a scanned pool, create shipping boxes with auto-generated IDs (`BOX-HK1-WWYY000001`), add scanned packages into boxes, and finish a picking item once all of its required quantity is boxed.

## Decisions
- Stock is consumed at **scan time**. Boxing is only organisation.
- `picking_items.picked_qty` is redefined as the **boxed quantity**.
- A new `picking_packages` table tracks every scanned physical package and which box it belongs to.
- Box IDs use a fixed demo warehouse code `HK1`: `BOX-HK1-{WW}{YY}{######}` where `WW` = ISO week, `YY` = two-digit year, and the 6-digit sequence increments per week.
- `shipping_box_items` is kept in the bootstrap SQL for compatibility but is no longer written to; measuring reads packages instead.
- PGlite has no migrations, so the demo database must be cleared after this change.

## Schema changes
- Add `picking_packages` table in `db/schema.ts` and `db/init.ts`.
- Add Drizzle relations: `pickingItems.packages`, `pickingOrders.packages`, `shippingBoxes.packages`.

## Backend changes
- `db/picking.ts`
  - Replace `confirmAllocationPicked` with `scanAllocationToPackage`.
  - Add `createShippingBoxForPickingOrder`.
  - Add `addPackageToBox` / `removePackageFromBox`.
  - Update `getPickingOrderDetail` to include packages and boxes.
  - Update `getPickingOrdersByReceivingOrder` to include scanned/boxed counts.
  - Update `finishPickingOrder` / `maybeAutoFinishPickingOrder` to set `measuringTaskId` on existing boxes when creating the measuring task.
- `db/ocrPicking.ts`
  - Update `applyOcrPick` to call `scanAllocationToPackage` and create scanned packages.
- `db/measuring.ts`
  - Read packed quantities from `picking_packages`.
  - Remove `createShippingBox` and `addItemToShippingBox`.
  - Update `closeShippingBox` and `completeMeasuringTask` to use packages.

## UI changes
- `pages/picking/[id].vue`
  - Show scanned/boxed quantities per item.
  - List allocations with **Scan package** buttons.
  - Show unboxed packages with **Add to box** selectors.
  - Show boxed packages per item and boxes per order.
  - Add **Create box** and **Finish picking** buttons.
- `pages/receiving/[id].vue`
  - Update Picking view to show required / scanned / boxed counts.
- `pages/picking-by-receiving/[id].vue`
  - Same required / scanned / boxed display update.
- `pages/measuring/[id].vue`
  - Remove create box and pack controls.
  - Show packages already inside each box.
  - Keep box dimension editing and close/complete actions.
- `components/OcrScanModal.vue`
  - Update status text from "pick" to "scan package".

## Documentation
- Update `README.md` workflow, entity overview, data flow, routes, and project structure.
- Update `docs/database-relations.md` ER diagram, table summary, relation rules, and allocation lifecycle.

## Verification
- `pnpm nuxt prepare` passes.
- `pnpm build` passes.
- Manual test (after clearing IndexedDB):
  1. Scan a receiving item into a picking item → package appears as scanned.
  2. Create a box → ID matches `BOX-HK1-...`.
  3. Add package to box → boxed qty increases.
  4. When boxed qty reaches required qty, item is finished and order can be finished.
  5. Measuring detail shows the box and its packages.
