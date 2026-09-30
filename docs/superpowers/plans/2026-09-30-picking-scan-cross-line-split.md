# Picking scan cross-line split — implementation plan

Spec: `docs/superpowers/specs/2026-09-30-picking-scan-cross-line-split-design.md`

1. `apps/web/composables/usePickingScanQueue.ts`
   - Rewrite `findTargets` to accumulate `{ item, allocation, qty }` portions
     across all same-part items (list order; FIFO across each item's
     allocations; net of `queuedQtyForAllocation`); return null if the
     aggregated remaining cannot cover the qty. Update its doc comment.
   - `addScan`: one row per portion using `portion.item.id` / `portion.item.partNo`.
2. `apps/web/pages/picking/scan/[id].vue`
   - Add a `partGroups` computed grouping `order.items` by `normalizePartNo(partNo)`;
     render the progress card from it (summed required/scanned/queued, joined
     line/shipment numbers, concatenated allocation sources/warnings).
   - `displayRows`: group key = `normalizePartNo(row.partNo)` + batch fields;
     resolve `wclItemNo` by part lookup.
3. `apps/web/tests/usePickingScanQueue.test.ts`
   - Add: cross-line split test (3500 across 3000+1000 lines → 2000/1000/500
     portions); over-total rejection (4001 → `no_match`).
   - Existing fallthrough test (first line fully queued) still passes unchanged.
4. Verify: `pnpm --filter @warehouse/web test`, `pnpm --filter @warehouse/web nuxt prepare`.
5. Docs: update `docs/app-docs/flows/picking/ai-scope.md` scan-session paragraph.
