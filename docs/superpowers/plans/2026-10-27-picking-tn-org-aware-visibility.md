# TN picking orders: org-aware visibility — plan

Spec: `docs/superpowers/specs/2026-10-27-picking-tn-org-aware-visibility-design.md`

1. `apps/backend/src/db/picking.ts` — rewrite the `tn` branch of
   `pickingOrderOrgFilter`: unscoped or 143-covering scope keeps the static
   `typeCol = 'tn'`; otherwise a per-row condition
   `(typeCol = 'tn' AND (orgCol IS NULL OR orgCol IN (scopeOrgIds)))`
   (`inArray` is already imported). Update the header comment.
2. `apps/backend/src/db/user-scope.test.ts` — update the
   "picking visibility splits by picking_order_type" test:
   - add a `tn` fixture on org 220 (`THTH1`);
   - scope `(2, STORE1)` now also sees the org-2 `tn` order;
   - scope `(220, THTH1)` sees the org-220 `tn` order but not org-2/143 ones;
   - a 143 scope still sees ALL `tn` orders; unscoped unchanged;
   - detail-read assertions updated to match.
3. `docs/app-docs/flows/picking/ai-scope.md` — update the
   `pickingOrderOrgFilter` paragraph.
4. Verify: `pnpm --filter @warehouse/backend exec tsx --test --test-force-exit src/db/user-scope.test.ts src/db/picking.test.ts`
   then the full `pnpm --filter @warehouse/backend test` and
   `pnpm --filter @warehouse/backend build` (typecheck).
