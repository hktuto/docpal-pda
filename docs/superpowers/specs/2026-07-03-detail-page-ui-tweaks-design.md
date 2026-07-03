# Detail page UI tweaks

## Goal

Tidy the picking and put-away detail pages for mobile use by collapsing secondary sections, grouping related actions, and de-emphasizing informational buttons.

## Changes

### `pages/picking/[id].vue`

#### 1. Make Boxes a togglable section

The current Boxes section always renders the full list and the "No boxes yet" empty state, which pushes the Items section down the screen on mobile.

- Wrap the Boxes list in a collapsible card.
- Header row shows **"Boxes"** and a **Show / Hide** toggle button.
- Collapsed header also shows a count, e.g. **"2 boxes"** or **"No boxes"**.
- Expanded state shows the existing box list or the empty message.
- Default state on load: **collapsed**, so the worker sees Items first.

#### 2. Move Create box into the Boxes section

- Remove the **Create box** button from the `DetailHeader` actions slot.
- Add it at the top of the *expanded* Boxes section, above the list.
- The button remains disabled while a box is being created.

#### 3. Neutral Show/Hide picking logs button

The logs toggle currently uses the primary brand button style, which makes it look like a main action.

- Change it to a neutral style: `btn--ghost` or a plain muted text button.
- Keep the same expand/collapse behavior and the log count badge.

### `pages/put-away/[id].vue`

#### 4. Make Shelf boxes a togglable section

The current Shelf boxes card is always open and visually dominates the top of the page.

- Convert it to a collapsible card, matching the picking Boxes section pattern.
- Header row shows **"Shelf boxes"** and a **Show / Hide** toggle.
- Expanded state contains:
  - Shelf selector + **Create box** button.
  - Existing box list or empty message.
- Collapsed state shows only the header and a count.
- Default state on load: **collapsed**.

The **Available receiving-area lots** section stays visible below, so the worker can scan items without expanding the boxes list.

## Files to modify

- `pages/picking/[id].vue`
- `pages/put-away/[id].vue`

## Testing

1. `pnpm nuxt prepare` — no type errors.
2. Manual browser check:
   - Open a picking order detail.
   - Confirm Boxes section is collapsed by default and expands/collapses.
   - Confirm **Create box** is inside the expanded Boxes section and still works.
   - Confirm **Show/Hide picking logs** uses a neutral style.
   - Open a put-away order detail.
   - Confirm Shelf boxes section is collapsed by default and expands/collapses.
   - Confirm shelf selector + **Create box** work inside the expanded section.

## Open questions / deferred

- No schema or data changes.
- No changes to scan logic or native code.
