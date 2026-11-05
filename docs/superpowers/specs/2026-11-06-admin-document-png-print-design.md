# Admin document PNG printing (2026-11-06)

CR-049. Adds a **Print** button next to the existing Excel download on the admin **receiving-CN order detail** (`收貨確認及付款通知書`) and **picking order detail** (picking list) pages. The document is rendered client-side as PNG page(s) at 300 dpi on **A4 landscape**, split across pages when too long, and sent to a printer the user picks in a print dialog — through the existing `/print/files` pipeline. UAT record: `docs/uat/features/CR-049.json`.

## Problem

Both detail pages today offer only an .xlsx download. Users must open Excel and print from there, and the warehouse printers only accept PNG. Layouts also drift — everyone prints the sheet with different margins/scaling. A direct print path fixes the output format (PNG) and the layout (one renderer for everyone).

## Decision

Render the document **in the browser with pure canvas** (same technique as `apps/admin/utils/print.ts` label rendering — no html-to-image/html2canvas dependency), paginate it deterministically, and upload each page PNG to the existing print proxy. A print dialog (modeled on `PrintLabelsDialog.vue`) lets the user pick a printer (remembered per machine) and number of copies.

Explicitly **not** in v1 (considered and rejected):

- **html-to-image / html2canvas.** New dependency, stale-WebView rasterization risk, and the codebase already proves pure-canvas document rendering works (`print.ts`, 300 dpi, bundled font). Tables wrap predictably when the measurer is `ctx.measureText`.
- **Server-side PNG rendering.** Both source datasets already exist client-side (CN detail is fully in `CnOrderDetail`; picking adds one JSON endpoint). Sending HTML/table data to the server just moves the renderer; no gain.
- **Portrait A4 / orientation picker.** Both documents are 10–12 column tables — landscape is the right call for every real order. The page model carries an `orientation` field (default `"landscape"`) so a future portrait document costs nothing.
- **Replacing the Excel download.** The .xlsx stays (it is the matched paper form for CN receiving and a backend-generated file of record for picking). Print is an additional button.
- **Browser `window.print()`.** It cannot target the PNG-only warehouse printers and offers no job-status feedback; the print service (`waitForPrintJob`) already does.

## Document model

One intermediate model drives the canvas renderer for both documents (`apps/admin/utils/documentPrint.ts`):

```ts
interface PrintDocument {
  title: string;
  /** Slim page header repeated on every page: doc title + ref + page x/y. */
  ref: string;
  /** Label/value block above the table (order head fields). */
  head: [string, string][];
  table: {
    columns: { header: string; /** 0..1 share of usable width */ weight: number; align?: "left"|"right" }[];
    rows: (string | number)[][];
    /** Right-aligned numeric total row (label + per-column values), optional. */
    totals?: (string | number)[];
  };
  /** Fixed lines below the table (CN notices / signature row). */
  foot: string[];
  /** Order-link QR, top-right of page 1 (same payloads as the xlsx exports). */
  qr?: { payload: string } | null;
  orientation?: "landscape"; // v1 renders landscape only
}
```

## Content sources (kept single-source)

