# Picking Scan Record — one scan = one line, aggregate fulfillment

Date: 2026-11-19
Status: draft
Companion: `2026-11-19-picking-scan-truth-record-design.md` (decode/scanned
fields; this spec assumes it ships).

## Problem

Incident: SZ order `01a1f182-06c2-7319-b8d4-06b9c66fcba8`
(VMI-VMAX20261123-1). The operator scanned **56 reels** (net 42,000 pcs =
56 × 750; `inventory_transactions` on_hand PICK shows 142 pick events and 83
undo reversals netting to exactly that). But `picking_packages` holds **59
rows**: three reels (`…0530`, `…0547`, `…0554`) were each recorded as two
partial lines (250 + 500) because a scan is bound to a single
`picking_item` and its remaining open demand, so a reel that over-runs a
line boundary gets chopped.

Requested model: **the scan record reflects physical reality — one scan of a
whole reel = one line.** Line-item fulfillment is a derived match, not a
constraint on the record. As long as the total scanned qty per part covers
the order demand, the order completes; the system must not split scans to
make individual lines add up.

## Current architecture

- `picking_packages.picking_item_id` is NOT NULL, FK → `picking_items`
  (ON DELETE CASCADE). Every scan (`POST /picking-items/:id/scan`) takes an
  `allocationId` + `qty` and inserts exactly one package row per call.
- The PDA scan screen pre-fills qty from the line's remaining open demand —
  that is what forces the 500/250 split today.
- Undo = `DELETE /packages/:id` (deletes the row, reverses the ledger).
- Consumers of `picking_packages.picking_item_id`: order detail grouping
  (`db/picking.ts` ~1371), verify tasks (`db/verify.ts`), measuring
  (`db/measuring.ts`), put-back (`put_back_task_items.picking_package_id`,
  cancel-invoice cron `cancelInvoice.ts` ~167), shipping-box item rollups
  (`shipping_box_items.picking_item_id`), label printing
  (`labelPrintParams`), the pick-scan Excel (`apps/admin/utils/
  pickingScanExcel.ts` iterates `item.packages`).

## Design

### 1. Package rows become order-scoped, not item-scoped

- New nullable `picking_packages.picking_item_id` (drop the NOT NULL; keep
  the FK for rows that do map cleanly to one item). New NOT NULL
  `picking_part_no` (the part actually scanned) so a row can exist before
  item matching. Raw `label_barcode` + decoded `scanned_*` fields unchanged
  (companion spec).
- `POST /picking-items/:id/scan` keeps working (backward compatible: it
  creates an item-bound row when the scan fits within one line's open
  demand), but a new unified scan path records the reel as ONE row:
  - `POST /picking-orders/:id/scan-reel` (name TBD): body = part identity
    (decoded) + qty (whole reel) + optional target shipping box. No
    allocationId, no item binding.
- The PDA scan screen stops pre-filling a line-bounded qty for reel-style
  parts; it scans → decodes → records one row with the reel's own qty.

### 2. Derived line fulfillment (the "match" step)

Line status becomes a computed mapping, mirroring the verify/measuring
aggregate design:

- For each part number, total scanned qty (sum of package rows) must be ≥
  total open demand of the order's lines for that part.
- Consumption mapping (package rows → line items) is computed FIFO in
  allocation priority order, capped at each line's `qty`. Stored nowhere as
  a constraint — computed where item-level data is needed:
  - **Ledger** (`inventory_transactions`) keeps booking per item: at
    commit/finish, split each package's qty across lines for the ledger rows
    only. The package row itself is never split.
  - **Allocation reconciliation** at finish: `picked_qty` on
    `picking_items` = derived consumed qty; `allocations` netting unchanged.
  - `shipping_box_items` rollup likewise derives per-item contents at
    close/ship time.
- Derived allocation mapping (package rows → line items) is computed FIFO
  in allocation priority order, capped at each line's `qty`. Since scanned
  totals never exceed demand (scan-time room check, section 3), every
  scanned qty is fully consumed by lines.

### 3. Scan-time room check (replaces the surplus decision)

No surplus is accepted — the record never exceeds the order's need:

- The aggregate scan validates **per part, not per line**:
  1. part identity matches one of the order's open lines (normalized part
     match, same rule as the verify aggregate match);
  2. `sum(qty of already-scanned rows for this part) + scan qty ≤ total
     demand of the order's open lines for this part` — over this, reject
     with a clear `no_room_for_part` error showing the remaining room.
- Because the guard is per-part, the operator can scan reels in any order
  and any grouping — a 750 reel can cover a 500 line + the next line's 250
  without being split; the record stays one row qty 750.
- Edge case: remaining room smaller than the smallest physical unit (e.g.
  room 500, reels are 750). The scan is rejected — the operator escalates
  (admin re-allocates or the order is corrected). This is deliberate: the
  system does not invent a fake 250 line to absorb the remainder.
- Completion check unchanged: `total scanned ≥ total demand` per part;
  shortage blocks finishing.
- Over-pick flag dropped — with the room check there is no over-pick
  state.

### 4. Undo / put-back semantics

- `DELETE /packages/:id` undoes one reel = one row (cleaner than today).
- Put-back rows (`put_back_task_items`) reference the package — unchanged,
  now the row is the physical reel so a cancel-invoice put-back puts back
  whole reels, which matches reality.

### 5. Consumers to update

- `db/picking.ts` order detail: group packages by part at order level; item
  cards get a derived `packages` view (consumption mapping) for
  compatibility.
- `db/verify.ts` / `db/measuring.ts`: already aggregate — switch their
  package source from item-keyed to order+part-keyed.
- Pick-scan Excel: iterate `order.packages` (one row per scan) instead of
  nested `item.packages`.
- Label printing (`labelPrintParams`): per-item params derived from the
  consumption mapping.
- Admin picking list detail page (`apps/admin/pages/picking-orders/[id].vue`):
  scan-record section shows the flat 56-line list.

## Rollout / compatibility

- Gate behind flow-config (e.g. `pickingScanRecord: "aggregate" |
  "item"`, default `item` until SZ is migrated) — per the multi-warehouse
  rule: config, not branches.
- Old item-bound rows keep reading correctly under both modes.
- Migration: backfill `picking_part_no` from the joined item's `part_no`.

## Verification

- Test reproducing the incident: order demanding 42,000 (whole reels),
  scan 56 reels → 56 package rows, order finishable, ledger books
  −42,000, scan Excel shows 56 lines.
- Test the room-check path: demand 500 total, scan one 750 reel →
  rejected with `no_room_for_part` (remaining room 500); demand 750×N and
  scan N reels + one extra → the extra rejected.
- Test undo: delete one reel row → ledger reversal +750, order short again.
- Existing suite (`picking.test.ts` etc.) passes under both config modes.

## Open questions

1. Endpoint shape for the aggregate scan (new route vs extending the
   existing one with `allocationId` optional).
2. Whether partial-reel demands (non-750 multiples) should steer the
   operator to a matching reel at scan time (warning, not block).
3. `shipping_box_items` generation timing (at box close vs at finish).
