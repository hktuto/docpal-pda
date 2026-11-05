# Admin Document PNG Printing — Implementation Plan

Date: 2026-11-06
Spec: `docs/superpowers/specs/2026-11-06-admin-document-png-print-design.md`
UAT: `docs/uat/features/CR-049.json`

## Backend (`apps/backend`) — picking-list document JSON

1. `src/routes/admin/pickingList.ts`: add `GET /admin/picking-orders/:id/picking-list-document` next to the existing xlsx route — same auth, same read-only contract (calls `loadPickingListDocument`, **no** recompute, 404 when the order is missing). Response: the existing `PickingListDocument` (`src/export/picking-list/model.ts`) serialized as-is.
2. Route test: 401 without token; 200 JSON with `head/groups` for a seeded order; 404 unknown id; assert no allocation recompute side-effect (allocation rows unchanged after call — copy the assertion style of the existing picking-list route tests).

## Admin (`apps/admin`)

3. `utils/documentPrint.ts` (new) — the generic document-print core:
   - `PrintDocument` model + `A4_LANDSCAPE = { w: 3508, h: 2480 }` (comment: swap of `A4_PAGE_W/H` in print.ts, 300 dpi) and `DOC_MARGIN_PX` (~59 px / 5 mm).
   - **Pure** `paginate(doc): PagePlan[]` — measure/wrap rows via a pluggable measurer (inject `measure: (text, font) => number` so tests run in plain vitest without canvas), greedy row-boundary page fill, table header repeat, head on page 1 only, foot+totals on last page only, over-tall-row ellipsis truncation.
   - `renderDocumentPngs(doc): Promise<Blob[]>` — canvas per `PagePlan`, slim page header (title left, `ref` + `Page x/y` right), head block + QR top-right on page 1 (QR via `QRCode.toDataURL`, drawn ≥120 px target), grid table with shaded header row, totals right-aligned, foot lines; white background; Roboto Mono via the `ensureLabelTextFont` pattern (export it from `print.ts` or replicate with a comment referencing it); ends with `canvasToPng` (export/reuse from `print.ts`).
   - Printer-persistence helpers `loadDocPrinter()/saveDocPrinter()` on the new `doc_printer` localStorage key.
4. `utils/documentPrintCn.ts` (new): `buildCnReceivingPrintDoc(detail: CnOrderDetail): PrintDocument` mirroring `buildCnReceivingExportAoa` — reuse `CN_EXPORT_ITEM_COLUMNS` (import from `cnReceivingExcelExport.ts`) and the poLine numeric-aware sort (extract the sort into an exported helper in `cnReceivingExcelExport.ts` so both builders share it), jsonb-first header fallback (`firstJsonb` — extract/export too), 合计 totals row (Σ ctnNo, Σ receivedQty), the three fixed notice/signature lines, `qr: detail.putAway ? { payload: cnPutAwayQrPayload(detail)! } : null`.
5. `utils/documentPrintPicking.ts` (new): `pickingListDocToPrintDoc(doc: PickingListDocument, opts: { orderId, orderNo }): PrintDocument` — head label/value rows, 12 columns with weights normalized from the xlsx renderer's column widths (`apps/backend/src/export/picking-list/render/default.ts:102-115`), group rows with group-first-row semantics, UNALLOCATED shortfall rows / `(no allocation)`, totals (Σ item qty / Σ allocated / Σ picked), `qr: { payload: \`warehouse://picking/${orderId}\` }` (use `orderLink.ts`-equivalent constant if exported; otherwise inline with a comment).
6. `utils/flowApi.ts` (or wherever the picking-order fetch helpers live — follow the existing pattern): `getPickingListDocument(orderId): Promise<PickingListDocument>` plain fetch with the admin token, mirroring `downloadPickingList`'s headers.
7. `components/PrintDocumentDialog.vue` (new, styled on `PrintLabelsDialog.vue` + `useOverlayDismiss`): props `{ build: () => Promise<PrintDocument>, filenameBase: string }`; on open, builds the doc + `paginate` and renders thumbnails (canvas downscaled, `Page x/y` caption); printer `<input list>` over `listPrinters()` with `printerKey`/`parsePrinterKey`, persisted via `loadDocPrinter/saveDocPrinter`; copies input; **Print** → `renderDocumentPngs` → per page `printFile(blob, \`${filenameBase}-p${i}.png\`, { serviceId, deviceKey, copies })` + `waitForPrintJob`, sequential with progress (`Page i/N`) and per-page error reporting; check at implementation whether `/print/files` accepts multiple files in one job — if yes prefer one job for all pages, else keep sequential.
8. `pages/receiving-cn/[batchNo].vue`: second button beside `downloadExcel` ("Print PNG" i18n) → opens `PrintDocumentDialog` with `build: () => buildCnReceivingPrintDoc(detail.value)` (guard `detail` loaded), `filenameBase: detail.order.batchNo`.
9. `pages/picking-orders/[id].vue`: second button beside `downloadPickingList` → dialog with `build: async () => pickingListDocToPrintDoc(await getPickingListDocument(orderId), { orderId, orderNo: order.value.orderNo })`.
10. i18n: `admin.printDoc.*` block (dialog title, button, page caption, progress states, no-printer hint) in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`; per-page button labels next to the existing `downloadExcel`/`downloadPickingList` keys.
11. Tests: `tests/documentPrint.test.ts` (pagination/wrap/split/header-repeat/foot-last/truncation/single-vs-multi-page), `tests/documentPrintCn.test.ts` (headers == `CN_EXPORT_ITEM_COLUMNS.map(c => c.header)`, sort parity with a known out-of-order poLine input, jsonb fallback, totals, QR null without put-away), `tests/documentPrintPicking.test.ts` (group mapping, UNALLOCATED row, totals, column weights sum ≈ 1).

## Docs

12. `docs/backend/api-design.md`: catalog `GET /admin/picking-orders/:id/picking-list-document`.
13. `docs/app-docs/ai/feature-registry.md` + `ai/code-map.md`: entries for `PrintDocumentDialog.vue`, `documentPrint*.ts`, and the new endpoint; one-line `ai-scope.md` note if the receiving-cn / picking flow boundaries are documented per-page.

## Verify

14. `pnpm --filter @warehouse/backend test` + `build`; `pnpm --filter @warehouse/admin test` (+ admin build / `nuxt prepare` per the app's conventions).
15. Manual (dev backend + admin): open a CN receiving order detail → Print → thumbnails paginate correctly on a many-item order → pick printer → pages print in order; same on a picking order with both lot and receiving allocations and an UNALLOCATED shortfall; confirm the .xlsx downloads still work untouched.

## Out of scope (v1)

Portrait A4 / orientation picker, multi-page single print job (unless `/print/files` already supports it), replacing the Excel downloads, print preview zoom, re-print of historical documents.
