# Per-warehouse label size catalogs (SZ stock sizes vs HK die-cut A4 sheet)

**Date:** 2026-10-15 · **Status:** implemented · **Scope:** `apps/admin` only (no backend change)

## Problem

The label-size catalog in `utils/print.ts` was global: one list (small / medium / big / xl, all drawn 105% larger to compensate the printers' auto-fit shrink) served every admin console. The two warehouse instances buy different label stock:

- **SZ** uses the loose stock sizes (53 × 16 / 68 × 35 / 104 × 35 / 104 × 40 mm) at the 105% render scale.
- **HK** uses pre-cut A4 sticker sheets — 24 die-cut labels tiled 3 columns × 8 rows over one A4 — and prints true size (no 105% compensation; the die positions are fixed).

## Decisions (confirmed 2026-10-15)

1. **HK's size = the die sheet itself:** each slot is 70 × 37.125 mm (210 ÷ 3 × 297 ÷ 8), i.e. full-bleed tiling — *no page padding, no gaps, no centering offset* ("the layout should no page padding"). The batch page must land exactly on the pre-cut positions.
2. **HK's dropdown offers only that one size** (id `a4-24`); SZ keeps the four.
3. **Catalogs live in the admin frontend, keyed by `warehouseCode`** from `GET /config` — the same mechanism the SZ-only trim border already uses (`useWarehouseLabelLayout`). Chosen over a backend `labelSizes` flow-config field for effort; the selection is still config (`WAREHOUSE_CODE` env), not a git branch. (See AGENTS.md "Warehouse instances": differences must be configurable.)

## Design

### Catalogs (`apps/admin/utils/print.ts`)

- `SZ_LABEL_SIZES` — the four existing entries (unchanged: `renderScale` 1.05, big/xl `paddingMm`/`qrMinMm`/`fontScale`).
- `HK_LABEL_SIZES` — `[{ id: "a4-24", widthMm: 70, heightMm: 37.125, flushGrid: { cols: 3, rows: 8 } }]`. No render scale.
- `LABEL_SIZES_BY_WAREHOUSE` keyed by `warehouseCode`: `""` (unset = default HK instance) and `"hk"` → HK, `"sz"` → SZ, unknown → SZ (the pre-split behavior).
- `activeLabelSizes` (Vue ref) holds the active catalog; `setWarehouseLabelSizes(code)` switches it. Every helper (`labelSize`, `labelSizePx`, `loadLabelSize`, `shelfBatchGrid`, the render paths) resolves against it, so the whole print path follows one switch. Default before the `/config` fetch resolves: SZ (matches pre-split behavior).
- New `LabelSizeId`: `"a4-24"`; default id helper `defaultLabelSizeId()` = `medium` when the catalog has it, otherwise the catalog's first entry (HK → `a4-24`).

### Flush grid (`flushGrid`)

- `LabelSize.flushGrid?: { cols, rows }` → `shelfBatchGrid` returns the exact tiling: `cellW = floor(A4_W / cols)`, `cellH = floor(A4_H / rows)`, `gap 0`, `flush: true`; the print scale is ignored (a scaled die-cut grid would drift off the cuts).
- `floor` keeps every cell strictly inside its die slot (826 ≤ 826.77 px, 438 ≤ 438.48 px — content can never cross a die line), and the batch renderer anchors flush grids at the sheet origin instead of centering (`offset = 0`).
- The batch dialogs hide the print-scale input while a flush size is selected.
- Result: 3 × 8 = **24 labels per A4 page**, cells start at (0, 0), zero padding.

### Wiring (`composables/useWarehouseLabelLayout.ts`, `useLabelSize.ts`)

- The composable's `/config` fetch is cached module-level (one fetch per page load, shared by every dialog/page; a failure clears the cache for retry). Besides `{ layout }` (SZ border, unchanged) it now calls `setWarehouseLabelSizes(warehouseCode)`.
- `PrintLabelsDialog` mounts the composable too — it renders via host callbacks, so it never loaded `/config` itself.
- Dialog `sizeOptions` became computed from `activeLabelSizes` (updates when the catalog lands).
- `useLabelSize` re-resolves the saved `label_size` pick whenever the catalog changes: a pick from the other warehouse's list falls back to the active catalog's default.

### i18n

`admin.print.sizes["a4-24"]` in all three locales: "A4 sheet (70 × 37.1 mm, 24/page)" / "A4 标签纸（70 × 37.1 mm，24 格）" / "A4 標籤紙（70 × 37.1 mm，24 格）".

## Verification

- Geometry: flush grid 3 × 8 = 24/page, cell 826 × 438 px ≤ die slot, origin-anchored; single `a4-24` label 827 × 438 px (70 × 37.08 mm), tall layout fits (pad 2.4 mm, QR 18.5 mm, font 12.8 mm). SZ grid numbers unchanged (small 3 × 15, medium 2 × 7, big 1 × 7, xl 1 × 6).
- `nuxt prepare` + `vue-tsc --noEmit`: no new errors (only the pre-existing set in `picking-orders/[id].vue`, `flow-config.vue`, `stock-search.vue`, `useDateCodeDisplay.ts`, the i18n plugin).
- Docs: `docs/app-docs/ai/feature-registry.md` + `code-map.md` label-printing rows updated.

## Not in scope

- Backend flow-config `labelSizes` (admin-editable catalogs) — revisit if sizes need runtime tuning without a code change.
- HK border behavior: stays borderless (the 3 px trim border remains SZ-only).
