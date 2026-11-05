/**
 * Generic document → paginated PNG renderer (spec
 * docs/superpowers/specs/2026-11-06-admin-document-png-print-design.md).
 *
 * One intermediate `PrintDocument` model drives both document print paths
 * (CN receiving confirmation, picking list — see utils/documentPrintCn.ts
 * and utils/documentPrintPicking.ts). `paginate` is PURE and DOM-free: text
 * measurement is injected, so tests pass a fake measurer and the canvas
 * renderer passes a real ctx-based one built from the same font string.
 * `renderDocumentPngs` is the only function here that touches canvas APIs.
 *
 * Page layout (A4 landscape, 300 dpi):
 *   1. Slim page header band — doc title left, `ref` + `Page x/y` right —
 *      on every page so loose sheets stay identifiable.
 *   2. Head block (page 1 only): big title, label/value rows, QR top-right.
 *   3. Table: shaded header row (repeats on every page), grid lines, body
 *      rows split only at row boundaries.
 *   4. Totals row + foot lines (last page only; a foot-only overflow page
 *      is added when they no longer fit under the last rows).
 */
import QRCode from "qrcode";
// canvasToPng / ensureLabelTextFont are imported lazily inside
// renderDocumentPngs: utils/print.ts pulls in `vue` (label-size refs), which
// would make the pure paginate/wrapCellText half of this module unimportable
// from the node-based vitest environment.

