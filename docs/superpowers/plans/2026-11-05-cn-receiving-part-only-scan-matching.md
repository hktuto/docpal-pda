# CN receiving scan — part-only matching (plan)

Spec: `docs/superpowers/specs/2026-11-05-cn-receiving-part-only-scan-matching-design.md`

## Steps

1. `apps/backend/src/db/receivingCnScan.ts` — `scanCnTaskAggregate`:
   - drop the `labelDateCode`/`labelCoo`/`labelCow` computations and the three
     batch-field filter clauses from `eligible`;
   - delete the now-unused `normalizeText`/`normalizeCode` helpers;
   - change the credited-line batch update from `COALESCE(col, value)` to
     direct overwrite (`col = value`) for `date_code`/`lot_code`/`coo`/`cow`;
   - update the doc comment to the part-only rule.
2. `apps/pda/utils/cnScanGroups.ts` — group key = normalized part identity
   only; group `dateCode`/`coo`/`cow` = distinct member-line values joined
   ` · ` (null when none); comment update.
3. `apps/pda/pages/receiving-cn-scan/[id].vue` — header comment only (group
   is now part-only).
4. Tests:
   - `apps/backend/src/routes/receivingCnScan.test.ts`: rewrite the
     batch-filter test (A4) to assert a conflicting date code still matches;
     rewrite the fill-only-NULL test (A8) to assert overwrite.
   - `apps/pda/utils/cnScanGroups.test.ts`: key on part only; distinct batch
     values in group display fields.
5. Docs: note the supersession in
   `docs/superpowers/specs/2026-11-04-cn-receiving-scan-grouping-design.md`;
   update the `scan-aggregate` row in `docs/backend/api-design.md`.

## Verify

- `pnpm --filter @warehouse/backend test` (needs the dev Postgres up).
- `pnpm --filter @warehouse/pda test`.
- `pnpm --filter @warehouse/backend build`.
