# Put-away: scan box QR to use a box, scan shelf QR to select a shelf — design

Date: 2026-10-05. Status: implemented.

## Problem

On the PDA put-away detail page (`apps/pda/pages/put-away/[id].vue`), using a physical
pre-printed box QR label or a shelf QR label currently takes too many steps:

- A box QR can only be entered through the "掃描箱號" dialog (open dialog → scan → pick a
  shelf → confirm). There is no way to scan a box QR straight from the page.
- There is no shelf scan at all — the shelf is chosen from a `<select>` inside the
  new-box / scan-box dialogs.

Operators want the natural physical flow: scan a shelf label, scan a box label, scan
item labels — done.

## Goals

1. Scanning the QR of an **existing open box of the order** makes it the active box
   (subsequent item scans land in it) — no dialog.
2. Scanning a **shelf code** selects that shelf as a sticky page context (banner with a
   clear button), which:
   - pre-selects the shelf in the new-box / scan-box dialogs, and
   - lets an unknown `BOX-*` scan create the box on that shelf in one step
     (no dialog when a shelf is selected).
3. Everything keeps working as today when no shelf is selected (dialogs open as before).

Non-goals: moving an existing box to another shelf (no backend endpoint; shelf is fixed
at box creation), validating shelf codes server-side, goods-verify/picking flows.

## Scan classification

The page's hardware-scan handler classifies the raw value in this order (first match
wins, checked before the supplier-label parse):

1. **Shelf** — case-insensitive exact match against `shelves[].code` (already loaded via
   `warehouse.getShelves()` for the dialogs) → shelf-select flow.
2. **Box** — exact match against the order's loaded boxes (`aggregate.boxes[].id`), or a
   `BOX-` prefix (the generated id format `BOX-{S|H}-<date>-<seq>`, `nextBoxId` in
   `apps/backend/src/db/boxes.ts`) → box flow.
3. Otherwise → the existing supplier-label item flow (unchanged).

Custom pre-printed box ids that are neither in the order's boxes nor `BOX-*`-prefixed
fall to the item flow (toast `scanned_part_does_not_match_item`); the scan-box dialog
remains the entry point for those. Documented limitation.

Classification lives in a pure helper (`classifyPutAwayScan` in
`apps/pda/utils/putAwayScan.ts`) so it is unit-testable.

## Flows

### Shelf scan → select shelf

- Sets `selectedShelf` (code), shown as a dismissible banner above the items
  ("Shelf: EG01 ✕"), mirroring the picking scan page's sticky shelf banner.
- Replaces any previous selection; scanning the same shelf again is a no-op toast.
- While selected:
  - **New box button** creates the box on the selected shelf immediately (skips
    `SelectShelfDialog`) and activates it.
  - **Scan-box dialog** opens with the shelf pre-selected (still editable).
  - **Unknown `BOX-*` scan** creates the box on the selected shelf via
    `createShelfBox(orderId, shelf, boxId)` and activates it; without a selected shelf
    the scan-box dialog opens prefilled with the box id (today's flow).

### Box scan → use existing box

- Id found in the order's boxes and `status === "open"` → set `activeBoxId`, success
  toast; scanning the already-active box re-confirms (toast).
- Found but `closed`/`verified` → error toast (`shelf_box_not_open`).
- Not in the order's boxes → treated as a new box id (see shelf flow above);
  `createShelfBox` is idempotent for an open box of the same order and returns
  409 `box_id_already_exists` for a box owned elsewhere — the backend error is toasted
  as today.

## Backend

No changes. `POST /shelf-boxes` (`createShelfBox`,
`apps/backend/src/db/putaway.ts:782`) already covers create + idempotent reuse.

## i18n

New keys (en-US / zh-CN / zh-HK) under `putAway`: `shelfBannerLabel`,
`shelfBannerClear`, `shelfSelected`, `boxActivated`, `boxCreatedAndActivated`,
`boxNotOpen`. (`boxNotFound` not needed — the order's box list + idempotent create
cover lookup.)

## Testing

- `apps/pda/tests/putAwayScan.test.ts`: `classifyPutAwayScan` — shelf match (case),
  order-box match, `BOX-` prefix, fall-through to item.
- Manual: browser scan emulation (keyboard-wedge keydown replay) on the put-away page.
