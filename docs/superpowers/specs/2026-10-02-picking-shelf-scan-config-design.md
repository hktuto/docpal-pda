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
   the allocation's lot; shelf shown as an informational hint only.
2. **`require-match`** — the operator must scan the shelf/box code before
   item labels are accepted; the scanned location must equal the matched
   allocation's lot location, else the scan is rejected. Deduction unchanged.
3. **`require-any`** — shelf scan still required, but a different shelf is
   allowed. Deduction follows physical truth: stock is decremented from the
   actually-scanned shelf's lot (resolved below), the package row records
   that lot as its source, and the original allocation is reduced so the
   freed qty re-enters normal allocation. The "record vs reality" hole is
   closed instead of merely warned about.

## Design

### Backend

- `src/config.ts` — `pickingShelfScan` parsed/validated (enum, default
  `"off"`); surfaced in `GET /config` and accepted by `PUT /admin/flow-config`.
- `POST /picking-items/:id/scan` body gains optional `shelfCode` and `boxId`
  (whichever the client captured from the shelf scan). Behavior:
  - Mode `require-match`: when absent → 409 `shelf_scan_required`; when
    present but ≠ the allocation lot's shelf/box → 409
    `shelf_mismatch`. Then the existing flow unchanged.
  - Mode `require-any`: same required check; the lot to decrement is
    resolved as: `inventory_lots` rows for the picking item's part in the
    scanned shelf/box (org/sub-inventory scope per `src/db/org-filter.ts`),
    label batch fields (`dateCode`/`lotCode`) must match the lot when the
    label carries them; among candidates pick oldest `date_code` (FIFO,
    consistent with `allocate.ts` loadLotSources). No candidate → 409
    `no_stock_at_location`. Deduct that lot, write the PICK ledger rows with
    its ids, set the package `source_id` to it, and `reduceAllocation` the
    original allocation as today.
  - Mode `off`: fields ignored (client never sends them).
- The shelf scan itself reuses the existing resolution: a scan matching
  `lot.boxId`/`lot.shelfCode` is already detected client-side; the client
  just forwards the resolved codes with the item scan.

### Web — picking scan page

- `pages/picking/scan/[id].vue` + `usePickingScanQueue.ts`:
  - Modes `require-*`: one shelf scan sets a sticky `pendingShelf` context —
    the operator scans the shelf once per location visit, then keeps scanning
    items on that shelf. The context shows as a clearable chip and is
    replaced by the next shelf scan; item scans are rejected with a "scan
    shelf first" toast while it is empty. The shelf is NOT re-scanned before
    every item — only when a mismatch error sends the operator to a
    different location.
  - `require-match`: `findTargets`/`matchBoxAllocations` candidates are
    filtered to allocations whose lot shelf/box equals `pendingShelf`;
    no candidate → shelf-mismatch error toast.
  - `require-any`: allocation matching unchanged (any same-part allocation
    may fulfill the demand); the scanned shelf/box is attached to each
    portion's confirm POST.
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
- `apps/backend/src/routes/picking.ts` — `shelfCode`/`boxId` on scan body.
- `apps/backend/src/db/picking.ts` — `scanPickingItem` mode branches + lot
  resolution for `require-any`.
- `apps/backend/src/routes/admin/flowConfig.ts` (or existing flow-config
  route) — accept/return the key.
- `apps/web/pages/picking/scan/[id].vue`,
  `apps/web/composables/usePickingScanQueue.ts` — shelf context UX + matcher
  filtering.
- `apps/admin/pages/display-config.vue` — mode select.
- `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — labels/toasts.
- Tests: backend `scanPickingItem` mode matrix (off / required-absent /
  mismatch / any-lot resolution + 409s); web matcher filtering tests.
