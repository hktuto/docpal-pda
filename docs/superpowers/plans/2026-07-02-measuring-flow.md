# Measuring flow implementation plan

## Files to change

1. `db/schema.ts`
   - Add `verified: boolean("verified").notNull().default(false)` to `pickingPackages`.

2. `db/init.ts`
   - Add `verified BOOLEAN NOT NULL DEFAULT FALSE` to the `picking_packages` CREATE TABLE statement.

3. `db/measuring.ts`
   - Add `PackageVerification` interface for scan input.
   - Add `verifyPickingPackageForMeasuring(db, packageId, actorId)`.
   - Add `getShippingBoxForMeasuring(db, boxId)` with packages and measuring task relations.
   - Add `findMatchingUnverifiedPackage(db, shippingBoxId, scan)` to match a scanned part/lot/qty to one unverified package in the box.
   - Update `closeShippingBox` to require all packages verified and all measurement fields present.
   - Update `MeasuringTaskDetail` package shape to include `verified`.

4. `db/picking.ts`
   - In `removePackageFromBox`, reset `verified = false` on the removed package.

5. `pages/measuring/[id].vue`
   - Replace inline box forms with a box list.
   - Each box card shows status, package count, verified count, measurement summary and a link to the box page.
   - Keep the **Complete measuring** button when all boxes are `closed`.
   - Reload on mount/focus/visibility change.

6. `pages/measuring/[taskId]/box/[boxId].vue`
   - New page.
   - Load box with `getShippingBoxForMeasuring`.
   - Show package list with verification status and progress.
   - Show scan form (part no, date code, lot code, origin country, qty) when box is `open` and packages remain unverified.
   - Show measurement form when all packages are verified.
   - **Save box details** calls `updateShippingBox`.
   - **Finish box** calls `closeShippingBox` and navigates back to task detail.

## Verification

- Run `pnpm nuxt prepare` after the schema change.
- Run `pnpm build` and confirm no errors.
- Manual test (reset IndexedDB first):
  1. Fully box a picking order so it auto-creates a measuring task.
  2. Open measuring list → task detail → select a box.
  3. Verify every package with the scan form.
  4. Fill measurements and finish the box.
  5. Return to task detail, then complete the measuring task.