- **CN receiving** — all data is already client-side in `CnOrderDetail`. New `buildCnReceivingPrintDoc(detail)` in a new `apps/admin/utils/documentPrintCn.ts` mirrors `buildCnReceivingExportAoa` (`cnReceivingExcelExport.ts`): same `CN_EXPORT_ITEM_COLUMNS`, same poLine numeric-aware sort, same jsonb-first header fallback, 合计 totals row, the three fixed notice/signature lines. QR payload reuses `cnPutAwayQrPayload` (`warehouse://putaway-cn/{id}`, null when no put-away task → no QR). The Excel builder stays untouched; a vitest asserts the print doc's table headers equal `CN_EXPORT_ITEM_COLUMNS.map(c => c.header)` so the two layouts cannot drift silently.
- **Picking list** — content assembly (part grouping, allocation merging, UNALLOCATED rows) lives server-side in `loadPickingListDocument` (`apps/backend/src/export/picking-list/data.ts`). Duplicating it client-side would rot, so add **`GET /admin/picking-orders/:id/picking-list-document`** returning the existing `PickingListDocument { head, generatedAt, groups }` as JSON (same auth as the xlsx route; read-only; no in-request recompute — mirrors the xlsx endpoint's contract). A client adapter `pickingListDocToPrintDoc(doc, orderNo)` in `apps/admin/utils/documentPrintPicking.ts` maps it to the model: head label/value rows from `head`, the 12-column layout with the renderer's column weights derived from its existing column widths (`default.ts:102-115`), groups → rows (group-first-row semantics preserved), UNALLOCATED / "(no allocation)" rows, totals row = Σ item qty / Σ allocated / Σ picked. QR payload `warehouse://picking/{orderId}` — the page already has `orderId`.

## Page layout & splitting (A4 landscape, 300 dpi)

Page pixel size = **3508 × 2480** (swap of `A4_PAGE_W`/`A4_PAGE_H` in `print.ts`); ~5 mm margins. Layout per page:

1. **Slim page header** (~8 mm): document title left, `ref` + `Page x/y` right — on every page so loose sheets stay identifiable.
2. **Head block** (page 1 only): title, label/value rows, QR top-right.
3. **Table**: header row with light shading + grid lines (1 px light gray — thin lines can drop out on these printers at 300 dpi if darker artifacts appear, follow `LABEL_BORDER_PX` precedent and test), body rows.
4. **Foot + totals** (last page only).

**Splitting.** Rows are measured with `ctx.measureText` after word/char wrapping per column width; a row's height = max wrapped line count × line height, min height clamped. Pages are filled greedily top-down and split **at row boundaries** — never mid-row. The table header row repeats at the top of every continuation page (below the slim page header). A row taller than one usable page body is hard-truncated with an ellipsis (degenerate input, noted in the page footer count). This produces a pure `paginate(doc): PagePlan[]` (page → row ranges + header/foot flags) that is fully unit-testable without a DOM canvas; only the final `drawPage(plan) → canvas` touches canvas APIs.

**Font.** Bundled Roboto Mono (`ensureLabelTextFont` pattern) — same glyphs on every admin machine, already the print pipeline's face. Document body drawn smaller than the 130 % label boost.

## Print dialog (`components/PrintDocumentDialog.vue`)

Plain-CSS overlay following `PrintLabelsDialog.vue` / `useOverlayDismiss`:

- **Preview**: thumbnails of all pages (canvas downscaled, `Page x/y` caption) so the user sees the split before printing.
- **Printer**: `<input list>` over `listPrinters()` (GET `/print/printers` via the backend proxy), picker value `printerKey` (`serviceId.deviceKey`), remembered in a **new** localStorage key `doc_printer` (separate from `label_printer` — docs and labels are different machines).
- **Copies**: number input, passed per page job.
- **Print**: renders full-resolution PNGs → uploads **one page per print job** via `printFile(blob, `${ref}-p${i}.png`, { serviceId, deviceKey, copies })`, `waitForPrintJob` each, sequential with a progress line (`Page 2/5 …`) and cancel-on-error behavior copied from `PrintLabelsDialog.vue`. Multi-page upload to one job is out of scope unless `/print/files` already accepts multi-file (check at implementation; sequential per-page jobs are the guaranteed baseline).

## i18n

New `admin.printDoc.*` block in all three `layers/i18n/i18n/locales/*.ts` files (zh-HK default): dialog title, print button, page caption, preparing/printing progress, no-printer hint. Reuse existing `admin.print.*` keys for the printer field where they fit.

## Tests

- `apps/admin/tests/documentPrint.test.ts`: pagination — greedy fill, row-boundary splits, header repeat on continuation pages, head-on-first/foot-on-last only, totals placement, degenerate over-tall row truncation, single-page doc (CN with few items), many-page doc (picking with 200+ rows), column-weight normalization.
- `apps/admin/tests/documentPrintCn.test.ts`: `buildCnReceivingPrintDoc` — headers match `CN_EXPORT_ITEM_COLUMNS`, poLine sort parity with the Excel builder, jsonb-first header fallback, totals sums, notice lines, QR null without put-away.
- `apps/admin/tests/documentPrintPicking.test.ts`: adapter — group-first-row mapping, UNALLOCATED shortfall row, no-allocation marker, totals.
- Backend: route test for `GET /admin/picking-orders/:id/picking-list-document` (200 JSON shape, auth required, same read-only/no-recompute contract as the xlsx route).

## Docs

- `docs/backend/api-design.md`: catalog the new endpoint.
- `docs/app-docs/ai/feature-registry.md` + `ai/code-map.md`: entries for the dialog, the two builders, and the endpoint.
- CR-049 remarks updated with the commit/spec reference at delivery.
