# Measuring flow design

## Goal
After a picking order is fully boxed, the system auto-finishes the picking order, creates a measuring task, and guides the operator through:

1. Select a measuring task.
2. See the list of shipping boxes in that task.
3. Select a box.
4. Scan/verify every package inside that box.
5. Once all packages are verified, fill in box size, net weight, gross weight and destination country, then finish the box.
6. When every box is finished, complete the measuring task.

## Current state
- Picking auto-finishes and creates a measuring task when every item is fully boxed (`maybeAutoFinishPickingOrder`).
- `measuring_tasks` and `shipping_boxes` already exist and are linked.
- `pages/measuring/index.vue` lists pending tasks.
- `pages/measuring/[id].vue` currently shows all boxes inline with editable measurements and a **Close box** button.
- There is no per-package verification tracking during measuring.

## Schema change
Add one column to `picking_packages`:

```sql
verified BOOLEAN NOT NULL DEFAULT FALSE
```

- `verified` starts `FALSE` for every new package.
- It becomes `TRUE` when the operator scans the package during measuring.
- When a package is removed from a box before measuring, `verified` is reset to `FALSE`.
- PGlite has no migrations, so any schema change requires resetting the IndexedDB demo data.

## Data flow

### Verifying a package
1. Operator scans an item (part no + date/lot/origin + qty) on the box page.
2. The page finds one unverified package in the current box that matches the scan.
3. `verifyPickingPackageForMeasuring` sets `verified = TRUE` and logs a transition.

### Finishing a box
`closeShippingBox` enforces:
- Box exists and status is `open`.
- Box is not empty.
- Every package in the box has `verified = TRUE`.
- `grossWeight`, `netWeight`, `boxSize` and `destinationCountry` are all set.
- `grossWeight >= netWeight`.

If all checks pass, the box status becomes `closed`.

### Completing the task
`completeMeasuringTask` keeps its existing validation: all boxes must be `closed` and the packed quantity must match the picking item boxed quantity.

## UI
- `pages/measuring/index.vue` — task list (unchanged).
- `pages/measuring/[id].vue` — task detail that lists boxes and links to each box page.
- `pages/measuring/[taskId]/box/[boxId].vue` — new dedicated page for scanning packages, viewing verification progress, entering measurements and finishing the box.

## Edge cases
- Scanning an item that does not exist in the box → error.
- Scanning an already-verified item → show already verified.
- Trying to finish a box with unverified items → error from `closeShippingBox`.
- Trying to finish a box without measurements → error from `closeShippingBox`.
- Removing a package from a box before measuring resets `verified` to `FALSE`.
