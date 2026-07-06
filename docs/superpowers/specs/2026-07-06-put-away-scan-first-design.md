# Put-away Scan-First Flow

## Problem

The current put-away flow forces the operator to create a shelf box first and then scan an item directly into that box. In practice a receiving item (e.g., 10,000 pcs) may arrive as multiple physical pieces (e.g., ten 1,000-pcs boxes). The operator needs to scan each piece individually, accumulate them under the receiving item, and only afterwards move whole pieces into shelf boxes.

## Goal

Change put-away so that scanning and boxing are two independent steps:

1. Scan physical pieces into a receiving item (pool of scans).
2. Scanned qty must be able to sum up to the item's total qty.
3. Create shelf boxes and manually assign whole scanned pieces to boxes.
4. Close boxes when done.

## Decision log

- **Approach:** Add a new `put_away_scans` detail table (Approach A). This mirrors the receiving-picking `picking_packages` pattern and gives every scanned piece its own identity.
- **Box contents summary:** Keep `shelf_box_items` as a box-level summary (one row per part/date/lot/COO/COW per box). The detail table drives the logic; the summary table drives the existing box display and goods-verify.
- **Inventory movement:** Happens at assignment time, not scan time. Scanning only records the piece; the receiving-area inventory is still available until the piece is boxed.
- **Assignment UI:** Mirror receiving picking — each unboxed scan has a box dropdown + "Add to box" + "Remove scan"; each boxed scan has "Remove from box".

## Data model changes

### New table: `put_away_scans`

```sql
CREATE TABLE put_away_scans (
  id TEXT PRIMARY KEY,
  receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id),
  qty INTEGER NOT NULL,
  date_code TEXT,
  lot_code TEXT,
  coo TEXT,
  cow TEXT,
  shelf_box_id TEXT REFERENCES shelf_boxes(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_put_away_scans_item ON put_away_scans(receiving_invoice_item_id);
CREATE INDEX idx_put_away_scans_box ON put_away_scans(shelf_box_id);
```

`shelf_box_id` is nullable. A null value means the piece is scanned but not yet boxed.

### Existing table: `shelf_box_items`

No schema change. It remains a materialized summary of boxed scans per part/date/lot/COO/COW per box. When scans are assigned or removed, the matching summary row is upserted or deleted so that its qty equals the sum of boxed scans with the same attributes.

## DB helpers

Add to `db/putAway.ts`:

- `recordPutAwayScan(db, receivingInvoiceItemId, qty, dateCode, lotCode, coo, cow, actorId)`
  - Insert a row into `put_away_scans` with `shelf_box_id = null`.
  - Validate `qty > 0` and integer.
  - Validate `qty <= remaining_qty`, where `remaining_qty = received_qty - picked_qty - allocated_qty - put_away_qty - unboxed_scanned_qty`. This prevents scanning more than is still available to put away.
- `assignScanToBox(db, scanId, boxId, actorId)`
  - Set `put_away_scans.shelf_box_id = boxId`.
  - Move qty into the shelf inventory lot (same logic as current `addItemToShelfBox`).
  - Increment `receiving_invoice_items.put_away_qty`.
  - Upsert `shelf_box_items` summary row.
- `removeScanFromBox(db, scanId, actorId)`
  - Clear `put_away_scans.shelf_box_id`.
  - Reverse inventory move from the shelf lot.
  - Decrement `receiving_invoice_items.put_away_qty`.
  - Update/delete `shelf_box_items` summary row.
- `removeScannedPiece(db, scanId, actorId)`
  - Delete the scan row only if `shelf_box_id IS NULL`.
- `getPutAwayScansForReceivingOrder(db, receivingOrderId)`
  - Return scans grouped by receiving invoice item id.
- `getPutAwayLots(db, receivingOrderId)`
  - Include total qty, scanned qty (sum of `put_away_scans.qty`), and boxed qty (sum of scans with `shelf_box_id IS NOT NULL`).
- Update `cancelShelfBox` to count `put_away_scans` with the box id instead of `shelf_box_items`.

## Scan matching

In `composables/useScanMatchers.ts`:

- Remove the `targetBoxId` requirement for put-away scanning.
- `matchPutAway(receivingItem, parsed)`:
  - Validate `part_no` matches.
  - Parse and validate `qty`.
  - Ensure `scanned_qty + qty <= receivingItem.total_qty`.
  - Return an apply function that calls `recordPutAwayScan(...)`.

In `pages/put-away/[id].vue`, update the scan call so it no longer passes `targetBoxId`.

## UI changes

### `components/put-away/PutAwayLotsPanel.vue`

Replace the current "select box then scan" UI with a receiving-picking-style list:

- For each receiving item show **Total / Scanned / Boxed** qty.
- A **Scan** button per item.
- Expand/collapse list of scanned pieces under the item.
- For each scan row:
  - Show qty, date_code, lot_code, coo, cow.
  - If unboxed: box-selection dropdown (open boxes only), **Add to box**, **Remove scan**.
  - If boxed: show box id, **Remove from box**.

### `components/put-away/ShelfBoxesPanel.vue`

Minimal changes. Box contents continue to come from `shelf_box_items`. New assignments/removals update the summary table, so the panel refreshes after `load()`.

### `pages/put-away/[id].vue`

- Remove `targetBoxSelections` state.
- Add `putAwayScans` state.
- Update `load()` to fetch scans and derive scanned/boxed totals.
- Add handlers:
  - `onScan(lot)` — opens scanner for the item.
  - `assignScan(scanId, boxId)` — calls `assignScanToBox`.
  - `removeScanFromBox(scanId)` — calls `removeScanFromBox`.
  - `removeScannedPiece(scanId)` — calls `removeScannedPiece`.
- Keep shelf box create/close/cancel handlers.

## Test label update

Update `/public/ocr-labels.html` so the put-away example label shows a piece qty that is a fraction of the total receiving item qty (e.g., 1/2 or 1/3 of the total). This lets us test scanning multiple pieces for one item.

## Error handling

Add i18n keys:

- `scanned_qty_exceeds_total`
- `put_away_scan_not_found`
- `put_away_scan_already_boxed`
- `put_away_scan_not_boxed`
- `cannot_remove_boxed_scan` (or reuse `put_away_scan_already_boxed`)

## Documentation

Update:

- `docs/app-docs/flows/put-away/overview.md`
- `docs/app-docs/flows/put-away/steps.md`
- `docs/app-docs/flows/put-away/ai-scope.md`
- `docs/app-docs/ai/feature-registry.md` and `docs/app-docs/ai/code-map.md` if file/feature mappings change.

## Testing

Add/update tests:

- `tests/scanMatchers.test.ts`: put-away scan matcher no longer requires `targetBoxId`; validates scanned qty against total.
- New or existing DB helper tests:
  - record scan within total qty,
  - reject scan that would exceed total qty,
  - assign scan to box updates inventory and summary,
  - remove scan from box reverses updates,
  - delete unboxed scan,
  - cannot cancel a box with assigned scans.

## Deployment note

This change modifies the database schema. Because the demo app has no migration system, users must clear the IndexedDB store after the new build is deployed.

## Files touched

- `db/schema.ts`
- `db/init.ts`
- `db/putAway.ts`
- `composables/useScanMatchers.ts`
- `pages/put-away/[id].vue`
- `components/put-away/PutAwayLotsPanel.vue`
- `components/put-away/ShelfBoxesPanel.vue` (minor)
- `i18n/locales/en-US.ts`, `zh-CN.ts`, `zh-HK.ts`
- `public/ocr-labels.html`
- `docs/app-docs/flows/put-away/*`
