# Add All Unboxed Items to Box

## Goal

Add an **“Add”** button on open boxes in the receiving picking tab and put-away flow so the operator can move all currently unboxed items/scans into a selected box with one tap.

## Context

- **Receiving picking tab** (`components/receiving/ReceivingPickingTab.vue`): operators scan picking items and then add each scanned package to a shipping box one by one via a dropdown.
- **Put-away** (`components/put-away/ShelfBoxesPanel.vue`): operators scan receiving pieces and then add each scan to a shelf box one by one via a dropdown.

Both flows already support adding a single record to a box. This feature adds a batch action at the box level.

## Scope

### In scope

- Receiving picking tab: “Add” button on each open shipping box that adds all unboxed packages belonging to that box’s picking order.
- Put-away: “Add” button on each open shelf box that adds all unboxed scans belonging to that box’s receiving order.
- Transactional batch add (all-or-nothing per click).
- Loading/disabled UI state while the batch is running.

### Out of scope

- Smart distribution across multiple boxes.
- Quantity limits or box capacity checks beyond existing validation.
- Adding the button to closed/cancelled boxes.

## Design

### UI

#### Receiving picking tab

In `components/receiving/ReceivingPickingTab.vue`, inside the existing box list (`boxesByOrder[po.id]`), add an **“Add”** button next to each open box:

- Disabled when:
  - Box status is not `open`.
  - There are no unboxed packages for `po.id`.
  - `addingAll[box.id]` is true.
- Emits `add-all-to-box` with `box.id`.

#### Put-away shelf boxes

In `components/put-away/ShelfBoxesPanel.vue`, inside each open box card, add an **“Add”** button:

- Disabled when:
  - Box status is not `open`.
  - There are no unboxed scans for `box.receivingOrderId`.
  - `addingAll[box.id]` is true.
- Emits `add-all-to-box` with `box.id`.

### Data flow

#### Receiving picking

1. `pages/receiving/[id].vue` receives `add-all-to-box` event.
2. Sets `addingAll[boxId] = true`.
3. Calls `addAllUnboxedPackagesToBox(db, boxId, currentUser.id)`.
4. On success, calls `load()` to refresh.
5. On error, shows `errorMessage(e)`.
6. Sets `addingAll[boxId] = false`.

#### Put-away

1. `pages/put-away/[id].vue` receives `add-all-to-box` event.
2. Sets `addingAll[boxId] = true`.
3. Calls `addAllUnboxedScansToBox(db, boxId, currentUser.id)`.
4. On success, calls `load()` to refresh.
5. On error, shows `errorMessage(e)`.
6. Sets `addingAll[boxId] = false`.

### DB helpers

#### `db/picking.ts`

```ts
export async function addAllUnboxedPackagesToBox(
  db: PgliteDatabase<typeof schema>,
  shippingBoxId: string,
  actorId: string
): Promise<number>
```

- Loads the shipping box. Throws if not found or not open.
- Queries `picking_packages` where `shippingBoxId IS NULL` and `pickingOrderId = box.pickingOrderId`.
- In a transaction, calls the equivalent logic of `addPackageToBox` for each package.
- Refreshes `picking_items.pickedQty` and triggers `maybeAutoFinishPickingOrder`.
- Returns the number of packages added.

#### `db/putAway.ts`

```ts
export async function addAllUnboxedScansToBox(
  db: PgliteDatabase<typeof schema>,
  shelfBoxId: string,
  actorId: string
): Promise<number>
```

- Loads the shelf box. Throws if not found or not open.
- Queries `put_away_scans` where `shelfBoxId IS NULL` and the parent receiving invoice item belongs to `box.receivingOrderId`.
- In a transaction, calls the equivalent logic of `assignScanToBox` for each scan.
- Updates inventory lots, shelf box item summaries, and receiving item `putAwayQty`.
- Returns the number of scans added.

### Helpers for disabled state

- `components/receiving/ReceivingPickingTab.vue`: derive unboxed package count per picking order from `packagesByItem`.
- `components/put-away/ShelfBoxesPanel.vue`: receive a new prop `unboxedCountByBoxId: Record<string, number>` computed in the parent from `scans`.

### i18n

New keys:

```yaml
receiving:
  pickingTab:
    addAll: "Add"
putAway:
  shelfBoxesPanel:
    addAll: "Add"
```

## Testing

- Unit tests in `tests/` should verify both helpers:
  - Add multiple unboxed packages/scans in one call.
  - Return 0 and make no changes when nothing is unboxed.
  - Throw and roll back when the box is not open.
  - Verify parent quantities update correctly.

## Success criteria

- “Add” button appears on open boxes in both flows.
- Tapping “Add” moves all eligible unboxed items into the box.
- Button is disabled when no eligible items exist.
- UI refreshes and shows updated box contents.
- Existing single-item add/remove behavior still works.
