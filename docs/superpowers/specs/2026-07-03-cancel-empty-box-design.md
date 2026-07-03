# Cancel empty box Design

**Goal:** Allow operators to cancel (delete) an open box that has no items inside, for both picking shipping boxes and put-away shelf boxes.

**Approach:** Hard delete. The box has no items and no downstream references, so deletion is safe and leaves no orphaned data.

## Architecture

### DB helpers

- `db/picking.ts`: add `cancelShippingBox(db, boxId, actorId)`
  - Verify box exists.
  - Verify `status === 'open'`.
  - Verify no `picking_packages` reference `shippingBoxId`.
  - Verify no `shipping_box_items` reference `shippingBoxId`.
  - Delete the row from `shipping_boxes`.
- `db/putAway.ts`: add `cancelShelfBox(db, boxId, actorId)`
  - Verify box exists.
  - Verify `status === 'open'`.
  - Verify no `shelf_box_items` reference `shelfBoxId`.
  - Delete the row from `shelf_boxes`.

Both helpers throw a clear error if any guard fails.

### UI changes

- `pages/picking/[id].vue`
  - In each shipping box card, show a **Cancel** button when:
    - `box.status === 'open'`
    - `(box.shippingBoxItems?.length ?? 0) === 0` (or equivalent item count)
  - On click: call `cancelShippingBox`, then `load()`.
  - Track per-box loading state with `cancellingBox[box.id]`.

- `pages/put-away/[id].vue`
  - In each shelf box card, show a **Cancel** button when:
    - `box.status === 'open'`
    - `(box.items?.length ?? 0) === 0`
  - On click: call `cancelShelfBox`, then `load()`.
  - Track per-box loading state with `cancellingBox[box.id]`.

### Error handling

- Errors surfaced via the existing page-level `error` ref.
- Button disabled while the cancel request is in flight.

## Testing

1. Create a shipping box on a picking order. Verify **Cancel** appears.
2. Click **Cancel**; verify the box disappears and the count updates.
3. Add an item to a box; verify **Cancel** is hidden.
4. Repeat for put-away shelf boxes.
