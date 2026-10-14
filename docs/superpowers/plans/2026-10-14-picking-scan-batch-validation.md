# Implementation plan — picking scan batch validation + verify scanned truth (2026-10-14)

Spec: `docs/superpowers/specs/2026-10-14-picking-scan-batch-validation-design.md`

## Backend (`apps/backend`)

1. `src/db/schema/picking.ts` — add `scannedDateCode`/`scannedLotCode`/`scannedCoo`/`scannedCow` text columns to `pickingPackages` (after `scannedWclItemNo`).
2. `pnpm --filter @warehouse/backend db:generate` → new migration SQL.
3. `src/routes/picking.ts` — `/picking-items/:id/scan` body: accept `scannedDateCode`/`scannedLotCode`/`scannedCoo`/`scannedCow`, pass through.
4. `src/db/picking.ts`:
   - `ScanPickingItemInput`: add the four scanned fields.
   - `scanPickingItem` package INSERT (~line 1408): store them.
   - `/shipping-boxes/:id/scan` package INSERT (~line 1658): store NULLs (add columns to the INSERT).
5. `src/db/verify.ts` `getVerifyTaskDetail` + `src/db/measuring.ts` `getMeasuringBoxDetail`: SELECT `pp.scanned_date_code AS "scannedDateCode"`, etc.; extend the row interfaces.
6. Tests: extend `src/db/picking.test.ts` — a scan storing scanned batch fields shows them on the verify/measuring package read.

## PDA (`apps/pda`)

7. `utils/wwyyDateCode.ts` (new): `compareWwyyDateCodes(a, b): 'equal' | 'earlier' | 'later' | null` — strict 4-digit WWYY (week 01–53), compare (2000+YY, WW).
8. `composables/usePickingScanQueue.ts`:
   - `checkDateCode(target, scanned)` / `checkLotCode(target, scanned)` helpers (normalizeCode for lot).
   - `addScan`: per portion, date check vs `lot?.dateCode ?? receiving?.dateCode`, lot check vs `lot?.lotCode`.
   - `addAllocationScan`: same checks against the chosen allocation.
   - `ScanQueueRow`: add `scannedDateCode`/`scannedLotCode`/`scannedCoo`/`scannedCow`; set from parsed values in both add functions, NULL in `addCartonScan`.
9. `pages/picking/scan/[id].vue` `confirm()`: send the four scanned fields in `scanPickingItem`.
10. `services/types.ts`: `ScanPickingItemInput` + the WarehouseService interface; `MeasuringPackage` gains `scannedDateCode`/`scannedLotCode`/`scannedCoo`/`scannedCow`.
11. `services/adapters/backendWarehouse.ts`: pass the four fields in the scan POST body (verify/measuring detail fetches are passthrough).
12. `utils/measuringAggregateMatch.ts`: effective pkg batch = `scanned ?? stored` in the eligibility filter; doc comment update.
13. i18n `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` under `picking.scanSession`: `date_code_newer`, `lot_code_mismatch`.
14. Tests:
    - `tests/wwyyDateCode.test.ts` (new).
    - `tests/measuringAggregateMatch.test.ts`: scanned-value preference + legacy fallback.
    - `tests/usePickingScanQueue.test.ts`: date later rejected, date earlier/equal ok, non-WWYY skipped, lot mismatch/missing rejected, no-source-lot passes.

## Docs

15. `AGENTS.md` — update the verify/measuring matching paragraph (scanned-truth anchoring) + picking scan validation.
16. `docs/app-docs/flows/` picking + verify `overview.md`/`ai-scope.md`, `ai/feature-registry.md` if needed.

## Verification

- `pnpm --filter @warehouse/backend build` + `pnpm --filter @warehouse/backend test`
- `pnpm --filter @warehouse/pda test` + `pnpm --filter @warehouse/pda build`
- `pnpm --filter @warehouse/pda nuxt prepare`
