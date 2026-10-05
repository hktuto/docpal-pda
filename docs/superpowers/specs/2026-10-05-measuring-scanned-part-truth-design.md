# Measuring shows the scanned part, not the allocated part (2026-10-05)

## Problem

After scanning items on the picking (packing) scan page, then opening measuring,
scanning the box and the item list, the operator sees the **allocated** item's
part (`picking_items.part_no`) — not the item they actually scanned. When the
physical label's part text differs in form from the order item's `part_no`
(e.g. the pick matched via the label's `wclItemNo` group, or the supplier label
prints a different part string that only matches space-insensitively), the
measuring re-scan of the same physical label fails to match and the list shows
a part the operator never scanned.

Root cause: `picking_packages` records the batch snapshot (`date_code`,
`lot_code`, `coo`, `cow`) and the raw `label_barcode`, but **no part identity**.
Every consumer (measuring detail, verify detail, the aggregate matcher) joins
`picking_items.part_no` — the demand side, i.e. the allocation's part.

Per the 2026-10-03 "picking scan truth" design, packages are the scan truth;
the part identity must follow the scan too.

## Design

### Store the scanned part keys on the package

Add two nullable text columns to `picking_packages`:

- `scanned_part_no` — the label's itemId group as scanned (verbatim).
- `scanned_wcl_item_no` — the label's wclItemNo group as scanned (verbatim).

Populated by `POST /picking-items/:id/scan` from new optional body fields
`scannedPartNo` / `scannedWclItemNo` (the PDA sends the parsed groups before it
normalizes them to the order item's part). NULL for legacy rows and paths
without a parsed label (carton claim prefill) — consumers fall back to the
picking item's part, today's behavior.

`POST /shipping-boxes/:id/scan` (server-side barcode = part match) records the
barcode itself as `scanned_part_no`.

### Consumers fall back to the item part

`GET /measuring-boxes/:id` and the verify-task detail package rows select:

- `partNo`: `COALESCE(pp.scanned_part_no, pi.part_no)`
- `wclItemNo`: `COALESCE(pp.scanned_wcl_item_no, p.wcl_item_no)` (existing
  `parts` join on `pi.part_no` stays the fallback source)

The net-weight formula join stays keyed on `pi.part_no` (the real part).

### Matcher accepts the package's WCL item no too

`matchAggregatePackages` (apps/pda/utils/measuringAggregateMatch.ts) currently
compares scanned keys against `pkg.partNo` only. It now compares against
**both** `pkg.partNo` and `pkg.wclItemNo` — this alone fixes matching for
legacy rows whose scan matched via the WCL group, and is consistent with the
picking-side matcher (`partMatches` in usePickingScanQueue.ts).

## Non-goals

- No backfill of legacy packages (raw `label_barcode` re-parsing is unreliable;
  fallback keeps today's behavior).
- The admin picking detail keeps showing packages under the order item — the
  item part is correct there.
- Shipping (post-completion) lists keep the item part.

## Files

- `apps/backend/src/db/schema/picking.ts` — new columns + migration
- `apps/backend/src/db/picking.ts` — `ScanPickingItemInput`, package insert,
  `scanIntoShippingBox` passthrough
- `apps/backend/src/routes/picking.ts` — body passthrough
- `apps/backend/src/db/measuring.ts`, `apps/backend/src/db/verify.ts` —
  COALESCE select
- `apps/pda/composables/usePickingScanQueue.ts` — queue rows carry the scanned
  keys (`addScan`, `addAllocationScan`; carton scans record the item's own keys)
- `apps/pda/pages/picking/scan/[id].vue` — confirm() sends the scanned keys
- `apps/pda/services/types.ts`, `apps/pda/services/adapters/backendWarehouse.ts`
  — input fields
- `apps/pda/utils/measuringAggregateMatch.ts` — match `partNo` + `wclItemNo`
