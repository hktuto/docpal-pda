# Put-away carton scan — design

Date: 2026-11-10
Status: implemented

## Problem

Picking's scan page supports scanning a supplier **carton barcode** to pick
everything that carton holds in one go (`matchCartonAllocations` /
`addCartonScan` in `apps/pda/composables/usePickingScanQueue.ts`). Put-away
had no equivalent: the operator had to scan every item label of a sealed
supplier carton even though the carton's contents are declared on the
receiving invoice lines (`receiving_invoice_items.ctn_no`).

## Decision

Port the picking feature to put-away **client-side only**, mirroring picking's
shape: match the scanned raw against the order lines' `ctn_no`, then fan out
into the ordinary per-line write path. No new backend endpoint.

- **Match key:** `receiving_invoice_items.ctn_no`, projected onto the put-away
  aggregate's expected items as `ctnNo`
  (`getPutAwayAggregate`, `apps/backend/src/db/putaway.ts` — the one-line
  `rii.ctn_no AS "ctnNo"` add; `GET /put-away-tasks/:id` reuses the
  aggregate). The CN task detail already projected it.
- **Matcher** (`matchPutAwayCarton`, `apps/pda/utils/putAwayScan.ts`): exact
  case-insensitive match first, then containment (carton barcodes wrap the
  ctn_no — KOA carton `X273` scans as `TCX273`); ctn_no under 4 chars stays
  exact-only; only lines with `remainingQty > 0` match.
- **Routing order** in the detail page's hardware-scan handler stays
  label-first: shelf QR → `BOX-*` toast → supplier label parse + per-line
  match; only when no order line matches is the raw tried as a carton
  (a decodable label that matches an item always wins over a containment
  false-positive). Carton matching is order-wide — it ignores the armed
  item-first group (bulk operation, same as picking).
- **Standard mode** (`handleCartonScan`): a confirm prompt ("Put away all of
  carton X? N item(s), Q pcs") then one `POST
  /receiving-orders/:id/put-away-scans` per carton line at its full remaining
  qty, batch fields from the receiving declaration (same source as
  skip-scan), serial null. The carton barcode rides as `raw` on the **first**
  line only — the backend dedups `shelf_box_items.raw` per order
  (409 `label_already_scanned`). With a sticky shelf the pieces commit
  straight onto it; without one they land in the pending staging list and the
  next shelf scan commits them via the existing `selectShelf` prompt — the
  "scan carton → scan shelf" flow. A session `Set` of scanned carton raws
  rejects repeats with a duplicate toast (the backend raw dedup cannot catch
  it: only the first line carries the raw).
- **CN mode** (`handleCnCartonScan`): stages every carton line locally at full
  remaining qty (no server write until the batch confirm, per the CN model).
  Unlike CN per-item label scans (shelf-first), carton pieces may stage
  **shelf-less**; the next shelf scan claims them (`selectShelf` backfills
  `shelfCode` onto staged pieces that have none), and `commitCn` refuses to
  post while any staged piece still lacks a shelf (reuses
  `putAway.cn.shelfRequired`).

## Consequences

- Whole-carton put-away records no physical-label verification and no serial
  capture — same trade-off as skip-scan (2026-11-04) and picking's carton
  scan. The batch values come from the receiving declaration, not a scanned
  label.
- The scanner symbology whitelist (`useSupplierSymbologyScope`) still applies:
  a supplier whose carton barcode is a different symbology than its item
  labels (e.g. KOA Code128 carton vs PDF417 reels) needs that symbology in
  the profile's `barcode_types`, like picking.
- `BOX-*` scans remain rejected (`putAway.boxScanIgnored`) — this feature is
  about supplier carton numbers, not shelf boxes.
- i18n: `putAway.carton.{confirmPrompt,recorded,duplicate}` in en-US /
  zh-CN / zh-HK.

## Alternatives considered

- **Backend carton endpoint** (`POST .../put-away-carton`): rejected — picking
  proved the client-side fan-out works, the per-line guards
  (`scanned_qty_exceeds_remaining`, raw dedup) stay intact, and the CN flow
  (local staging + batch commit) could not use a single server call anyway.
- **Reuse `classifyPutAwayScan`** for routing: left alone — the detail page
  keeps its inline routing (the util predates the shelf-direct flow and is
  only kept for tests).

## Key files

- `apps/backend/src/db/putaway.ts` — `ctnNo` projection in
  `getPutAwayAggregate` (+ `PutAwayExpectedItemRow.ctnNo`).
- `apps/pda/utils/putAwayScan.ts` — `matchPutAwayCarton` (tests in
  `apps/pda/tests/putAwayScan.test.ts`).
- `apps/pda/pages/put-away/[id].vue` — carton fallback in the hardware-scan
  handler, `handleCartonScan` (standard), `handleCnCartonScan` + `raw` param
  on `handleCnItemScan` (CN), `selectShelf` shelf backfill, `commitCn` shelf
  guard, `cartonScannedRaws` session dedup.
- Picking reference: `apps/pda/composables/usePickingScanQueue.ts`
  (`matchCartonAllocations`, `addCartonScan`).
