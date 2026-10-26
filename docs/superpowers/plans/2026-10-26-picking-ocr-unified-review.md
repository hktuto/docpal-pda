# Picking OCR unified item review — implementation plan

Date: 2026-10-26

Spec: `docs/superpowers/specs/2026-10-26-picking-ocr-unified-review-design.md`

1. Add a picking draft parser in `apps/pda/utils/parseOcrScan.ts`.
   - Add an optional minimum-match-score argument to the existing line extractor without changing its default for other flows.
   - Return whole-label parsing for fewer than two strong rows.
   - For multiple strong rows, parse full fields per line and merge whole-label candidates as fallbacks.
   - Add focused cases to `apps/pda/tests/parseOcrScan.test.ts`.
2. Rework `apps/pda/components/picking/PickingScanReviewModal.vue` into full-form item cards.
   - Support draft items, per-item options/results, add, remove, retake, per-item errors and successful-item locking.
   - Reuse `CandidateChips` and `CountrySelect`; add the new Add item translation to all three locales.
3. Rewire only `apps/pda/pages/picking/unified/[id].vue` to the unified modal.
   - Remove its separate multi-review state and shared multi-modal import.
   - Submit complete `OcrInput` rows with stable-row-id duplicate keys and retain immediate auto-apply.
4. Remove the deprecated scan page and stale references.
   - Delete `apps/pda/pages/picking/scan/[id].vue`.
   - Point the legacy detail Scan action at the unified page.
   - Remove `/picking/scan/:id` from `usePickingWorkLock` and replace its route-specific test.
5. Update `docs/app-docs/flows/picking/{overview,steps,label-scan,ai-scope}.md`, `docs/app-docs/ai/code-map.md` and `docs/app-docs/ai/feature-registry.md` to describe the unified review and deleted route.
6. Verify with `pnpm --filter @warehouse/pda test`, `pnpm --filter @warehouse/pda nuxt prepare`, and `pnpm --filter @warehouse/pda build`. Exercise real browser capture/review/apply calls if the local backend and authentication are available; otherwise report that limitation explicitly.