export interface PrintDocument {
  title: string;
  /** Slim page header repeated on every page: doc title + ref + page x/y. */
  ref: string;
  /** Label/value block above the table (order head fields). */
  head: [string, string][];
  table: {
    columns: { header: string; /** 0..1 share of usable width */ weight: number; align?: "left" | "right" }[];
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

// A4 landscape at 300 dpi — the swap of A4_PAGE_W / A4_PAGE_H in print.ts.
export const A4_LANDSCAPE_W = 3508;
export const A4_LANDSCAPE_H = 2480;
/** Page margin, ≈ 5 mm at 300 dpi. */
export const DOC_MARGIN_PX = 59;

// Font sizes at 300 dpi — readable at A4 print size (36 px ≈ 8.7 pt).
export const DOC_BODY_FONT_PX = 36;
export const DOC_HEAD_FONT_PX = 36;
export const DOC_FOOT_FONT_PX = 32;
export const DOC_PAGE_HEADER_FONT_PX = 30;
export const DOC_TITLE_FONT_PX = 56;

/** One row slice placed on a page. `index` is the row's index in
 *  doc.table.rows; `maxLines` is the wrapped-line budget inside `height`
 *  (the renderer slices over-tall cells to it and ends the last visible
 *  line with "…" when `truncated`). */
export interface PagePlanRow {
  index: number;
  height: number;
  maxLines: number;
  truncated: boolean;
}

export interface PagePlan {
  /** 1-based page number. */
  page: number;
  /** Total page count (same value on every plan). */
  pageCount: number;
  /** Head block + QR on this page (page 1 only). */
  hasHead: boolean;
  /** Totals row + foot lines on this page (last page only). */
  hasFoot: boolean;
  /** Height of the repeated table header row. */
  headerRowHeight: number;
  rows: PagePlanRow[];
}

// Same family as the label pipeline (print.ts): the bundled Roboto Mono
// (latin-700) so every machine rasterizes the same glyphs; system stack as
// last-resort fallback (and for CJK, which the bundle does not cover).
const DOC_FONT_FAMILY = '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const DOC_LINE_HEIGHT = Math.round(DOC_BODY_FONT_PX * 1.32);
const DOC_CELL_PAD_X = 10;
const DOC_CELL_PAD_Y = 10;
const DOC_MIN_ROW_H = DOC_LINE_HEIGHT + 2 * DOC_CELL_PAD_Y;
/** Blank separator rows (picking-list group gaps) stay thin. */
const DOC_EMPTY_ROW_H = Math.round(DOC_LINE_HEIGHT * 0.6);
const DOC_PAGE_HEADER_H = 72; // slim band (title left, ref + page x/y right)
const DOC_QR_BOX_PX = 240;
const DOC_GRID_COLOR = "#d1d5db";
const DOC_GRID_PX = 2; // 1 px lines can drop out on these printers at 300 dpi

/** Word-wrap `text` to `maxWidth` by measured width. Words longer than the
 *  column (CJK runs, long codes) are broken by character so they always fit. */
export function wrapCellText(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  if (text === "") return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    if (measure(word) > maxWidth) {
      for (const ch of word) {
        if (line !== "" && measure(line + ch) > maxWidth) {
          lines.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
    } else {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (line !== "" && measure(candidate) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
  }
  lines.push(line);
  return lines;
}

interface LayoutRow extends PagePlanRow {
  cells: (string | number)[];
}

/** Column pixel widths: weight × usable width, weights normalized to sum 1. */
function columnWidths(doc: PrintDocument): number[] {
  const usableW = A4_LANDSCAPE_W - 2 * DOC_MARGIN_PX;
  const sum = doc.table.columns.reduce((s, c) => s + c.weight, 0) || 1;
  return doc.table.columns.map((c) => (c.weight / sum) * usableW);
}

/** Wrap one table row per column and compute its placed height. */
function layoutRow(
  cells: (string | number)[],
  index: number,
  colWidths: number[],
  measure: (text: string) => number
): LayoutRow {
  if (cells.every((c) => String(c) === "")) {
    return { index, cells, height: DOC_EMPTY_ROW_H, maxLines: 1, truncated: false };
  }
  const lineCounts = cells.map(
    (c, i) => wrapCellText(String(c ?? ""), Math.max(1, (colWidths[i] ?? 0) - 2 * DOC_CELL_PAD_X), measure).length
  );
  const maxLines = Math.max(1, ...lineCounts);
  const height = Math.max(DOC_MIN_ROW_H, maxLines * DOC_LINE_HEIGHT + 2 * DOC_CELL_PAD_Y);
  return { index, cells, height, maxLines, truncated: false };
}

/**
 * Split a document's table rows across pages. Greedy top-down fill, splitting
 * ONLY at row boundaries; the table header row repeats on every page; the
 * head block + QR sit on page 1; the totals row + foot lines sit on the last
 * page (an extra foot-only page is appended when they no longer fit). A row
 * taller than one page body is truncated (`truncated` + "…" at render).
 */
export function paginate(doc: PrintDocument, measure: (text: string) => number): PagePlan[] {
  const pageBodyH = A4_LANDSCAPE_H - 2 * DOC_MARGIN_PX;

  const colWidths = columnWidths(doc);
  const headerRowHeight = layoutRow(doc.table.columns.map((c) => c.header), -1, colWidths, measure).height;
  const totalsRow = doc.table.totals ? layoutRow(doc.table.totals, -1, colWidths, measure) : null;

  // Head block (page 1): big title + label/value rows, at least the QR box.
  const headLineH = Math.round(DOC_HEAD_FONT_PX * 1.35);
  const headTextH = Math.round(DOC_TITLE_FONT_PX * 1.4) + doc.head.length * headLineH + 20;
  const headBlockH = Math.max(headTextH, doc.qr ? DOC_QR_BOX_PX : 0) + 24;

  // Foot block (last page): totals row + fixed lines.
  const footLineH = Math.round(DOC_FOOT_FONT_PX * 1.35);
  const footBlockH = (totalsRow?.height ?? 0) + doc.foot.length * footLineH + (doc.foot.length > 0 ? 16 : 0);

  const continuationCap = pageBodyH - DOC_PAGE_HEADER_H - headerRowHeight;
  const firstPageCap = continuationCap - headBlockH;

  // A row may start on any page, so its truncation budget is the tightest
  // fresh-page capacity (page 1). Degenerate input only.
  const maxRowH = Math.max(DOC_MIN_ROW_H, firstPageCap);
  const rows: LayoutRow[] = doc.table.rows.map((cells, index) => {
    const row = layoutRow(cells, index, colWidths, measure);
    if (row.height > maxRowH) {
      const maxLines = Math.max(1, Math.floor((maxRowH - 2 * DOC_CELL_PAD_Y) / DOC_LINE_HEIGHT));
      return { ...row, height: maxRowH, maxLines, truncated: true };
    }
    return row;
  });

  const plans: PagePlan[] = [];
  let pageRows: PagePlanRow[] = [];
  let used = 0;
  let capacity = firstPageCap;
  const flush = () => {
    plans.push({
      page: plans.length + 1,
      pageCount: 0, // backfilled below
      hasHead: plans.length === 0,
      hasFoot: false, // backfilled below
      headerRowHeight,
      rows: pageRows,
    });
  };
  for (const row of rows) {
    if (pageRows.length > 0 && used + row.height > capacity) {
      flush();
      pageRows = [];
      used = 0;
      capacity = continuationCap;
    }
    pageRows.push(row);
    used += row.height;
  }
  flush(); // the last (or only) page — possibly empty when there are no rows
  // Totals + foot go under the last page's rows, or on a fresh overflow page.
  if (used + footBlockH > capacity && pageRows.length > 0) {
    pageRows = [];
    flush();
  }
  plans[plans.length - 1].hasFoot = true;
  for (const plan of plans) plan.pageCount = plans.length;
  return plans;
}

function docFont(weight: number, px: number): string {
  return `${weight} ${px}px ${DOC_FONT_FAMILY}`;
}

async function drawCellText(
  ctx: CanvasRenderingContext2D,
  cells: (string | number)[],
  columns: PrintDocument["table"]["columns"],
  colWidths: number[],
  x0: number,
  y: number,
  height: number,
  maxLines: number,
  truncated: boolean
): Promise<void> {
  // Only the latin-700 Roboto Mono face is bundled, so every row draws at
  // 700 (the header row stands out via its shaded fill instead).
  ctx.font = docFont(700, DOC_BODY_FONT_PX);
  ctx.textBaseline = "top";
  let x = x0;
  for (const [i, cell] of cells.entries()) {
    const colW = colWidths[i] ?? 0;
    const textW = Math.max(1, colW - 2 * DOC_CELL_PAD_X);
    let lines = wrapCellText(String(cell ?? ""), textW, (t) => ctx.measureText(t).width);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      truncated = true;
    }
    if (truncated && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]}…`;
    const right = columns[i]?.align === "right" || typeof cell === "number";
    for (const [li, line] of lines.entries()) {
      const lineY = y + DOC_CELL_PAD_Y + li * DOC_LINE_HEIGHT;
      if (lineY + DOC_LINE_HEIGHT > y + height) break;
      if (right) {
        ctx.textAlign = "right";
        ctx.fillText(line, x + colW - DOC_CELL_PAD_X, lineY);
      } else {
        ctx.textAlign = "left";
        ctx.fillText(line, x + DOC_CELL_PAD_X, lineY);
      }
    }
    x += colW;
  }
}

function strokeGrid(ctx: CanvasRenderingContext2D, x0: number, y: number, colWidths: number[], rowH: number, tableW: number): void {
  ctx.strokeStyle = DOC_GRID_COLOR;
  ctx.lineWidth = DOC_GRID_PX;
  ctx.strokeRect(x0, y, tableW, rowH);
  let x = x0;
  for (const w of colWidths.slice(0, -1)) {
    x += w;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + rowH);
    ctx.stroke();
  }
}

/** Render every planned page to a PNG blob (one per page, in page order). */
export async function renderDocumentPngs(doc: PrintDocument): Promise<Blob[]> {
  const { canvasToPng, ensureLabelTextFont } = await import("~/utils/print");
  await ensureLabelTextFont();
  const measurer = document.createElement("canvas").getContext("2d")!;
  measurer.font = docFont(700, DOC_BODY_FONT_PX);
  const measure = (t: string) => measurer.measureText(t).width;
  const plans = paginate(doc, measure);

  const colWidths = columnWidths(doc);
  const tableW = colWidths.reduce((s, w) => s + w, 0);
  const headLineH = Math.round(DOC_HEAD_FONT_PX * 1.35);
  const footLineH = Math.round(DOC_FOOT_FONT_PX * 1.35);

  // QR image for page 1 (render sharp, draw scaled).
  let qrImg: HTMLImageElement | null = null;
  if (doc.qr?.payload) {
    qrImg = new Image();
    qrImg.src = await QRCode.toDataURL(doc.qr.payload, {
      width: DOC_QR_BOX_PX * 2,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    await qrImg.decode();
  }

  const blobs: Blob[] = [];
  for (const plan of plans) {
    const canvas = document.createElement("canvas");
    canvas.width = A4_LANDSCAPE_W;
    canvas.height = A4_LANDSCAPE_H;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, A4_LANDSCAPE_W, A4_LANDSCAPE_H);
    ctx.fillStyle = "#0f1720";

    // 1. Slim page header band — title left, ref + page x/y right.
    ctx.textBaseline = "top";
    ctx.font = docFont(700, DOC_PAGE_HEADER_FONT_PX);
    ctx.textAlign = "left";
    ctx.fillText(doc.title, DOC_MARGIN_PX, DOC_MARGIN_PX - 12);
    ctx.textAlign = "right";
    ctx.fillText(`${doc.ref} — Page ${plan.page}/${plan.pageCount}`, A4_LANDSCAPE_W - DOC_MARGIN_PX, DOC_MARGIN_PX - 12);
    ctx.strokeStyle = DOC_GRID_COLOR;
    ctx.lineWidth = DOC_GRID_PX;
    ctx.beginPath();
    ctx.moveTo(DOC_MARGIN_PX, DOC_MARGIN_PX + DOC_PAGE_HEADER_H - 24);
    ctx.lineTo(A4_LANDSCAPE_W - DOC_MARGIN_PX, DOC_MARGIN_PX + DOC_PAGE_HEADER_H - 24);
    ctx.stroke();
    let y = DOC_MARGIN_PX + DOC_PAGE_HEADER_H;

    // 2. Head block (page 1): big title, label/value rows, QR top-right.
    if (plan.hasHead) {
      ctx.font = docFont(700, DOC_TITLE_FONT_PX);
      ctx.textAlign = "left";
      ctx.fillText(doc.title, DOC_MARGIN_PX, y);
      y += Math.round(DOC_TITLE_FONT_PX * 1.4);
      if (qrImg) {
        ctx.drawImage(qrImg, A4_LANDSCAPE_W - DOC_MARGIN_PX - DOC_QR_BOX_PX, y - 8, DOC_QR_BOX_PX, DOC_QR_BOX_PX);
      }
      ctx.font = docFont(700, DOC_HEAD_FONT_PX);
      for (const [label, value] of doc.head) {
        ctx.textAlign = "left";
        ctx.fillText(label, DOC_MARGIN_PX, y);
        ctx.fillText(String(value), DOC_MARGIN_PX + 560, y);
        y += headLineH;
      }
      y += 24;
    }

    // 3. Table — shaded header row repeats on every page.
    const headerCells = doc.table.columns.map((c) => c.header);
    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(DOC_MARGIN_PX, y, tableW, plan.headerRowHeight);
    ctx.fillStyle = "#0f1720";
    await drawCellText(ctx, headerCells, doc.table.columns, colWidths, DOC_MARGIN_PX, y, plan.headerRowHeight, 99, false);
    strokeGrid(ctx, DOC_MARGIN_PX, y, colWidths, plan.headerRowHeight, tableW);
    y += plan.headerRowHeight;

    for (const row of plan.rows) {
      const cells = doc.table.rows[row.index];
      await drawCellText(ctx, cells, doc.table.columns, colWidths, DOC_MARGIN_PX, y, row.height, row.maxLines, row.truncated);
      strokeGrid(ctx, DOC_MARGIN_PX, y, colWidths, row.height, tableW);
      y += row.height;
    }

    // 4. Totals row + foot lines (last page only).
    if (plan.hasFoot) {
      if (doc.table.totals) {
        const totalsHeight = layoutRow(doc.table.totals, -1, colWidths, measure).height;
        await drawCellText(ctx, doc.table.totals, doc.table.columns, colWidths, DOC_MARGIN_PX, y, totalsHeight, 99, false);
        strokeGrid(ctx, DOC_MARGIN_PX, y, colWidths, totalsHeight, tableW);
        y += totalsHeight;
      }
      if (doc.foot.length > 0) y += 16;
      ctx.font = docFont(700, DOC_FOOT_FONT_PX);
      ctx.textAlign = "left";
      for (const line of doc.foot) {
        ctx.fillText(line, DOC_MARGIN_PX, y);
        y += footLineH;
      }
    }

    blobs.push(await canvasToPng(canvas));
  }
  return blobs;
}

/** Last document printer picked in the print dialog (`doc_printer` key —
 *  separate from `label_printer`; docs and labels are different machines). */
export function loadDocPrinter(): string {
  if (!import.meta.client) return "";
  return localStorage.getItem("doc_printer") ?? "";
}

/** Remember the document printer picked in the print dialog. */
export function saveDocPrinter(key: string): void {
  if (import.meta.client) localStorage.setItem("doc_printer", key);
}
