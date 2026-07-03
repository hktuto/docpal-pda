# Picking order issue reporting

## Goal

Give warehouse workers a way to report when one or more picking orders cannot be fulfilled as planned, and lock those orders so no more picking work happens until the office resolves the issue.

## Background

Currently a picking item has only a free-text "Report mismatch note" that writes to `transition_logs`. It does not change the order status, does not record a structured reason, and does not prevent further picking.

The new feature must support three reported scenarios:

1. **Insufficient stock** — the requested quantity cannot be picked because not enough stock is available.
2. **Cannot divide quantity** — the requested quantity cannot be satisfied because the item ships in fixed pack sizes (e.g. order asks for 10k, item is supplied as 20k per pack).
3. **Merge request** — because of pack-size constraints, two or more picking orders need to be merged; the PDA only reports this, it does not create the merged order.

A generic **other** reason is also supported for issues that do not fit the three main categories.

## Requirements

- Reporting starts from the picking order list page. The worker selects one or more orders and taps **Report issue**.
- All selected orders share the same issue reason and common details, but each order can carry its own per-order remark.
- Supported reasons: `insufficient_stock`, `cannot_divide`, `merge`, `other`.
- Reason-specific captured fields:
  - `insufficient_stock` — actual quantity the worker was able to find.
  - `cannot_divide` — the pack size and the requested quantity (pre-filled from the order total).
  - `merge` / `other` — no extra structured fields; note and per-order remark only.
- When an issue is reported the order status changes to `issue` and all picking actions (scan, add to box, finish) are disabled.
- Once reported, the issue cannot be edited or undone on the PDA; an office user must resolve it.
- Each issue report must leave an audit trail in `transition_logs`.

## Decision: Approach A — extend `picking_orders`

We will add structured issue columns directly to `picking_orders` and record the event in the existing `transition_logs` table.

Rationale:

- Minimal schema and code change in this proof-of-concept.
- Reuses existing audit infrastructure (`transition_logs`).
- Mirrors the receiving mismatch design pattern.
- One reason per order is sufficient for the current demo scope.

A dedicated `picking_order_issue_reports` table (Approach B) would be the natural upgrade if the system later needs multiple separate reports per order or an approval workflow.

## Data model

### `picking_orders` status enum

Expand from:

```text
pending | picking | finished
```

to:

```text
pending | picking | finished | issue
```

### New columns on `picking_orders`

| Column | Type | Notes |
|--------|------|-------|
| `issue_reason` | `text` enum or `null` | `insufficient_stock`, `cannot_divide`, `merge`, `other` |
| `issue_qty` | `numeric` or `null` | Actual available qty when reason is `insufficient_stock` |
| `issue_pack_size` | `numeric` or `null` | Pack size when reason is `cannot_divide` |
| `issue_note` | `text` or `null` | Common note applied to all selected orders |
| `issue_remark` | `text` or `null` | Per-order remark |
| `issue_reported_at` | `timestamp` or `null` | When the issue was reported |
| `issue_reported_by` | `integer` (user id) or `null` | Worker who reported it |

Existing `status`, `ref_no`, `supplier_id`, etc. columns stay unchanged.

### Audit trail

On every issue report, insert one `transition_logs` row per affected picking order:

- `entity_type`: `'picking_order'`
- `entity_id`: the order id
- `from_state`: the previous status (`pending` or `picking`)
- `to_state`: `'issue'`
- `actor_id`: current user id
- `metadata`: JSON containing `issue_reason`, `issue_qty`, `issue_pack_size`, `issue_note`, `issue_remark`

## UI changes

### Picking order list page (`pages/picking/index.vue`)

1. Add a checkbox to each picking order card. Finished orders and orders already in `issue` status have a disabled checkbox.
2. When at least one selectable order is checked, show a bottom action bar with:
   - Selected count, e.g. "2 selected"
   - A **Report issue** button (red/destructive style)
3. Tapping **Report issue** opens the report modal.

### Report issue modal (new component)

A full-screen or bottom-sheet modal with:

1. **Issue reason** selector:
   - Insufficient stock
   - Cannot divide quantity
   - Merge orders
   - Other
2. Conditional detail fields:
   - `insufficient_stock` → number input **Actual qty available**.
   - `cannot_divide` → number input **Pack size**. The order's requested quantity is shown read-only in the per-order remark block for confirmation.
   - `merge` / `other` → no extra fields.
3. **Per-order remarks** section. For each selected order show:
   - Order ref
   - Text input for a per-order remark (optional)
