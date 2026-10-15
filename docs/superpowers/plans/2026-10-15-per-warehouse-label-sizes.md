# Plan: per-warehouse label size catalogs

**Spec:** `docs/superpowers/specs/2026-10-15-per-warehouse-label-sizes-design.md` · **Date:** 2026-10-15

1. **`apps/admin/utils/print.ts`** — split `LABEL_SIZES` into `SZ_LABEL_SIZES` (unchanged four) and `HK_LABEL_SIZES` (`a4-24`, 70 × 37.125 mm, `flushGrid` 3 × 8); add `LabelSizeId "a4-24"`, `LabelSize.flushGrid`, `activeLabelSizes` ref + `setWarehouseLabelSizes(warehouseCode)` (keyed by `warehouseCode`, `""`/`hk` → HK, `sz`/unknown → SZ). Resolve `labelSize`/`loadLabelSize`/`labelSizePx`/`shelfBatchGrid`/render paths against the active catalog; add `defaultLabelSizeId()`. `shelfBatchGrid` returns the exact flush tiling (floor cell, gap 0, `flush: true`, scale ignored); the batch renderer anchors flush grids at the origin.
2. **`composables/useWarehouseLabelLayout.ts`** — cache the `/config` fetch module-level (retry after failure) and call `setWarehouseLabelSizes` alongside the existing SZ-border branch.
3. **`composables/useLabelSize.ts`** — default from `defaultLabelSizeId()` and re-resolve the saved pick when the catalog changes.
4. **Dialogs** — `ShelfBatchPrintDialog`, `ShelfBoxBatchPrintDialog`, `ShelfBoxPrintDialog`, `PrintLabelsDialog`: options from a computed over `activeLabelSizes`; `PrintLabelsDialog` also mounts `useWarehouseLabelLayout`. Batch dialogs hide the print-scale input for flush sizes.
5. **i18n** — `admin.print.sizes["a4-24"]` in `en-US` / `zh-CN` / `zh-HK`.
6. **Verify** — geometry check (24/page flush, cells ≤ die slots, SZ grids unchanged), `npx nuxt prepare`, `npx vue-tsc --noEmit` (no new errors).
7. **Docs** — update the label-printing rows in `docs/app-docs/ai/feature-registry.md` and `code-map.md`.
