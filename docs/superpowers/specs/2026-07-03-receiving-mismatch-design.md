# Receiving mismatch reporting redesign

## Goal

Replace the single "mismatch" flag on receiving invoice items with a structured set of mismatch reasons so operators can clearly report damage, missing items, quantity issues, and related problems.

## Background

Currently `receiving_invoice_items` only has:

- `reportedMismatch` (boolean)
- `mismatchNote` (text)
- `receivedQty` (integer)

The UI exposes an "Actual qty" field and a note field. This is too coarse: it cannot distinguish between "not found", "damaged", "wrong part shipped", etc., and it does not record the event in a structured way.

## Requirements

- Support one mismatch reason per item line.
- Supported reasons:
  1. **Not found** — item was not in the shipment.
  2. **Damaged** — item is physically damaged; operator enters damaged quantity.
  3. **Quantity mismatch** — received a different quantity than expected; operator enters actual received quantity.
  4. **Wrong part shipped** — a different part was received; operator enters the wrong part number and quantity.
  5. **Over shipment** — more quantity received than expected; operator enters extra quantity.
  6. **Quality rejection** — item fails quality check; operator enters rejected quantity.
- Do not add new invoice lines for invoice-level issues (over shipment / wrong part). Report per existing item key and let the back office handle returns.
- Mismatch reporting is allowed both before confirming arrival and after the order is `in_hand`.
- After arrival, editing a mismatch is only allowed if the item has not been allocated, picked, or put away.
- The UI must show the specific reason on each reported item.
- Each mismatch save must leave an audit trail.

## Decision: Approach A — extend the item table

We will add a few columns to `receiving_invoice_items` and record change events in the existing `transition_logs` table.

Rationale:

- Minimal schema and code change in this proof-of-concept.
- Reuses existing audit infrastructure (`transition_logs`).
- One reason per item is enforced by a single `mismatchReason` column.

Alternative B (a dedicated `receiving_item_mismatches` table) was considered but deferred; it is the natural upgrade if richer reporting or history is needed later.

## Data model

### New columns on `receiving_invoice_items`

| Column | Type | Notes |
|--------|------|-------|
| `mismatchReason` | `text` with enum | `not_found`, `damaged`, `qty_mismatch`, `wrong_part`, `over_shipment`, `quality_rejection`, or `null` |
| `mismatchQty` | `integer` | Meaning depends on reason (see table below) |
| `wrongPartNo` | `text` | Only used when reason is `wrong_part` |

Existing columns stay:

- `reportedMismatch` boolean
- `mismatchNote` text
- `receivedQty` integer

### Quantity mapping

| Reason | `receivedQty` value | What `mismatchQty` stores |
|--------|---------------------|---------------------------|
| `not_found` | `0` | `null` |
| `damaged` | `qty - mismatchQty` | number of damaged pieces |
| `qty_mismatch` | `mismatchQty` | actual received quantity |
| `wrong_part` | `0` | quantity of wrong part received |
| `over_shipment` | `expected qty` | extra quantity received |
| `quality_rejection` | `qty - mismatchQty` | number of rejected pieces |

### Audit trail

On every mismatch save, insert one row into `transition_logs`:

- `entityType`: `'receiving_invoice_item'`
- `entityId`: the item id
- `fromState`: previous reason or `null`
- `toState`: new reason or `null`
- `actorId`: current user id
- `metadata`: JSON with `reason`, `mismatchQty`, `wrongPartNo`, `receivedQty`, `note`

## UI changes

### Receiving detail item card (`pages/receiving/[id].vue`)

Each item card shows:

- A **Report issue** button when no mismatch has been reported.
- An **Edit issue** button when a mismatch already exists.
- The read-only mismatch summary badge and note when a mismatch has been saved.
- A lock message: "Locked: stock already in use." when the item has been allocated, picked, or put away (button is hidden in this case).
- The existing red left border on `card--mismatch`.

Clicking **Report issue** or **Edit issue** opens `ReportIssueModal` for that item.

