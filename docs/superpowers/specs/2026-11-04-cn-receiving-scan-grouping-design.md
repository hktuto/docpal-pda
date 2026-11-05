# CN Receiving Scan — Aggregate Group Matching — Design Spec

Date: 2026-11-04
Supersedes the per-line matching half of `2026-11-01-cn-receiving-scan-design.md` (the task model, statuses, finalize→put-away pipeline are unchanged except where noted).

> **Amended 2026-11-05** by `2026-11-05-cn-receiving-part-only-scan-matching-design.md`:
> the batch-field parts of this spec are reversed — grouping/matching is
> **part-number-only** (dateCode/COO/COW no longer join the group key nor
> filter `scan-aggregate` candidates), and scanned batch fields **overwrite**
> the invoice line instead of fill-if-NULL, because the OCR batch fields are
> untrustworthy. FIFO credit, over-scan, flag/reset, finalize below are
> unchanged.

## Problem

`pages/receiving-cn-scan/[id].vue` renders one row per `receiving_invoice_items_cn` line and resolves exactly one whole line per scan. When several open lines share a part (common: same part split across PO lines / cartons), the operator is forced into the "Choose the matching item" modal for every scan, and there is no way to see "we ordered 1,000 of X, scanned 600, 400 missing" until finalize.

## Goal

Group lines by **(part, date code, COO, COW)** into one scannable row. The operator scans physical labels; each scan credits the matching group's running total (FIFO across its lines). The chooser modal is removed entirely — a scan never asks the operator to pick a line. Group rows show `scanned / ordered` so missing quantities are visible at a glance.

## Grouping

- Group key: `normalizePartKey(wclItemNo || partNo) | norm(dateCode) | norm(coo) | norm(cow)`, null fields normalized to `""` (nulls group together). Client-side util `apps/pda/utils/cnScanGroups.ts` (`buildCnScanGroups(items)`), mirroring `verifyDisplayGroups.ts`.
- Display per group: part (`wclItemNo || partNo`, with `partNo` as secondary), dateCode/COO/COW chips when present, summed `scanQty / lineQty`, status badge, PO numbers of member lines.
- Group status: `error` if any member line is flagged; `complete` when summed scanQty ≥ summed lineQty (all lineQty known); `over` when scanQty > lineQty; `partial` when 0 < scanQty < lineQty; otherwise open.
- Header progress switches from resolved-line count to quantities: total scanQty / total lineQty.

## Scan routing (server-side, new endpoint)

Client matching is replaced by a new aggregate endpoint so the server owns matching + credit in one transaction:

```
POST /receiving-cn/scan-tasks/:id/scan-aggregate
{ itemId?, wclItemNo?, partNo?, qty: positive int,
  dateCode?, lotCode?, coo?, cow?, raw? }
→ 200 CnScanTaskDetail (full refreshed detail, same shape as GET)
```

Matching inside the tx (`apps/backend/src/db/receivingCnScan.ts`):

1. Candidates = the task's **open** lines: `scan_status IS NULL` (flagged `error` lines and resolved `ok`/`warning` lines are skipped). A line may be open with `scan_qty > 0` (partially credited — new state).
2. Part match: normalized part-key equality, any cross combination of label `itemId`/`wclItemNo` vs line `partNo`/`wclItemNo` — same convention as `findCnScanMatches` (space/case-insensitive, TE `AMP(...)` unwrap); port/reuse the backend's existing normalization (backend scan-parse matcher already shares this convention).
3. Batch-field filter (the verify/measuring rule): for each of `dateCode`/`coo`/`cow` **present on the label**, keep lines whose field is NULL **or** normalized-equal to the label value. A label carrying none of these fields matches all part-matching lines. If the filter empties the candidate set → 404 `no_matching_item` (no part-only fallback when the label *has* a conflicting batch value — that is genuinely different stock).
4. Credit FIFO in `po_no, po_line, id` order: each line takes `min(remaining, lineQty - scanQty)`. Note credit may flow across display groups when the label lacks discriminating batch fields — that is intended; group totals just update.
   - `lineQty NULL` lines (OCR gap) are credited last and absorb the remainder.
5. Line status after credit: `scan_qty >= line_qty` → `ok`; a line that absorbs **over-scan** (`scan_qty > line_qty`) or an unverifiable NULL-lineQty credit → `warning` / `qty_mismatch`; a partially credited line stays open (`scan_status NULL`, accumulated `scan_qty`).
6. Over-scan beyond all candidates' capacity: dump the excess into the last credited line (→ `warning`/`qty_mismatch`) and return `overQty` in a response header field of the detail payload (e.g. `{ ...detail, lastScan: { overQty } }` or a small envelope) so the PDA can toast "over-received N".
7. Provided batch fields overwrite the credited lines' `date_code/lot_code/coo/cow` only where the line value is NULL (first scan fills the blank; later conflicting values must not rewrite — they would have been filtered out in step 3 anyway for dateCode/coo/cow; lotCode is not a group key and follows the same fill-only-if-null rule).
8. Audit + SSE: `transaction_logs` row per existing convention; publish the same events as `scanCnItem` (`/receiving-cn-scan-tasks`, `/admin/receiving-cn` topics).

Duplicate-raw rejection stays client-side (session `Set` in the page) as today.

The old per-item `POST …/items/:itemId/scan` endpoint is removed (the PDA is its only caller); `flag` and `reset` per item stay (group actions loop them client-side).

## Flag / reset at group level

- **Reset group**: client loops `resetCnItemScan` over the group's touched lines (scanQty > 0 or status set). Endpoint unchanged — it must also clear a partial `scan_qty` back to NULL.
- **Flag group**: client loops `flagCnItem` over the group's open lines with the chosen reason/note. Per-line flagging disappears from the UI.

## Finalize change

`finalizeCnScanTask` currently sets `received_qty = scan_qty` for `ok` lines and 0 for everything else. Under aggregate matching a partially credited line is normal, so:

- `received_qty = min(scan_qty, line_qty)` for any line with `scan_qty > 0` that is not flagged `error` (NULL `line_qty` → `scan_qty`).
- Flagged (`error`) lines → 0; untouched open lines → 0 (missing, via `unresolvedAs: 'missing'` as today; 409 while open lines remain, unchanged).

## PDA page changes (`pages/receiving-cn-scan/[id].vue`)

- Render groups from `buildCnScanGroups(items)` instead of the flat line list; delete the chooser modal, `pendingScan`, `chooseItem`, and the `findCnScanMatches` call.
- Scan handler: parse → require part identity + qty as today → `warehouse.scanCnTaskAggregate(taskId, {...})` → replace `detail` with the response → toast on `no_matching_item` / over-received.
- Group row actions: flag / reset (group-level loops above). Member-line expansion is out of scope (admin console still shows per-line outcomes).
- Types: `CnScanAggregateInput` in `services/types.ts`; adapter method in `services/adapters/backendWarehouse.ts` (+ `WarehouseService` passthrough).
- i18n: new `receivingScan.*` keys (group qty line, over-received toast, group flag/reset labels); drop chooser keys; all three locales in `layers/i18n/i18n/locales/`.
- Vitest: `cnScanGroups` grouping/status/aggregation tests; update/remove `cnReceivingScan` tests as the util's role changes.

## Out of scope

- Admin console per-line outcome display (unchanged; it already renders `scan_status`/`scan_qty` per line).
- Persisting scanned `raw` server-side for cross-session duplicate detection.
- Undo of a single scan within a group (reset is whole-group).
