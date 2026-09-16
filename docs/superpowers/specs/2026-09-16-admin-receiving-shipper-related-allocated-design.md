# Admin receiving shipper — related-order allocated qty cell (design)

Amends `2026-09-14-admin-receiving-shipper-download-design.md` (which
superseded `2026-09-07-admin-receiving-picking-list-design.md`).

## Problem

The live shipper prints the **recommended put-away shelf** on each part
group's order-ref row (column B for single-carton blocks, Total Qty column
for merged blocks). In practice this cell is not useful on the shipper:

- The suggestion ranking (`computeItemShelfSuggestions` in
  `src/db/putaway.ts`) matches `inventory_lots.part_no`, but real stock lots
  carry their identity in `wcl_item_no` (`part_no` empty), so rules 1–2
  never match and every group falls back to rule 3 — the first shelf
  alphabetically tagged with the item's sub-inventory (e.g. `AO21` for every
  group of `BATCH-2026-09-10-000202`). The cell then carries no information.
- What the warehouse user actually wants at the top of each item group is
  the quantity side of the picture: **how much of this part is already
  allocated to the picking orders this receiving order feeds**.

## Decision

Replace the shelf-suggestion cell with the **related-order allocated qty**
per part group. The header row keeps its `Shelf` label (user decision —
keeps the printed sheet's column layout familiar).

### Definitions

- **Related picking order**: a picking order with at least one row in
  `allocations` tracing back to this receiving order — either
  `allocations.receiving_order_id = :id` (whole-order source) or
  `allocations.receiving_invoice_item_id` → its invoice's
  `receiving_order_id = :id` (per-carton source). Same linkage the PDA
  `GET /receiving-orders/:id` uses to embed related picking orders.
- **Related-order allocated qty (per part group)**: `SUM(allocations.qty)`
  over all allocation rows whose picking item belongs to a related picking
  order AND whose demand part matches the group's part key, **regardless of
  the allocation's source** (stock lot, this receiving order, or another
  receiving order). This answers "of the related orders' demand for this
  part, how much is already secured". Demand-part matching uses the same
  part-key rule as the whole-order slot matching: `picking_items.part_no =
  group item's part_no OR wcl_item_no`.
- Blank when the sum is 0 (group has no related-order allocations).

### Placement and modes

- Same seat the shelf code had: the group's order-ref row
  (`rows[height - 2]`), column B for single-carton blocks, the Total Qty
  column (index 3) for merged multi-carton blocks. Rendered as a number
  (the sheet's existing `#,##0` numeric format applies).
- Live mode only — finished mode (`?mode=finished`) has no such cell today
  and is unchanged.
- One extra read-only query per download; the route stays free of any
  in-request recompute.

### Consequences

- `computeItemShelfSuggestions` / `putAwayConfig` are no longer used by the
  shipper route. The put-away flows (PDA put-away detail, put-away task
  detail) keep their shelf suggestions untouched.
- The `part_no`-vs-`wcl_item_no` matching gap in
  `computeItemShelfSuggestions` (root cause of the AO21-everywhere symptom)
  is NOT fixed here — the shipper no longer shows a shelf at all. Fixing the
  suggestion ranking for the put-away UIs is a separate change.
- Slot columns, Total/Balance, `(order-level)` closing blocks: unchanged.

## Test plan

- Update the live-mode merged-block expectations: group header cell shows
  the related-order allocated sum (order-level-only group: 200; merged
  2-carton group: 2500).
- Reallocate test: after `POST .../reallocate` picks up the new demand, the
  cell reflects the new sum (3000).
- New test: an allocation sourced from a stock lot on a related order is
  counted (+50), while an allocation on an unrelated picking order (no
  allocation tracing to this receiving order) is not counted.
- Finished mode: unchanged expectations.