4. **Common note** textarea (optional), applied to all selected orders.
5. **Cancel** and **Save issue** buttons.

### Picking order detail page (`pages/picking/[id].vue`)

When an order has `status = issue`:

- Show a red `issue` status badge. The list can reuse the existing `.badge--mismatch` style or add a new `.badge--issue` class.
- Show an issue summary card with:
  - Reason (human-readable)
  - `issue_qty` or `issue_pack_size` when relevant
  - `issue_remark`
  - `issue_note`
  - Reporter and timestamp
- Disable picking actions: **Scan**, **Add to box**, **Finish picking**.
- Keep the existing item list visible in a read-only state.

## Business rules

### Reporting flow

1. Worker selects one or more orders on the list.
2. Worker taps **Report issue**.
3. Worker chooses a reason and fills conditional/common fields.
4. Worker optionally adds a per-order remark for each selected order.
5. App validates inputs.
6. App updates each selected order:
   - `status = 'issue'`
   - fill the `issue_*` columns
   - set `issue_reported_at` and `issue_reported_by`
7. App inserts a `transition_logs` row for each order.
8. Modal closes and the list reloads.

### Validation

- At least one order must be selected.
- Only orders in `pending` or `picking` status can be reported. Finished or already-issued orders are excluded/skipped.
- `merge` reason requires at least two selected orders.
- `insufficient_stock`: `issue_qty` is required and must be ≥ 0 and < the order's total requested quantity.
- `cannot_divide`: `issue_pack_size` is required and must be > 0.
- `other`: `issue_note` or at least one `issue_remark` is required (so the report is not empty).

### Locking after report

- Orders with `status = issue` are excluded from scanning, boxing, finishing, and allocation updates.
- The existing `finishPickingOrder` and auto-finish logic must ignore or reject orders in `issue` status.

### Multi-select details

- Reason, `issue_qty`, `issue_pack_size`, and `issue_note` are copied to every selected order.
- `issue_remark` is stored per order from the individual remark input.
- If the selected orders have different requested quantities and the reason is `cannot_divide`, the **Requested qty** field shows the value for each order separately in the per-order remark block, or the modal pre-fills the field with the first selected order's quantity and relies on the per-order area for corrections. For the demo, pre-fill from the first selected order and let the worker add per-order remarks if quantities differ.

## Error handling

- Inline validation errors appear next to the relevant field.
- If the database update fails, the modal stays open, no order statuses change, and a page-level error banner shows the message.
- If some selected orders are invalid (e.g. one is finished), the save proceeds for the valid orders and the UI shows a summary: "2 issues reported; 1 order skipped because it was already finished."

## Edge cases

| Scenario | Handling |
|----------|----------|
| Worker selects a finished order | Checkbox disabled; if somehow included, it is skipped on save. |
| Worker selects an order already in `issue` | Treated as finished — skipped on save. |
| Worker selects only one order for `merge` | Validation error: "Select at least two orders to request a merge." |
| Database error mid-save | Wrap in transaction if possible; otherwise leave all orders unchanged and show error. |
| Reason changed before save | Conditional fields hide/show; previously entered values are kept but not validated until save. |

## Migration note

PGlite in this demo has no migrations. The schema is created from `db/init.ts` when the `users` table does not exist. After changing the schema, developers and users must clear IndexedDB (`idb://warehouse-demo-pglite`) for the new columns and `issue` status to appear.

## Verification

- `pnpm nuxt prepare` — types generate without errors.
- Clear IndexedDB and reload the app.
- Manual browser tests:
  - Log in as `operator` / `DocPal2026!`.
  - Open the picking list, select one order, and report `insufficient_stock` with an actual qty.
  - Verify the order shows the `issue` badge, detail page shows the summary, and picking actions are disabled.
  - Select two orders, choose `merge`, and verify both orders move to `issue` with a shared note and per-order remarks.
  - Try reporting on a finished order and confirm it is skipped.
  - Check `transition_logs` contains one row per reported order.

## Coordination note

Another implementation plan is in progress at `docs/superpowers/plans/2026-07-03-receiving-mismatch.md`. The picking issue implementation plan will use a separate filename so the two can be reviewed and scheduled independently.

## Open questions / deferred

- Resolving or re-activating an issue report is not in PDA scope; the office workflow is out of scope for this iteration.
- Photo evidence or barcode capture for issue reports is not in scope.
- A dedicated issue-review dashboard is not in scope.
