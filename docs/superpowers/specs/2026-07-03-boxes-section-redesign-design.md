# Boxes section redesign

## Goal

Make the Boxes section on picking detail and put-away detail consistent, compact, and mobile-friendly: show the count and a **New box** action in the always-visible header, collapse the list, and (for put-away) group boxes by shelf with per-box item visibility.

## Scope

- `pages/picking/[id].vue`
- `pages/put-away/[id].vue`
- New shared dialog component for put-away shelf selection (or inline if simpler).

## Design

### Common header pattern

Both pages use the same header layout for the Boxes section:

```text
Boxes({count})  ─────────────────  [New box]  [v]
```

- Left: section title with box count, e.g. `Boxes(1)`.
- Right: **New box** button + expand/collapse toggle.
- The header is always visible, even when the section is collapsed.

### `pages/picking/[id].vue`

1. Update the Boxes header to:
   - Show `Boxes({{ order.shippingBoxes?.length ?? 0 }})`.
   - Include a **New box** button that calls `createBox()` directly.
   - Keep the existing expand/collapse toggle with `aria-expanded`.
2. Remove the old **Create box** button from inside the expanded content (it is now in the header).
3. Expanded content continues to show the list of shipping boxes or the empty state.

### `pages/put-away/[id].vue`

1. Update the Shelf boxes header to:
   - Show `Shelf boxes({{ boxes.length }})`.
   - Include a **New box** button that opens a shelf-selection dialog.
   - Include the expand/collapse toggle.
2. Remove the current shelf selector + **Create box** row from inside the section.
3. **New box dialog**
   - Modal with shelf selector and **Confirm** / **Cancel** buttons.
   - On confirm, call the existing `createShelfBox` helper with the selected shelf.
   - On cancel or overlay click, close without creating.
4. **Expanded content grouped by shelf**
   - Compute `boxesByShelf` from `boxes` array.
   - For each shelf code, render a sub-header: **Shelf {code}** (with zone if available).
   - Under each shelf, list the boxes belonging to that shelf.
5. **Per-box item visibility**
   - Each box card shows its summary rows (Box ID, Status, Items, Qty).
   - The item list is shown by default for **open** boxes and hidden by default for **closed** boxes.
   - Add a small toggle button on each box card to show/hide its items.
   - Closed boxes keep the summary visible; only the item list is hidden.

## Files to modify / create

- `pages/picking/[id].vue`
- `pages/put-away/[id].vue`
- `components/SelectShelfDialog.vue` (new) — reusable shelf-selection dialog.

## Testing

1. `pnpm nuxt prepare` — no type errors.
2. `pnpm generate` — builds successfully.
3. Manual browser check:
   - Picking detail:
     - Header shows `Boxes(0)` and **New box** + toggle when collapsed.
     - Clicking **New box** creates a box and refreshes the count.
     - Expanding shows the new box.
   - Put-away detail:
     - Header shows `Shelf boxes(0)` and **New box** + toggle when collapsed.
     - Clicking **New box** opens the shelf dialog.
     - Selecting a shelf and confirming creates a box.
     - Expanded section groups boxes by shelf.
     - Open boxes show item lists by default.
     - Closed boxes hide item lists by default.
     - Per-box show/hide toggle works.

## Open questions / deferred

- No schema or data changes.
- No changes to scan logic or native code.
