# Picking scan batch-field validation + verify against scanned truth (2026-10-14)

## Problem

A label scanned during **picking** is accepted with only part identity + COO/COW
checked (`usePickingScanQueue.addScan` / `addAllocationScan`). The package row
then stores the **source lot's** `date_code`/`lot_code`/`coo`/`cow` (source wins,
`apps/backend/src/db/picking.ts` `scanPickingItem`), while the label's own parsed
values are only a fallback and are discarded when the source has a value.

At **verify** (and measuring), the aggregate matcher
(`apps/pda/utils/measuringAggregateMatch.ts`) compares the re-scanned label's
batch fields against those stored source values whenever both sides carry a
value. The label's lot code (e.g. KOA segment 5, `1625H713`) and the upstream
lot's `lot_code` (e.g. `1806L801`) often come from different vocabularies, so a
correct re-scan of the very same reel fails with "no match".

## Decision

Two changes, agreed with the operator:

1. **Validate batch fields at picking scan time.** The operator learns about a
   data mismatch at the moment they can still fix it, not at verify.
2. **Store the scanned label's batch fields on the package and match verify
   re-scans against them.** Verify answers "did the operator re-scan the same
   physical item that was picked", anchored to pick-time truth instead of
   upstream stock data.

## Rule set

### Picking scan (PDA `usePickingScanQueue`, both `addScan` and `addAllocationScan`)

After the existing part + COO/COW checks, per matched allocation portion:

- **dateCode** — compared against the source's date code
  (`allocation.lot?.dateCode ?? allocation.receiving?.dateCode`). The scanned
  date code must be **equal or earlier** than the source's. "Earlier" means the
  physical reel is older than stock records say — tolerable; "later" is the
  suspicious direction and is rejected with `date_code_newer`.
  Comparison is parsed WWYY (`compareWwyyDateCodes`, year-then-week numerically;
  two-digit years are 2000-based). When either side is not valid WWYY, the
  check is skipped (never blocks on an unknown format).
- **lotCode** — **hard match** when the source carries one
  (`allocation.lot?.lotCode`; receiving-area allocations expose no lot code on
  the DTO, so the check simply does not apply there). Both sides are compared
  via `normalizeCode` (uppercase + OCR digit substitutions). A scanned lot code
  that is missing or different is rejected with `lot_code_mismatch` — even when
  the mismatch is upstream-data vocabulary (label segment 5 vs lot record),
  because that is a data problem the warehouse wants surfaced at pick time.
- Scanned values are recorded on the queue row (`scannedDateCode`,
  `scannedLotCode`, `scannedCoo`, `scannedCow`) and sent with the
  `POST /picking-items/:id/scan` body. Whole-carton scans (`addCartonScan`)
  carry no label — scanned fields stay NULL.

### Backend

- `picking_packages` gains four nullable columns: `scanned_date_code`,
  `scanned_lot_code`, `scanned_coo`, `scanned_cow` — the pick-time parsed label
  values, verbatim, alongside the existing source-snapshot columns. The
  `/shipping-boxes/:id/scan` package path stores NULLs (no parsed label there).
- `POST /picking-items/:id/scan` body accepts `scannedDateCode`,
  `scannedLotCode`, `scannedCoo`, `scannedCow`.
- The measuring (`getMeasuringBoxDetail`) and verify (`getVerifyTaskDetail`)
  package reads return the four scanned fields.

### Verify / measuring match (`matchAggregatePackages`)

The package's effective batch fields become **scanned value when present,
stored source value as fallback** (`pkg.scannedDateCode ?? pkg.dateCode`, etc.).
Part identity and the both-sides-present comparison rule are unchanged, so
legacy packages (NULL scanned fields) behave exactly as today and remain
verifiable.

The dead `matchPicking` matcher in `useScanMatchers.ts` (no live caller —
the scan session validates via `usePickingScanQueue`) is left untouched.

## Out of scope

- `resolveScannedShelfLot` (require-* shelf-scan modes) still exact-matches
  `il.date_code = input.dateCode` server-side; unchanged.
- Server-side validation of the batch fields at pick time — matching stays
  client-side per the 2026-10-03 aggregate design; the backend keeps storing
  whatever the client sends.
- Receiving-source lot code enforcement: the allocation DTO exposes no
  `lotCode`/`coo`/`cow` for receiving-area sources, so only the date-code
  check can apply there.

## Error surface

New `picking.scanSession` i18n keys (en-US / zh-CN / zh-HK):
`date_code_newer`, `lot_code_mismatch` — toasted by the scan session page via
its existing `t('picking.scanSession.' + message)` path.
