# Put-away item-first hardware scan — design

Date: 2026-10-02. Status: proposed.

## Problem

On the put-away detail page (`apps/web/pages/put-away/[id].vue`) the hardware
scanner runs in free-match mode: a scanned label is parsed via the supplier QR
templates and matched against the order's visible items by part number
(`findPutAwayTarget` in `apps/web/utils/putAwayScan.ts`). The matched item is
whatever the label says — a mislabeled or foreign label that happens to parse
to a part on the order is silently accepted against that item.

The operators asked for an item-first alternative: they tap the item they are
physically holding, then scan its stock label with the gun, so every scan is
explicitly anchored to (and validated against) a chosen order item. The box
step should stay optional — it already is: with no active box, scans land in
staging (`shelfBoxId` is nullable end-to-end), so this spec changes nothing
about boxes.

The per-item camera/OCR scan (`openScan`) is already item-first; what is
missing is the same anchoring for the hardware scanner.

## Design

### 1. Arming an item

- `PutAwayLotsPanel.vue` gains a second small button next to the existing
  camera **Scan** button: **Gun scan** (`putAway.lotsPanel.gunScan`). Tapping
  it emits a new `arm-scan` event instead of opening the camera.
- The page holds `armedItemId = ref<string | null>(null)`. Tapping the button
  on the armed item disarms (toggle); tapping another item's button re-arms
  on that item.
- While armed, the item card shows a highlighted border plus an "armed"
  badge and a hint line ("Scan labels for this item"), and the button label
  switches to a disarm label. Keep visible when the item is scrolled to via
  `scrollTargetItemId`.

### 2. Armed scan handling

Scanner routing precedence in the `useHardwareScanner` `onScan` handler
(`pages/put-away/[id].vue`):

1. scan-box dialog open → scan is the box id (unchanged);
2. `armedItemId` set → **strict item-first scan**;
3. otherwise → existing free-match (unchanged).

The strict branch:

- Parse the label exactly as today (`parseRawValue` with the supplier code).
- Match with `findPutAwayTarget([armedItem], parsed.partNo, qty)` — the same
  helper, restricted to the single armed item, so part-number mismatch or
  qty over remaining fails with the existing
  `errors.scanned_part_does_not_match_item` toast. (The backend's
  `scanned_qty_exceeds_remaining` guard remains the backstop.)
- On success: `recordPutAwayScan(orderId, armedItem.id, qty, dateCode,
  lotCode, coo, cow, activeBoxId)` — same call as today, so an active box
  still receives the scan directly and otherwise it stages. Toast + scroll +
  reload as today.
- The scan **stays armed** after a successful scan (the common case is
  several pieces of the same item) and auto-disarms when the reload shows the
  armed item has left `visibleItems` (fully put away and no staged scans).

### 3. Validation scope

Strict mode enforces: part number match + qty fits remaining. Date code /
lot / COO / COW are recorded as scanned, not validated against the item's
expected values — same as free-match today. Validating those is a possible
follow-up, out of scope here.

## Client changes

- `pages/put-away/[id].vue` — `armedItemId` state, scanner branch, auto-disarm
  after reload, pass armed highlight down.
- `components/put-away/PutAwayLotsPanel.vue` — gun-scan button, armed card
  styling, new `arm-scan` emit.
- `utils/putAwayScan.ts` — no change (single-item call reuses
  `findPutAwayTarget`).
- i18n keys in `layers/i18n` (`putAway.lotsPanel.gunScan`, an armed/disarm
  label and hint) for `en-US`, `zh-CN`, `zh-HK`.

## Non-goals

- **No backend change.** `shelfBoxId` stays optional; no new enforcement or
  endpoint.
- Boxes stay exactly as they are (optional accelerator + staging assignment).
- Free-match remains the default un-armed behavior; item-first is opt-in per
  item tap.
- No validation of date code / lot / COO / COW against expected values.
