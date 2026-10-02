# Picking shelf-scan mode config — design

Date: 2026-10-02

## Problem

The picking scan matcher validates only part number + qty
(`apps/web/composables/useScanMatchers.ts:106-116`). The allocation engine
pre-assigns each picking item a specific stock lot (`allocations.inventory_lot_id`
→ one `inventory_lots` row with its `shelf_code`), and `scanPickingItem`
decrements that lot regardless of where the item was physically picked from
(`apps/backend/src/db/picking.ts:1137-1147`). Scanning a shelf code today is
only a lookup shortcut to open the pick-from-box dialog
(`usePickingScanQueue.ts:174-178`), not a validation. So the record can say
shelf A-01 while the operator actually took from B-03, and nothing detects
it.

## Decision

One new top-level flow config, three modes. Modelled as a single enum rather
than two booleans: "allow other shelf" is meaningless without a required
shelf scan (the system can only see the physical location if it was scanned),
so the meaningful combinations are exactly these three.

`pickingShelfScan`: `"off"` (default) | `"require-match"` | `"require-any"`.

Follows the existing flow-config conventions: validated at boot alongside the
other keys, admin-editable at runtime via `GET/PUT /admin/flow-config`,
`FLOW_CONFIG` env JSON override wins, resolved onto `GET /config` for the
PDA client.

### Modes

1. **`off`** — today's behavior. Scan item labels directly; deduction follows
   the allocation's lot; a shelf/box scan opens the pick-from-box dialog as a
   lookup shortcut.
2. **`require-match`** — the operator must scan the shelf/box code before
   item labels are accepted (sticky, one scan per location visit). Item scans
   then behave exactly like normal picking scanning — the item must be on the
   picking list and the qty within the remaining need, with the usual
   cross-line split; candidate allocations are **not** filtered by shelf.
   Added check: the scanned part must have stock on the scanned shelf/box,
   else the scan is rejected at scan time (a part that is not there cannot be
   deducted there anyway). Deduction follows physical truth like `require-any`.
3. **`require-any`** — shelf scan still required, but any item is accepted
   with no scan-time shelf check; if the part has no stock on the scanned
   shelf the confirm is rejected (409 `no_stock_at_location`). Deduction
   follows physical truth: stock is decremented from the actually-scanned
   shelf's lot (resolved below), the package row records that lot as its
   source, and the original allocation is reduced so the freed qty re-enters
   normal allocation. The "record vs reality" hole is closed instead of
   merely warned about.

The difference between the two require modes is the strictness of the
shelf-presence check: `require-match` rejects early at scan time,
`require-any` rejects late at confirm.

## Design

### Backend

- `src/config.ts` — `pickingShelfScan` parsed/validated (enum, default
  `"off"`); surfaced in `GET /config` and accepted by `PUT /admin/flow-config`.
- `POST /picking-items/:id/scan` body gains optional `shelfCode` and `boxId`
  (whichever the client captured from the shelf scan). Behavior:
  - Modes `require-*`: when absent on a lot-sourced allocation → 409
    `shelf_scan_required`.
  - Mode `require-match`: no allocation-shelf comparison; the lot to
    decrement is resolved exactly as `require-any`, so a part with no stock
    on the scanned shelf → 409 `no_stock_at_location` (the client already
    pre-checks this at scan time; the 409 is the safety net).
  - Mode `require-any`: the lot to decrement is resolved as:
    `inventory_lots` rows for the picking item's part in the scanned
    shelf/box (org/sub-inventory scope per `src/db/org-filter.ts`),
    label batch fields (`dateCode`/`lotCode`) must match the lot when the
    label carries them; among candidates pick oldest `date_code` (FIFO,
    consistent with `allocate.ts` loadLotSources). No candidate → 409
    `no_stock_at_location`. Deduct that lot, write the PICK ledger rows with
    its ids, set the package `source_id` to it, and `reduceAllocation` the
    original allocation as today.
  - Mode `off`: fields ignored (client never sends them).
- New read endpoint for the scan-time presence check: `GET
  /picking-shelf-stock?partNo=&wclItemNo=&shelfCode=&boxId=` returns the
  available qty of the part at that location (same org/sub-inventory scoping
  and batch-less lot aggregation as the resolver above). The scan page calls
  it once per (shelf, part) per session and caches the result.
- The shelf scan itself reuses the existing resolution: a scan matching
  `lot.boxId`/`lot.shelfCode` is already detected client-side; the client
  just forwards the resolved codes with the item scan.

### Web — picking scan page

- `pages/picking/scan/[id].vue` + `usePickingScanQueue.ts`:
  - Modes `require-*`: one shelf scan sets a sticky `pendingShelf` context —
    the operator scans the shelf once per location visit, then keeps scanning
    items on that shelf. The context shows as a **banner above the list**
    (current shelf/box + clear button) and is replaced by the next shelf
    scan; item scans are rejected with a "scan shelf first" toast while it is
    empty. **No dialog opens on a shelf scan** in these modes — setting the
    location banner is the entire feedback. (`off` mode keeps the existing
    pick-from-box dialog.)
  - `require-match`: item matching is the normal picking flow (no shelf
    filtering of allocation candidates — same as `off`); after targets are
    found, a part-stocked-at-location check runs (cached `GET
    /picking-shelf-stock`); zero → "item not on this shelf" error toast and
    the scan is dropped.
  - `require-any`: allocation matching unchanged; the scanned shelf/box is
    attached to each portion's confirm POST; no scan-time shelf check.
  - Camera/OCR scans: the parsed label has no shelf context; in `require-*`
    modes an OCR scan is rejected with a "use the scanner" message (mirrors
    how OCR already cannot supply `raw` for the label-record spec).
  - Mode read from `GET /config` via the existing flow-config plumbing.

### Admin

- Display-config page (edits via `/admin/flow-config`) gains a
  `pickingShelfScan` select (off / require-match / require-any) with i18n
  labels; flows doc updated.

### Interactions

- Independent of the label-record spec
  (`2026-10-02-picking-scan-label-record-design.md`) — they compose: the same
  scan POST carries `barcode`, `shelfCode`, `boxId` together.
- Box-scan path (`POST /shipping-boxes/:id/scan`) applies the same rules when
  the mode is active.

## Files

- `apps/backend/src/config.ts` — config key + validation.
- `apps/backend/src/routes/picking.ts` — `shelfCode`/`boxId` on scan body;
  new `GET /picking-shelf-stock` endpoint.
- `apps/backend/src/db/picking.ts` — `scanPickingItem` mode branches +
  scanned-lot resolution (both require modes); shelf-stock lookup query.
- `apps/backend/src/routes/admin/flowConfig.ts` (or existing flow-config
  route) — accept/return the key.
- `apps/web/pages/picking/scan/[id].vue`,
  `apps/web/composables/usePickingScanQueue.ts` — sticky shelf banner UX, no
  dialog in require-* modes, scan-time presence check.
- `apps/admin/pages/flow-config.vue` — mode select.
- `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — labels/toasts.
- Tests: backend `scanPickingItem` mode matrix (off / required-absent /
  scanned-lot resolution + `no_stock_at_location` 409) + `GET
  /picking-shelf-stock`; web presence-check + queue tests.
