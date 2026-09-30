# Picking scan: cross-line split + same-part item merge — design

Date: 2026-09-30

## Problem

A picking order may carry several line items with the same `part_no` (separate
upstream Oracle lines). The scan session validated a scanned label qty against
each line individually: `findTargets` (`apps/web/composables/usePickingScanQueue.ts`)
built portions per line and, when one line could not cover the whole qty,
discarded them and restarted against the next line with the full qty.

Real case: order has two lines of `abc123`, qty 10000 and 20000 (total 30000).
The physical stock arrives as packages of 5000 + 25000. The 25000 package
matches neither line alone, so the scan was rejected with `no_match` even
though the order total covers it.

## Decision

Split, don't relax. A scanned qty that exceeds one line's open quantity is
consumed FIFO across all same-part lines (list order, then allocation order
within a line, net of already-queued qty), producing one queue portion per
(line, allocation) touched. Confirm already posts one `POST
/picking-items/:id/scan` per portion, and the backend keeps its strict per-line
cap (`scan_qty_exceeds_required`) as a safety net — each portion is within its
line's remaining qty, so the backend needs **no change**. Relaxing the cap to
order+part level was rejected: all per-line bookkeeping (`picked_qty`,
allocation status, order auto-finish) compares per-line Σ packages to per-line
qty, so an over-sized single-line package would strand the sibling line.

If the qty exceeds the total open qty of all same-part lines, the scan is
still rejected with `no_match` (genuine mismatch).

## Web changes

### `usePickingScanQueue.ts`

- `findTargets` now returns `{ item, allocation, qty }[] | null` — portions
  accumulated across every `partMatches` item until the qty is covered; null
  when the aggregated remaining cannot cover it.
- `addScan` creates one queue row per portion with that portion's item id.
- The "pick from box" path (`addAllocationScan`) stays allocation-scoped by
  design (the dialog is per-box/per-allocation).

### `pages/picking/scan/[id].vue`

Same-part lines are merged for display:

- Progress card: one row per part (grouped by normalized `part_no`), with
  required/scanned/queued summed across the lines, distinct line/shipment
  numbers joined, and allocation-source hints concatenated.
- Queue table: `displayRows` groups by normalized part + batch fields
  (lot/date/coo/cow) instead of item id, so the portions of one cross-line
  label render as a single row; removal still drops every portion of the
  label.

Backend, schema, API: unchanged. Tests: update the fallthrough regression and
add cross-line split / over-total rejection cases in
`apps/web/tests/usePickingScanQueue.test.ts`.
