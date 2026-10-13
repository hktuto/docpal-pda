# Picking unified detail page — implementation plan

Spec: `docs/superpowers/specs/2026-10-12-picking-unified-detail-scan-design.md`

Parallel build: the unified page is served from `/picking/unified/:id`; the
current detail + scan pages stay untouched until the user validates the flow
(swap stage = spec §8, separate change).

1. View-config knob — backend `apps/backend/src/config.ts`
   - `PdaDetailViewConfig` gains `collapsedStyle: "allocations" | "fields"`.
   - `defaultPdaViewConfig()`: `pickingDetail.collapsedStyle = "allocations"`.
   - Detail-section validation branch: accept `collapsedStyle` for all three
     detail sections, validate against `["allocations", "fields"]` (unknown →
     the existing `unknown key`/literal error).
2. View-config knob — mirrors
   - `apps/pda/utils/viewConfig.ts`: interface, `PdaDetailCollapsedStyle`
     type, default; `apps/admin/utils/viewConfig.ts`: same mirror.
   - `apps/admin/pages/pda-view-config.vue`: `collapsedStyle` select in the
     pickingDetail section (both locales labels via existing admin i18n).
3. Helpers — `apps/pda/utils/formatNumber.ts`
   - Export `formatCompactQtyUpper` (uppercase suffixes `3K / 1.4M / 2B`);
     keep `formatCompactQty` as-is for existing callers.
4. Session composable — NEW `apps/pda/composables/usePickingScanSession.ts`
   - Wrap `usePickingScanQueue(orderItems)`; expose `rows`, `queuedCount`,
     shelf context (`pendingShelf`, `setPendingShelfFromMatch`),
     `shelfStockChecker`, box-pick state (`boxPickId` + entries), carton
     queueing, `handleParsed` (shelf-mode guards + `addScan`), QR/box scan
     routing (`handleQrOrBoxScan`, `handleBoxPickScan`), `removeGroup`,
     `reresolveQueued`, `confirm(scanFn)` (applyAll + refetch +
     re-resolve), orderMatched watch (beep + auto-confirm prompt).
   - Pure logic over `order.items` — page renders all state/overlays.
5. Unified list component — NEW
   `apps/pda/components/picking/PickingUnifiedItems.vue`
   - Merge-by-part grouping (from `PickingItemsSection` `toGroup`/
     `mergeAllocations`); collapsed line 2 per spec §5: `{scanned}/{required}`
     + optional ` (+{queued} {pending})` + ` · {required}({chips})`;
     `formatCompactQtyUpper` everywhere; batch label =
     `lot-date-coo-cow` (empties skipped) / `CTN {boxId}` / receiving-area
     label; allocations hidden at `qty <= 0` or when the group is done.
   - `collapsedStyle` prop: `"allocations"` (new format) | `"fields"`
     (existing `groupMeta` behavior).
   - Expanded: pending rows aggregated per batch (part + lot/date +
     QR|OCR + remove-group), failed styling, unboxed/boxed package rows
     (today's markup), merged-line breakdown, planned `<details>` allocations
     (today's `expandedFields` gating).
6. Unified page — NEW `apps/pda/pages/picking/unified/[id].vue`
   - Header/banners/boxes/footer per spec §4; `usePickingWorkLock`,
     `usePageHeader`, `useVisibleReload(load)`, `claimBox`, boxes ops
     (`createBox`, `cancelBox`, `addAllToBox`, `addToBox`,
     `removeFromBox`), `scanIntoBox` armed state + auto-disarm.
   - One `useHardwareScanner` with today's scan-session routing (armed
     scan-into-box → label → carton → shelf/box); scan-to-create-box
     REMOVED. `useBrandSymbologyScope(orderBrands, { withShelfCodes:
     true })` at page level.
   - Footer: OCR capture + Confirm (N) (scan page gating); leave warnings
     (route-leave + `beforeunload`); modals `PickingScanReviewModal`,
     `ScanMultiItemModal`, `PickFromBoxDialog` at page level.
7. Routing changes (evaluation)
   - `apps/pda/pages/picking/index.vue` row `:to` → `/picking/unified/${po.id}`.
   - `apps/pda/utils/orderScanRoute.ts` picking branch → `/picking/unified/${id}`.
   - `apps/pda/composables/usePickingWorkLock.ts`: keep-lock check gains
     `/picking/unified/${orderId}`.
8. i18n — `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`
   - `picking.unified.*` (pending segment, confirm/ocr labels reuse
     `picking.scanSession.*`), admin `viewConfig` collapsedStyle labels;
     moved strings reused, not duplicated.
9. Tests
   - `apps/pda/tests/orderScanRoute.test.ts` → unified URL;
     `useOrderScanNav.test.ts` → unified URL; `usePickingWorkLock.test.ts`
     → unified prefix keeps lock.
   - New `apps/pda/tests/usePickingScanSession.test.ts`: routing matrix
     (label → queue + duplicate/coo-mismatch, carton → auto-queue, shelf
     require-* → context, require-any unmatched shelf, off → box-pick /
     no_match), confirm re-resolve + partial fail.
   - New `apps/pda/tests/PickingUnifiedItems.test.ts`: collapsed formats
     (allocations style + fields style), chip rendering (lot / CTN /
     receiving-area), pending aggregation.
   - Backend `config.test.ts`: `collapsedStyle` valid literals / unknown
     throws / absent default.
10. Verify
    - `pnpm --filter @warehouse/backend build` + `test` (docker Postgres up).
    - `pnpm --filter @warehouse/pda test` + `pnpm --filter @warehouse/pda nuxt prepare`.
    - Manual: backend + PDA dev servers, open a picking order from the list
      (lands on the unified page), scan → queue → confirm → expand → assign
      boxes → finish; shelf-scan modes; held-by-other; finished order.
11. Docs — `docs/app-docs/flows/picking/{overview,steps,ai-scope}.md`,
    `docs/app-docs/ai/feature-registry.md`, `docs/app-docs/ai/code-map.md`
    (unified page = parallel build at `/picking/unified/:id`; swap later per
    spec §8).
