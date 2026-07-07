# Receiving mismatch approval + schema consolidation

## Goal

1. Separate receiving item mismatches from `receiving_invoice_items` so a second user must confirm or cancel every reported mismatch.
2. Reduce table count by removing dead summary tables and merging redundant ones.

## Background

- `receiving_invoice_items` currently stores mismatch state in columns (`reportedMismatch`, `mismatchReason`, `mismatchQty`, `wrongPartNo`, `mismatchNote`).
- The previous mismatch redesign (2026-07-03) noted that a dedicated table was the natural next step if richer reporting or approval was needed.
- `shipping_box_items` is deprecated and no code writes to it.
- `shelf_box_items` is a summary table that can be derived from `put_away_scans`.
- There are 19 tables in the current schema; several are genuinely needed for allocation traceability, audit, and workflow separation.

## Requirements

- Any user **except the reporter** can confirm or cancel a pending mismatch.
- A pending mismatch immediately reduces the effective received quantity.
- A confirmed mismatch is final.
- A cancelled mismatch reverts the effective received quantity to the original expected quantity.
- Cancellation is blocked if the item has already been allocated, picked, or put away beyond the mismatch-adjusted quantity.
- Reporting or editing a mismatch is blocked if the resulting quantity would be below already-consumed stock.
- Keep full mismatch history (who reported, confirmed, cancelled, when, and why).
- Remove `shipping_box_items`.
- Merge `shelf_box_items` into `put_away_scans` by adding verification state to each scan.

## Decision: Option B — dedicated mismatch table + focused consolidation

We will:

- Create `receiving_item_mismatches` with status and actor tracking.
- Remove `shipping_box_items`.
- Add `verified` / `verifiedAt` to `put_away_scans` and remove `shelf_box_items`.
- Leave `inventory_lot_sources`, `transition_logs`, `measuring_tasks`, and `allocations` unchanged because they serve real purposes (lineage, audit, measuring workflow, many-to-many allocation).

Rationale: it directly supports the approval workflow, removes dead weight, and collapses one redundant summary table without touching core data-model boundaries.

## Data model

### New table: `receiving_item_mismatches`

```sql
CREATE TABLE IF NOT EXISTS receiving_item_mismatches (
  id TEXT PRIMARY KEY,
  receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  mismatch_qty INTEGER,
  wrong_part_no TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  effective_received_qty INTEGER NOT NULL,
  previous_received_qty INTEGER NOT NULL,
  reported_by TEXT REFERENCES users(id),
  reported_at TIMESTAMP NOT NULL,
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TIMESTAMP,
  cancelled_by TEXT REFERENCES users(id),
  cancelled_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_receiving_item_mismatches_item ON receiving_item_mismatches(receiving_invoice_item_id);
CREATE INDEX IF NOT EXISTS idx_receiving_item_mismatches_status ON receiving_item_mismatches(status);
```

Drizzle:

```ts
export const mismatchStatuses = ["pending", "confirmed", "cancelled"] as const;

export const receivingItemMismatches = pgTable("receiving_item_mismatches", {
  id: text("id").primaryKey(),
  receivingInvoiceItemId: text("receiving_invoice_item_id")
    .notNull()
    .references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
  reason: text("reason", { enum: mismatchReasons }).notNull(),
  mismatchQty: integer("mismatch_qty"),
  wrongPartNo: text("wrong_part_no"),
  note: text("note"),
  status: text("status", { enum: mismatchStatuses }).notNull().default("pending"),
  effectiveReceivedQty: integer("effective_received_qty").notNull(),
  previousReceivedQty: integer("previous_received_qty").notNull(),
  reportedBy: text("reported_by").references(() => users.id),
  reportedAt: timestamp("reported_at").notNull(),
  confirmedBy: text("confirmed_by").references(() => users.id),
  confirmedAt: timestamp("confirmed_at"),
  cancelledBy: text("cancelled_by").references(() => users.id),
  cancelledAt: timestamp("cancelled_at"),
});
```

`effective_received_qty` stores the computed received quantity at report time. `previous_received_qty` stores `received_qty` before the mismatch was applied so cancellation can revert exactly, regardless of whether the receiving order was pending (`received_qty` was `0`) or in-hand (`received_qty` was the expected quantity).

### Modified table: `receiving_invoice_items`