### Report issue modal (`components/ReportIssueModal.vue`)

The modal is a focused form with **Confirm** and **Cancel** buttons:

1. **Reason selector** — dropdown with the six reasons plus an empty "—" option.
2. **Conditional quantity input** — label and validation change by reason:
   - `not_found`: no quantity input.
   - `damaged`: "Damaged qty".
   - `qty_mismatch`: "Actual received qty".
   - `wrong_part`: "Wrong part qty" + "Wrong part number" text input.
   - `over_shipment`: "Extra qty".
   - `quality_rejection`: "Rejected qty".
3. **Note input** — free-text note.
4. **Inline validation errors** shown on Confirm if inputs are invalid.

When opened for editing, the modal is pre-filled with the item's current mismatch values. Cancel closes the modal without saving.

## Business rules

### Reporting flow

1. Operator selects reason and fills conditional fields.
2. App validates inputs and computes `receivedQty`.
3. App updates `receiving_invoice_items` with reason, qty, note, and computed `receivedQty`, setting `reportedMismatch = true`.
4. App inserts a `transition_logs` record.
5. Page reloads to reflect the new state.

### Validation

- `mismatchQty` must be a non-negative integer.
- `damaged` / `quality_rejection`: `mismatchQty` ≤ expected `qty`.
- `qty_mismatch`: `mismatchQty` ≥ 0.
- `over_shipment`: `mismatchQty` > 0.
- `wrong_part`: `mismatchQty` > 0 and `wrongPartNo` is non-empty.
- Computed `receivedQty` must not be negative.

### Removing / correcting a mismatch

- Selecting the empty reason and saving clears `reportedMismatch`, `mismatchReason`, `mismatchQty`, `wrongPartNo`, and `mismatchNote`, and resets `receivedQty` to expected `qty`.
- The same post-arrival guard applies.

### Post-arrival guard

Editing or removing a mismatch is blocked when:

```text
allocatedQty > 0 OR pickedQty > 0 OR putAwayQty > 0
```

This prevents changing inventory quantities after they have already been consumed by downstream flows.

### Arrival confirmation

The existing `confirmReceivingOrderArrived` logic continues to work:

```text
qtyToReceive = item.reportedMismatch ? item.receivedQty : item.qty
```

After confirmation, `allocatePendingPickingOrders()` runs and only allocates the corrected quantities.

## Error handling

- Inline validation errors appear next to the relevant field.
- Page-level errors continue to use the existing error banner.
- Post-arrival lock is communicated as read-only UI text, not as an error.

## Edge cases

| Scenario | Handling |
|----------|----------|
| Damage + short shipment on same line | One reason per line; operator picks the most relevant reason. Quantity mismatch can capture a lower received quantity without damage detail. |
| Over shipment | Only expected `qty` becomes available stock; extra qty is recorded as a discrepancy for back office. |
| Wrong part | Expected item `receivedQty` becomes 0; wrong part number and qty are stored in mismatch fields. No new inventory is created for the wrong part. |
| Mismatch reported after arrival | Allowed only while the item has no allocations, picks, or put-aways. |

## Migration note

PGlite in this demo has no migrations. The schema is created from `db/init.ts` when the `users` table does not exist. After changing the schema, developers and users must clear IndexedDB (`idb://warehouse-demo-pglite`) for the new columns to appear.

## Verification

- `pnpm nuxt prepare` — types generate without errors.
- Clear IndexedDB and reload the app.
- Manual browser tests:
  - Log in as `operator` / `DocPal2026!`.
  - Open a pending receiving order.
  - Report each mismatch reason and verify `receivedQty`, badge text, and transition logs.
  - Confirm arrival and verify allocations use the corrected quantities.
  - Open an `in_hand` order, allocate stock, and verify the mismatch form becomes read-only.

## Open questions / deferred

- Photo evidence for damage/quality issues is not in scope for this iteration.
- Dedicated mismatch reporting screen / dashboard is not in scope.
