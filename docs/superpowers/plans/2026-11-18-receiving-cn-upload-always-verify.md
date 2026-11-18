# Plan — CN receiving upload always lands on verify/edit (2026-11-18)

Spec: `docs/superpowers/specs/2026-11-18-receiving-cn-upload-always-verify-design.md`

## Steps

1. `apps/admin/pages/receiving-cn/new.vue`
   - Rename `gateAndAutoCreate` → `gateDrafts` (it gates, nothing more).
   - Collapse the three exits (error / invalid-qty / clean auto-create) into
     one: set banners, then `step.value = 2` always. Remove the
     `invalidQtySeen` flag and the trailing `submitExcelDrafts()` call.
   - Refresh the header + function comments to say "always verify".
2. Docs: add this spec; add the plan; adjust
   `docs/app-docs/flows/receiving/ai-scope.md` (the excel path no longer
   auto-creates clean sheets; the verify/edit screen is mandatory).
3. UAT: add `docs/uat/features/CR-063.json` and regenerate
   `UAT-Test-Tracking.xlsx` (`node scripts/gen-uat-xlsx.mjs`).
4. Verify: `pnpm --filter @warehouse/admin test` + `nuxt prepare`.
5. Commit.

## Notes

- Backend: no change. `cnDraftToEntry` and `POST /admin/receiving-cn/excel`
  untouched.
- Part 2 of the session (box-scan driven CN put-away) is designed separately
  once the box QR template arrives — it touches
  `apps/backend/src/db/putawayCn.ts` + the PDA put-away pages, not this
  upload flow.