Remove the mismatch columns. The table now only tracks physical movement quantities:

```sql
CREATE TABLE IF NOT EXISTS receiving_invoice_items (
  id TEXT PRIMARY KEY,
  receiving_invoice_id TEXT NOT NULL REFERENCES receiving_invoices(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id),
  po_no TEXT,
  po_line TEXT,
  qty INTEGER NOT NULL,
  received_qty INTEGER NOT NULL DEFAULT 0,
  picked_qty INTEGER NOT NULL DEFAULT 0,
  put_away_qty INTEGER NOT NULL DEFAULT 0,
  box_id TEXT,
  date_code TEXT,
  lot_code TEXT,
  coo TEXT,
  cow TEXT
);
```

### Modified table: `put_away_scans`

Add verification state:

```sql
CREATE TABLE IF NOT EXISTS put_away_scans (
  id TEXT PRIMARY KEY,
  receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id),
  qty INTEGER NOT NULL,
  date_code TEXT,
  lot_code TEXT,
  coo TEXT,
  cow TEXT,
  shelf_box_id TEXT REFERENCES shelf_boxes(id) ON DELETE CASCADE,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL
);
```

### Removed table: `shipping_box_items`

Drop the table, its indexes, its Drizzle definition, and its relation from `shelfBoxesRelations`.

### Relations update

- `receivingInvoiceItemsRelations`: add `mismatches: many(receivingItemMismatches)`.
- `receivingItemMismatchesRelations`: one-to-one to `receivingInvoiceItem` and `reportedBy`/`confirmedBy`/`cancelledBy` users.
- `shelfBoxesRelations`: remove `items: many(shelfBoxItems)`; add `putAwayScans: many(putAwayScans)` if not already present (it already is).
- Remove `shelfBoxItemsRelations`.

## Mismatch lifecycle

### States

- `pending` — reported, quantity applied immediately, awaiting second-user action.
- `confirmed` — approved by another user; final.
- `cancelled` — rejected by another user; quantity reverted.

### Allowed transitions

| From | To | Actor | Effect on `received_qty` |
|------|----|-------|--------------------------|
| (none) | `pending` | reporter | set to `effective_received_qty` |
| `pending` | `pending` | reporter | recalculate and update `received_qty` |
| `pending` | `confirmed` | any user except reporter | no quantity change |
| `pending` | `cancelled` | any user except reporter | revert to `previous_received_qty` |

### Guards

- **Report:** allowed only if there is no active `confirmed` mismatch for the item, and `effective_received_qty >= picked_qty + put_away_qty + allocated_qty`. A confirmed mismatch is final, so no further mismatch can be reported for the same item.
- **Edit:** allowed only by the reporter, while status is `pending`, and only if `effective_received_qty >= picked_qty + put_away_qty + allocated_qty`.
- **Cancel:** allowed by any user except the reporter, only while status is `pending`, and only if `previous_received_qty >= picked_qty + put_away_qty + allocated_qty`. This prevents cancellation from leaving `received_qty` below already-consumed stock.
- **Confirm:** allowed by any user except the reporter, only while status is `pending`; no quantity guard is needed.

### Quantity mapping

Same semantics as today; `effective_received_qty` is computed from the expected `qty`, reason, and `mismatch_qty`:

| Reason | `effective_received_qty` | What `mismatch_qty` stores |
|--------|--------------------------|---------------------------|
| `not_found` | `0` | `null` |
| `damaged` | `qty - mismatch_qty` | damaged pieces |
| `qty_mismatch` | `mismatch_qty` | actual received quantity |
| `wrong_part` | `0` | quantity of wrong part |
| `over_shipment` | `qty` | extra quantity |
| `quality_rejection` | `qty - mismatch_qty` | rejected pieces |

## Impacted files

