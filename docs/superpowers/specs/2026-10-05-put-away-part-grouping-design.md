# Put-away detail: group same-part lines — design

Date: 2026-10-05

PDA put-away task detail (`apps/pda/pages/put-away/[id].vue`). When one
receiving order carries the same part on several invoice lines (e.g. line 1
qty 300 + line 2 qty 20000 — the upstream order splits it, but the physical
package does not), the operator sees two cards and a label whose qty spans
both lines cannot be put away at all: `findPutAwayTarget`
(`apps/pda/utils/putAwayScan.ts:45`) requires the scanned qty to fit a single
line's `remainingQty` (backend guard 409 `scanned_qty_exceeds_remaining` per
line, `apps/backend/src/db/putaway.ts:734-787`).

Same rationale as picking's scan queue (`usePickingScanQueue.findTargets`,
`apps/pda/composables/usePickingScanQueue.ts:92`): one label's qty may span
several order lines with the same part.

## Approach: client-side grouping, client-side FIFO split

The backend keeps one row per `receiving_invoice_items` line — batch-attr
backfill (`putaway.ts:753-761`), `inventory_lot_sources`, PUT_AWAY ledger
rows, and task auto-clear (`putaway.ts:187-200`) are all keyed on the line
id, and lines of one part may sit in different org/sub-inventory pairs. The
established picking pattern is adopted unchanged: **group in the client for
display; split writes FIFO across the group's lines**.

### 1. Display grouping

`utils/putAwayGroups.ts` (new) builds one `PutAwayItemGroup` per
`normalizePartNo(partNo)` from the visible items, in list order:

- identity: `partNo` / `wclItemNo` of the first member;
- qty fields **summed**: `lineQty` (null when any member is null),
  `receivedQty`, `putAwayQty`, `remainingQty`, staged qty (Σ per-line staged
  scans);
- catalog fields via `putAwayGroupFieldValue`: qty fields (`expected_qty`,
  `received_qty`, `remaining_qty`) are summed; batch/location fields
  (`date_code`, `lot_code`, `coo`, `cow`, `suggested_shelf`) render the
  **distinct values joined** across members (empty values excluded, all
  empty → the usual no-data dash); `po_no`/`box_id` stay no-data as today.

`PutAwayLotsPanel.vue` renders one card per group (single-member groups look
exactly like today's cards). Expanding a group lists its member lines, each
with its own per-line remaining + batch values and its own staged scans
(with the existing box-assignment controls) — per-line granularity is never
lost. Card scroll anchors use the group key (`data-item-id`).

### 2. FIFO scan split

`findPutAwayTargets(items, partNo, qty, wclItemNo?)` (new,
`utils/putAwayScan.ts`) consumes the scanned qty across the matching lines
in list order, each capped at its `remainingQty`, returning
`{ item, qty }[] | null` (null when the aggregate remaining cannot cover).
Every write path then records one `recordPutAwayScan` per portion, each
guarded by the existing per-line backend check:

- **Hardware/gun scan** (`[id].vue` onScan): armed mode scopes to the armed
  group's lines; free mode across all visible lines. One scan → N sequential
  per-line writes (same batch fields on each portion; the backend only
  backfills NULL line attrs, `putaway.ts:753-761`).
- **OCR review apply** (`useScanMatchers.matchPutAway`): the review context
  carries the group's member lines (new optional `putAwayItems` on
  `ScanTaskContext`; falls back to `[receivingItem]` for other callers).
  Validation compares against the group's aggregate remaining; `apply()`
  loops the portions sequentially.
- **Multi-item modal apply**: same split per row.

### 3. Arming

`armedItemId` becomes a **group key**. Tapping a card arms its whole group
(strict matching scoped to the group's lines); the auto-disarm check tests
group membership. Scan/arm/expand actions emit the group.

## Deliberate non-goals

- No backend change: endpoints, `put_away_tasks`, ledger, auto-clear all
  untouched; the per-line 409 guard stays the over-receipt control.
- No merging when batch fields differ — merging is unconditional per part;
  divergent batch values are shown distinct-joined and per-line detail stays
  available on expand. The scanned label's batch fields ride onto each
  portion and only NULL line attrs are backfilled (unchanged backend rule).
- Put-away list page, admin UI, label printing, goods-verify/measuring:
  unaffected (they work off `shelf_box_items` / `picking_packages`).

## Files

- `apps/pda/utils/putAwayScan.ts` — add `findPutAwayTargets` (keep
  `findPutAwayTarget` for the single-line tests).
- `apps/pda/utils/putAwayGroups.ts` — new: group type, `groupPutAwayItems`,
  `putAwayGroupFieldValue`.
- `apps/pda/components/put-away/PutAwayLotsPanel.vue` — group cards +
  per-member expanded detail.
- `apps/pda/pages/put-away/[id].vue` — groups computed, armed group key,
  split writes in gun scan, OCR context, multi-apply.
- `apps/pda/composables/useScanMatchers.ts` — `matchPutAway` takes member
  lines, aggregate validation, split apply.
- `apps/pda/tests/putAwayScan.test.ts` — extend with split cases.
