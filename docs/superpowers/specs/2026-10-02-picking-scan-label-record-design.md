# Picking scan label record + verify re-scan — design

Date: 2026-10-02

## Problem

Picking scan splits one physical label across order lines/portions: a single
15,000-unit label against two lines of 7,500 produces two `picking_packages`
rows of 7,500 (`scanPickingItem`, `apps/backend/src/db/picking.ts:1235-1241`).
The raw scanned label string is held only in client memory (`ScanQueueRow.raw`,
`apps/web/composables/usePickingScanQueue.ts:16`) and never sent to the
backend — nothing ties the portions back to the physical label.

At verify, `matchMeasuring` (`apps/web/composables/useScanMatchers.ts:222`)
requires an exact qty match against a single unverified package. Re-scanning
the original 15,000 label can never match the two 7,500 rows, so the box can
never pass verification (`completeVerifyTask` 409 `packages_not_all_rescanned`,
`apps/backend/src/db/verify.ts:196-200`).

## Decision

Record the label, verify the label. Persist the raw scan string on every
`picking_packages` row created from that scan; at verify (and measuring) match
the re-scanned label string against stored strings and verify every package
carrying it in one shot. The backend verify endpoint stays a per-package flag
flip — no server-side matching logic.

Fallback keeps legacy data working: rows with no stored label (created before
this change, or camera/OCR scans which have no raw string) verify exactly as
today via the existing exact-qty match.

## Design

### Schema

- New nullable text column `label_barcode` on `picking_packages` — the raw
  scan string exactly as received from the scanner (no normalization).
- Migration via `pnpm --filter @warehouse/backend db:generate`; no backfill
  (NULL = legacy, uses fallback).

### Backend

- `POST /picking-items/:id/scan` (`apps/backend/src/routes/picking.ts:104-125`)
  body gains optional `barcode`; `scanPickingItem` writes it on every package
  row the call creates (all split portions of one label carry the same
  string).
- `POST /shipping-boxes/:id/scan` (`apps/backend/src/routes/picking.ts:217-228`)
  already receives the raw `barcode` and currently discards it after resolving
  the item — pass it through to the package rows it creates.
- `POST /picking-packages/:id/verify` (`apps/backend/src/db/picking.ts:1679-1731`)
  unchanged: the client calls it once per matched package.

### Web — picking scan

- `pages/picking/scan/[id].vue` confirm (`:586-596`) includes the queue row's
  `raw` as `barcode` in each portion's `scanPickingItem` call. Adapter +
  service types (`services/adapters/backendWarehouse.ts`, `services/types.ts`)
  gain the optional field.
- Camera/OCR path has no raw string → field omitted → NULL column → fallback.

### Web — verify / measuring

- `matchMeasuring` (`useScanMatchers.ts:188-237`) gains a label pass before
  the qty pass: if the raw scan string exactly equals the `labelBarcode` of
  any package in the box's unverified set (same matching candidate pool as
  today), return all matching packages as one result; `MeasureBox.vue` then
  calls `verifyPackage` per package and toasts "N items verified by label".
- Already-verified packages: re-scanning a verified label returns an
  informational "already verified" result, not an error.
- No label match → fall through to today's exact-qty match (covers legacy
  NULL rows and OCR-created packages). No sum-matching is introduced — the
  stored label makes it unnecessary and it would be ambiguous when a box
  mixes a 15,000 label with a separate 7,500 label of the same part.
- A label whose portions were boxed into multiple shipping boxes verifies
  per box: each box's verify only flags the packages belonging to that box.
- Shared with measuring: both modes use `matchMeasuring`, so both gain
  label matching automatically.

### i18n

New strings (en-US / zh-CN / zh-HK) for the verified-by-label toast and the
already-verified info.

## Files

- `apps/backend/src/db/schema/picking.ts` — `labelBarcode` column.
- `apps/backend/drizzle/00NN_*.sql` — generated migration.
- `apps/backend/src/routes/picking.ts` — `barcode` on both scan bodies.
- `apps/backend/src/db/picking.ts` — persist on package insert (both paths).
- `apps/web/services/types.ts` + `services/adapters/backendWarehouse.ts` —
  optional `barcode` on scan input.
- `apps/web/pages/picking/scan/[id].vue` — send `raw` on confirm.
- `apps/web/composables/useScanMatchers.ts` — label pass in `matchMeasuring`.
- `apps/web/components/MeasureBox.vue` — multi-package verify result handling.
- `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — new strings.
- Tests: `apps/web/tests/` — label-match, already-verified, legacy fallback
  cases; backend scan test asserting `label_barcode` persisted.