| File | Change |
|------|--------|
| `db/schema.ts` | Add `receivingItemMismatches`; remove mismatch columns from `receivingInvoiceItems`; remove `shippingBoxItems`; add `verified`/`verifiedAt` to `putAwayScans`; update relations. |
| `db/init.ts` | Mirror schema changes in raw SQL. |
| `db/mismatch.ts` | New file with mismatch CRUD, guards, validation, and quantity computation. |
| `db/receiving.ts` | Remove old mismatch helpers; update `confirmReceivingOrderArrived` to read active mismatches. |
| `db/putAway.ts` | Remove `shelf_box_items` reads/writes; aggregate `put_away_scans` for box detail. |
| `db/picking.ts` | Remove `shipping_box_items` emptiness check in `cancelShippingBox`. |
| `db/goodsVerify.ts` | Compute shelf-box items from scans; verify scans instead of `shelf_box_items`. |
| `db/seed.ts` | Remove mismatch columns and `shelfBoxItems` seed rows; optionally seed sample mismatches. |
| `components/receiving/types.ts` | Add mismatch field to `DisplayReceivingItem`. |
| `components/receiving/ReceivingItemsTab.vue` | Show mismatch status badges and confirm/cancel/edit actions. |
| `components/ReportIssueModal.vue` | Call new mismatch helpers for report/edit. |
| `pages/receiving/[id].vue` | Load active mismatches and wire confirm/cancel handlers. |
| `i18n/locales/*.json` | Add strings for pending/confirmed/cancelled states and action buttons. |
| `tests/mismatch.test.ts` | New test file. |
| `tests/putAway.test.ts` | Update for removed `shelf_box_items`. |

## DB helper changes

### New file: `db/mismatch.ts`

Move mismatch-specific logic here from `db/receiving.ts`:

- `computeReceivedQty(expectedQty, reason, mismatchQty)`
- `validateMismatchInputs(expectedQty, reason, mismatchQty, wrongPartNo)`
- `reportReceivingItemMismatch(db, receivingInvoiceItemId, actorId, reason, mismatchQty, wrongPartNo, note)`
- `editReceivingItemMismatch(db, mismatchId, actorId, reason, mismatchQty, wrongPartNo, note)`
- `confirmReceivingItemMismatch(db, mismatchId, actorId)`
- `cancelReceivingItemMismatch(db, mismatchId, actorId)`
- `getActiveMismatchForItem(db, receivingInvoiceItemId)` — returns the latest non-`cancelled` record, or `null`.
- `getActiveMismatchesForItems(db, itemIds)` — batch version for detail pages.
- `assertCanApplyMismatchQty(dbOrTx, receivingInvoiceItemId, effectiveReceivedQty)` — shared guard.

Each save inserts a `transition_logs` row with `entityType = 'receiving_item_mismatch'`.

### Updated: `db/receiving.ts`

- Remove `computeReceivedQty` and `validateMismatchInputs` (moved to `db/mismatch.ts`).
- Remove `updateReceivingItemMismatch` and `canEditReceivingItemMismatch`.
- Update `confirmReceivingOrderArrived` to use active mismatches instead of `reportedMismatch`:

  ```ts
  const activeMismatches = await getActiveMismatchesForItems(tx, itemIds);
  for (const item of invoice.items) {
    const mismatch = activeMismatches.get(item.id);
    const qtyToReceive = mismatch ? mismatch.effectiveReceivedQty : item.qty;
    if (qtyToReceive <= 0) continue;
    await tx.update(receivingInvoiceItems)
      .set({ receivedQty: qtyToReceive })
      .where(eq(receivingInvoiceItems.id, item.id));
  }
  ```

- `tryMarkReceivingOrderClear` and `tryMarkReceivingOrderInHand` already operate on `received_qty`, so no change is needed beyond removing references to deleted mismatch columns.

### Updated: `db/putAway.ts`

- Replace `shelf_box_items` writes with `put_away_scans` updates.
- In `assignScanToBox`, after updating `inventory_lots` and `inventory_lot_sources`, set `verified = false` (already default) on the scan; do not create a `shelf_box_items` row.
- In `removeScanFromBox`, clear `verified`/`verifiedAt` if the scan had been verified.
- Update `getShelfBoxesForReceivingOrder` to aggregate scans instead of reading `shelf_box_items`.

### Updated: `db/picking.ts`

- In `cancelShippingBox`, remove the `shipping_box_items` emptiness check; only check `picking_packages`.

### Updated: `db/goodsVerify.ts`

