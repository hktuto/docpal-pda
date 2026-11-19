# Plan — CN numbering warehouse prefix (2026-11-19)

Spec: `docs/superpowers/specs/2026-11-19-cn-numbering-warehouse-prefix-design.md`

## Steps

1. `apps/backend/src/db/receivingCn.ts`
   - Add `cnNumberPrefix()` (`WAREHOUSE_CODE` uppercased, `[A-Z0-9]`
     sanitizer, `HK` fallback).
   - `nextCnBrandedNo`: sanitize `brand` inside; prefix
     `[WH]-[brand]-[ymd]-`; lock key + `split_part(…, 4)` + prefix-built
     regex.
   - `nextCnTruckNo`: candidates prefixed; lock key prefixed.
   - `generateCnBatchNo` untouched (random correlation key).
2. `apps/backend/src/routes/receivingCn.test.ts`
   - `/^KOA-…$/` → `/^HK-KOA-…$/` (two places); ymd slice 4→7;
     race-test regex + seq `split("-")[3]`.
   - New test: `WAREHOUSE_CODE=sz` ⇒ `SZ-TE-20260115-01/02`, legacy
     unprefixed row does not seed the sequence; env restored in `finally`.
3. Docs: new spec + this plan; `docs/backend/api-design.md` format mentions
   updated (lines ~214, ~515).
4. UAT: `docs/uat/features/CR-065.json`; regenerate
   `UAT-Test-Tracking.xlsx` (`node scripts/gen-uat-xlsx.mjs`).
5. Verify: `pnpm --filter @warehouse/backend build` +
   `tsx --test src/routes/receivingCn.test.ts` (9/9).
6. Commit.

## Notes

- No DB migration; old rows keep their shape, the prefixed namespace starts
  fresh per warehouse.
- Deploy note: no env change needed — `WAREHOUSE_CODE` is already set on
  the SZ/SH/BJ instances (seed + org map); HK instances run without it and
  fall back to `HK`.