- `getShelfBoxesByShelf`: compute item count and verified count from `put_away_scans` (grouped by `part_id`, so each distinct part is one item):

  ```sql
  WITH box_items AS (
    SELECT shelf_box_id, part_id, bool_and(verified) AS fully_verified
    FROM put_away_scans
    GROUP BY shelf_box_id, part_id
  ),
  last_checks AS (
    SELECT shelf_box_id, MAX(verified_at) AS last_check_at
    FROM put_away_scans
    GROUP BY shelf_box_id
  )
  SELECT sb.id, sb.shelf_code, sb.status, sb.created_at,
         COUNT(bi.part_id) AS item_count,
         COUNT(CASE WHEN bi.fully_verified THEN 1 END) AS verified_count,
         lc.last_check_at
  FROM shelf_boxes sb
  LEFT JOIN box_items bi ON bi.shelf_box_id = sb.id
  LEFT JOIN last_checks lc ON lc.shelf_box_id = sb.id
  WHERE sb.shelf_code = ?
  GROUP BY sb.id, sb.shelf_code, sb.status, sb.created_at, lc.last_check_at;
  ```

- `getShelfBoxDetail`: return aggregated scan rows as items, grouped by `part_id`.
- Replace `verifyShelfBoxItem(shelfBoxItemId)` with `verifyShelfBoxScans(shelfBoxId, partId)`:

  ```sql
  UPDATE put_away_scans
  SET verified = TRUE, verified_at = NOW()
  WHERE shelf_box_id = ? AND part_id = ?;
  ```

- `markShelfBoxVerified` checks that `bool_and(verified)` is true for all scans in the box.

## UI changes

### Receiving detail item card (`components/receiving/ReceivingItemsTab.vue`)

- If no active mismatch: show **Report issue** button (same as today).
- If active mismatch is `pending`:
  - Show status badge "Pending confirmation" with reason summary.
  - Show reporter name and reported time.
  - If current user is **not** the reporter: show **Confirm** and **Cancel** buttons.
  - If current user **is** the reporter: show **Edit** button (only while pending).
- If active mismatch is `confirmed`: show "Confirmed" badge with reason summary and confirmer name.
- Lock message when the item is in use and the action would violate the guard.

### Report issue modal (`components/ReportIssueModal.vue`)

- Keep the same reason/qty/note form.
- When editing a pending mismatch, pre-fill from the active mismatch and call `editReceivingItemMismatch`.
- When reporting a new mismatch, call `reportReceivingItemMismatch`.

### New small component: `MismatchActions.vue` (optional)

Inline confirm/cancel/edit buttons used by `ReceivingItemsTab.vue`. Only create if it keeps the tab file small.

## Migration and seeding

- `plugins/pglite.client.ts` currently creates PGlite in-memory (`new PGlite()`), so the database is recreated on every page load. There is no migration step; updating `db/init.ts` and `db/schema.ts` is enough for the new schema to appear on the next load.
- The leftover `DATA_DIR = "idb://warehouse-demo-pglite"` constant in `plugins/pglite.client.ts` is unused and can be removed as a tiny cleanup.
- `AppHeader.vue` still calls `indexedDB.deleteDatabase("/pglite/warehouse-demo-pglite")` on reset. This is harmless for the in-memory setup but may become relevant if the project switches back to IndexedDB later; leave it for now.
- Update `db/seed.ts`:
  - Remove mismatch columns from seeded `receivingInvoiceItems`.
  - Replace `shelfBoxItems` seed inserts with equivalent `putAwayScans` rows.
  - Optionally seed one pending mismatch and one confirmed mismatch for manual testing.

## Verification

1. `pnpm nuxt prepare` — types generate without errors.
2. `cd android && ./gradlew :app:testDebugUnitTest` — Android unit tests pass (no Java changes expected).
3. Clear IndexedDB and reload.
4. Manual browser tests:
   - Log in as operator.
   - Open a pending receiving order, report a mismatch, verify `received_qty` and badge show pending.
   - Log in as a different user, confirm the mismatch, verify badge shows confirmed.
   - Report another mismatch, allocate the reduced stock, then try to cancel and verify it is blocked.
   - Verify put-away scan → goods verify → mark verified still works end-to-end.
5. New unit tests:
   - `tests/mismatch.test.ts` covering report, edit, confirm, cancel, guards, and arrival confirmation.
   - Update `tests/putAway.test.ts` for the `shelf_box_items` removal.

## Open questions / deferred

- Photo evidence for damage/quality issues is out of scope.
- Bulk mismatch approval screen is out of scope.
- Notification to supervisors that a mismatch is pending is out of scope.
