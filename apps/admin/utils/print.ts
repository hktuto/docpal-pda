/**
 * Client for the backend print proxy (apps/backend/src/routes/print.ts), which
 * forwards to the label-printing-center print service (PRINT_API_BASE_URL on
 * the backend). The browser no longer talks to the print service directly.
 * Upstream API doc: docs/backend/print-service.md
 */
import QRCode from "qrcode";
/** One printer as returned by the print service's agent-printers list. */
export interface PrinterInfo {
  serviceId: string;
  deviceKey: string;
  name?: string;
  alias?: string;
}

export interface PrintFileOptions {
  serviceId: string;
  deviceKey: string;
  copies?: number;
  mode?: string;
  validateOnly?: boolean;
  additionalArgs?: string[];
}

export interface DynamicPrintOptions {
  templateId: string;
  printingParams: Record<string, unknown>[];
  printerName?: string;
  copies?: number;
  mode?: string;
  orientation?: string;
}

export interface PrintJob {
  jobId: string;
  status: string;
  diagnostics?: string[];
}

// Label stock sizes for the shelf and shelf-box labels, in physical mm. The
// canvas is rendered at 300 dpi from the mm size and the chosen size is picked
// per job in the print dialogs. "medium" (68 x 35 mm) is the long-standing
// default. Layout per size: a big left-aligned text line (the shelf code or
// box id) on the left and a QR code on the right (encoding the same scannable
// code — what the PDA scans), all derived from the label's own pixel size.
export type LabelSizeId = "small" | "medium" | "big";

export interface LabelSize {
  id: LabelSizeId;
  /** Physical label width in mm. */
  widthMm: number;
  /** Physical label height in mm. */
  heightMm: number;
  /** Rendered-size multiplier over the physical stock (1.05 = drawn 5%
   * larger). medium carries 1.05: operators reported it printing too small
   * on the label printers, so it is pre-enlarged — the printed result lands
   * at the true physical size. */
  renderScale?: number;
}

export const LABEL_SIZES: LabelSize[] = [
  { id: "small", widthMm: 53, heightMm: 16 },
  { id: "medium", widthMm: 68, heightMm: 35, renderScale: 1.05 },
  { id: "big", widthMm: 104, heightMm: 35 },
];

export const DEFAULT_LABEL_SIZE: LabelSizeId = "medium";

// A4 batch print scale factor (percent). Printers auto-fit the sheet into
// their printable area and typically shrink it a little; rendering the grid
// larger than 100% pre-compensates so the printed label ends up at its true
// physical size (e.g. 105 prints the cells 5% bigger).
export const LABEL_PRINT_SCALE_MIN = 50;
export const LABEL_PRINT_SCALE_MAX = 200;
export const DEFAULT_LABEL_PRINT_SCALE = 100;

/** Clamp a print-scale value (invalid input falls back to the default). */
export function labelPrintScale(v?: number | string): number {
  const n = typeof v === "string" ? Number.parseFloat(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_LABEL_PRINT_SCALE;
  return Math.min(LABEL_PRINT_SCALE_MAX, Math.max(LABEL_PRINT_SCALE_MIN, Math.round(n)));
}

/** Last A4 print scale picked in the batch dialogs (invalid values fall back). */
export function loadLabelPrintScale(): number {
  if (!import.meta.client) return DEFAULT_LABEL_PRINT_SCALE;
  return labelPrintScale(localStorage.getItem("label_print_scale"));
}

/** Remember the A4 print scale picked in the batch dialogs. */
export function saveLabelPrintScale(scale: number): void {
  if (import.meta.client) localStorage.setItem("label_print_scale", String(labelPrintScale(scale)));
}

const LABEL_DPI = 300;
const MM_PER_INCH = 25.4;
// Every label draws its text line 30% larger than the base fit — operators
// asked for a bolder shelf code on the printed labels.
const LABEL_TEXT_SCALE = 1.3;
// Label text font: bundled with the app (@fontsource/roboto-mono via the
// nuxt.config css list) so every machine rasterizes the exact same glyphs —
// canvas resolves the OS monospace stack per computer (SF Mono / Consolas /
// DejaVu…) and silently falls back when a face is missing. The system stack
// stays behind it as a last-resort fallback if the webfont ever fails.
const LABEL_FONT_FAMILY = '"Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
// Trim border (SZ warehouse only): a fixed 3px line on every size —
// thinner lines (1-2px) can drop out entirely on the label printers.
const LABEL_BORDER_PX = 3;

/** Resolve a size id (unknown values fall back to the default). */
export function labelSize(id?: string): LabelSize {
  return LABEL_SIZES.find((s) => s.id === id) ?? LABEL_SIZES.find((s) => s.id === DEFAULT_LABEL_SIZE)!;
}

/** Canvas pixel size of one label at 300 dpi (after the size's renderScale). */
export function labelSizePx(id?: string): { w: number; h: number } {
  const size = labelSize(id);
  const f = size.renderScale ?? 1;
  return {
    w: Math.round((size.widthMm * LABEL_DPI * f) / MM_PER_INCH),
    h: Math.round((size.heightMm * LABEL_DPI * f) / MM_PER_INCH),
  };
}

/** Last size picked in any print dialog (invalid values fall back to the default). */
export function loadLabelSize(): LabelSizeId {
  if (!import.meta.client) return DEFAULT_LABEL_SIZE;
  const raw = localStorage.getItem("label_size");
  return LABEL_SIZES.some((s) => s.id === raw) ? (raw as LabelSizeId) : DEFAULT_LABEL_SIZE;
}

/** Remember the size picked in the print dialogs (`label_size` key). */
export function saveLabelSize(id: LabelSizeId): void {
  if (import.meta.client) localStorage.setItem("label_size", id);
}

interface LabelCell {
  /** Value encoded in the QR code (what the PDA scans). */
  qr: string;
  /** Big text line on the left of the QR (left-aligned). */
  main: string;
}

export interface LabelLayout {
  /** Draw a 3px border around the label for easy cutting (SZ warehouse). */
  border?: boolean;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png"
    )
  );
}

// Force-load the bundled label font before the first canvas draw:
// ctx.fillText silently rasterizes a fallback face if the webfont is still
// in flight (that is exactly how the labels ended up looking different per
// machine). Cached after the first call; an unavailable webfont degrades to
// the system monospace stack instead of failing the render.
let labelTextFontReady: Promise<void> | null = null;
function ensureLabelTextFont(): Promise<void> {
  if (!import.meta.client || typeof document === "undefined" || !document.fonts) return Promise.resolve();
  labelTextFontReady ??= document.fonts
    .load('900 100px "Roboto Mono"') // Roboto Mono tops out at 700 — this is its heaviest face
    .then(() => undefined)
    .catch(() => undefined);
  return labelTextFontReady;
}

// Draw one label cell at (x, y) into an existing context. The layout is
// derived from the cell's own pixel size (any of the LABEL_SIZES at 300 dpi):
// one big left-aligned text line (the shelf code / box id) on the left, QR on
// the right. The wide strip (small) keeps a height-filling QR and sizes the
// text off the label height and text width; tall labels (medium/big) cap the
// QR at half the height so the text gets the remaining width. The text line
// is drawn LABEL_TEXT_SCALE (130%) larger than the base fit on every size.
async function drawLabelCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cell: LabelCell,
  layout: LabelLayout
): Promise<void> {
  const pad = Math.max(4, Math.round(h * 0.064)); // vertical margin (all sizes)
  // Wide strip (small 53x16 ≈ 0.30) vs tall labels (big 0.34, medium 0.51):
  // only medium/big cap the QR at half the height.
  const tall = h / w > 0.32;
  // Horizontal margin: the short strip hugs the label edges otherwise, so it
  // gets a ~2mm side margin (tall labels keep the symmetric pad).
  const padX = tall ? pad : Math.max(pad, Math.round((2 * LABEL_DPI) / MM_PER_INCH));
  const qrSize = Math.round(Math.min(tall ? h * 0.5 : h * 0.824, h - 2 * pad, w * 0.5));
  const qr = new Image();
  qr.src = await QRCode.toDataURL(cell.qr, {
    width: Math.max(1, Math.round(qrSize * 2)), // render sharp, draw scaled
    margin: 1,
    errorCorrectionLevel: "M",
  });
  await qr.decode();
  ctx.drawImage(qr, x + w - padX - qrSize, y + (h - qrSize) / 2, qrSize, qrSize);

  const textX = x + padX;
  const textW = Math.max(1, x + w - padX - qrSize - padX - textX);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#0f1720";
  // Main text: sized off the label height and the text width — the height
  // cap grows with the taller small strip, the textW term keeps a ~7-char
  // shelf code inside the text area. fillText's maxWidth then squeezes
  // anything longer than the text area.
  const baseFont = tall
    ? Math.min(h * 0.4, textW / 4.5)
    : Math.max(h * 0.256, Math.min(h * 0.5, textW / 4.5));
  const mainFont = Math.round(baseFont * LABEL_TEXT_SCALE);
  await ensureLabelTextFont();
  ctx.font = `900 ${mainFont}px ${LABEL_FONT_FAMILY}`;
  // Vertically center the single line (cap height ≈ 0.72em).
  ctx.fillText(cell.main, textX, y + h / 2 + mainFont * 0.36, textW);

  if (layout.border) {
    const bw = LABEL_BORDER_PX; // 3px — 1px lines can be ignored by the printer
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = bw;
    ctx.strokeRect(x + bw / 2, y + bw / 2, w - bw, h - bw);
  }
}

/** Render one label (any LABEL_SIZES entry) to a PNG blob for /print/files. */
async function renderStockLabelPng(cell: LabelCell, layout: LabelLayout, size?: string): Promise<Blob> {
  const { w, h } = labelSizePx(size);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  await drawLabelCell(ctx, 0, 0, w, h, cell, layout);
  return canvasToPng(canvas);
}

/** Render one shelf label to a PNG blob for /print/files. */
export function renderShelfLabelPng(
  code: string,
  layout?: LabelLayout,
  size?: LabelSizeId
): Promise<Blob> {
  return renderStockLabelPng({ qr: code, main: code }, layout ?? {}, size);
}

/** Render one shelf-box label to a PNG blob for /print/files. */
export function renderShelfBoxLabelPng(boxId: string, layout?: LabelLayout, size?: LabelSizeId): Promise<Blob> {
  return renderStockLabelPng({ qr: boxId, main: boxId }, layout ?? {}, size);
}

// A4 batch sheet for multi-select label printing at 300 dpi. The grid depends
// on the chosen label size: cells keep the label's physical aspect ratio and
// as many columns/rows as fit the page (same cell content as the single
// labels, laid out per grid cell).
export const A4_PAGE_W = 2480;
export const A4_PAGE_H = 3508;
const BATCH_MIN_GAP = 24; // never tighter than ~2mm between cells
const BATCH_MAX_GAP = 47; // 4mm between cells when there is room

export interface LabelBatchGrid {
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  gap: number;
}

/** Compute the A4 grid for one label size (centered, uniform gap). Cells are
 * drawn `scale`% larger than the physical label so the printed result lands
 * at true size after the printer's own auto-fit shrink; bigger cells simply
 * mean fewer columns/rows per page. */
export function shelfBatchGrid(sizeId?: LabelSizeId, scale: number = DEFAULT_LABEL_PRINT_SCALE): LabelBatchGrid {
  const base = labelSizePx(sizeId);
  const f = labelPrintScale(scale) / 100;
  const px = { w: Math.max(1, Math.round(base.w * f)), h: Math.max(1, Math.round(base.h * f)) };
  const fit = (available: number, cell: number) =>
    Math.max(1, Math.floor((available + BATCH_MIN_GAP) / (cell + BATCH_MIN_GAP)));
  const cols = fit(A4_PAGE_W, px.w);
  const rows = fit(A4_PAGE_H, px.h);
  // The uniform gap must satisfy both axes (cols*w + (cols-1)*gap <= pageW,
  // same for rows/height), so it is capped by the tighter of the two.
  const gapW = Math.floor((A4_PAGE_W - cols * px.w) / Math.max(1, cols - 1));
  const gapH = Math.floor((A4_PAGE_H - rows * px.h) / Math.max(1, rows - 1));
  const gap = Math.min(BATCH_MAX_GAP, Math.max(BATCH_MIN_GAP, Math.min(gapW, gapH)));
  return { cols, rows, cellW: px.w, cellH: px.h, gap };
}

/** How many labels of this size fit on one A4 page at the given scale. */
export function shelfBatchCellsPerPage(sizeId?: LabelSizeId, scale: number = DEFAULT_LABEL_PRINT_SCALE): number {
  const g = shelfBatchGrid(sizeId, scale);
  return g.cols * g.rows;
}

/** Render one A4 page of labels to a PNG blob for /print/files. */
async function renderStockBatchPagePng(
  cells: LabelCell[],
  layout: LabelLayout,
  sizeId?: LabelSizeId,
  scale: number = DEFAULT_LABEL_PRINT_SCALE
): Promise<Blob> {
  const grid = shelfBatchGrid(sizeId, scale);
  const canvas = document.createElement("canvas");
  canvas.width = A4_PAGE_W;
  canvas.height = A4_PAGE_H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, A4_PAGE_W, A4_PAGE_H);

  const { cols, rows, cellW, cellH, gap } = grid;
  // Center the grid — the leftover space is split evenly on both sides.
  const offsetX = Math.round((A4_PAGE_W - (cols * cellW + (cols - 1) * gap)) / 2);
  const offsetY = Math.round((A4_PAGE_H - (rows * cellH + (rows - 1) * gap)) / 2);

  for (const [i, cell] of cells.entries()) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = offsetX + col * (cellW + gap);
    const y = offsetY + row * (cellH + gap);
    await drawLabelCell(ctx, x, y, cellW, cellH, cell, layout);
  }

  return canvasToPng(canvas);
}

/** Render one A4 page of shelf labels to a PNG blob for /print/files. */
export function renderShelfBatchPagePng(
  codes: string[],
  layout?: LabelLayout,
  size?: LabelSizeId,
  scale: number = DEFAULT_LABEL_PRINT_SCALE
): Promise<Blob> {
  return renderStockBatchPagePng(
    codes.map((code) => ({ qr: code, main: code })),
    layout ?? {},
    size,
    scale
  );
}

/** Render one A4 page of shelf-box labels to a PNG blob for /print/files. */
export function renderShelfBoxBatchPagePng(
  boxIds: string[],
  layout?: LabelLayout,
  size?: LabelSizeId,
  scale: number = DEFAULT_LABEL_PRINT_SCALE
): Promise<Blob> {
  return renderStockBatchPagePng(boxIds.map((id) => ({ qr: id, main: id })), layout ?? {}, size, scale);
}

function apiBaseUrl(): string {
  return (useRuntimeConfig().public.apiBaseUrl as string).replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const token = import.meta.client ? localStorage.getItem("admin_token") : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function throwOnError(res: Response): Promise<void> {
  if (res.ok) return;
  const text = (await res.text()).trim();
  throw new Error(text || `Request failed (${res.status})`);
}

/** GET /print/printers — available printers (flattened across print services). */
export async function listPrinters(): Promise<PrinterInfo[]> {
  const res = await fetch(`${apiBaseUrl()}/print/printers`, { headers: authHeaders() });
  console.log("res", res)
  await throwOnError(res);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/** Composite picker value for one printer: "<serviceId>.<deviceKey>". */
export function printerKey(p: PrinterInfo): string {
  return `${p.serviceId}.${p.deviceKey}`;
}

/** Split a printerKey back into its parts; null when the value is not a picker selection. */
export function parsePrinterKey(key: string): { serviceId: string; deviceKey: string } | null {
  const i = key.indexOf(".");
  if (i <= 0 || i === key.length - 1) return null;
  return { serviceId: key.slice(0, i), deviceKey: key.slice(i + 1) };
}

/** POST /print/files (multipart upload). Returns the created job. */
export async function printFile(file: Blob, filename: string, opts: PrintFileOptions): Promise<PrintJob> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("serviceId", opts.serviceId);
  form.append("deviceKey", opts.deviceKey);
  form.append("copies", String(opts.copies ?? 1));
  form.append("mode", opts.mode ?? "auto");
  if (opts.validateOnly) form.append("validateOnly", "true");
  for (const arg of opts.additionalArgs ?? []) form.append("additionalArgs", arg);

  const res = await fetch(`${apiBaseUrl()}/print/files`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  await throwOnError(res);
  // /print/files puts the job directly in the response body (no jobs[] wrap).
  const data = (await res.json()) as PrintJob & { jobs?: PrintJob[] };
  const job = data.jobs?.[0] ?? data;
  if (!job?.jobId) throw new Error("Print failed: response did not include a jobId");
  return job;
}

/** POST /print/dynamic — print one template; returns data incl. jobs[]. */
export async function dynamicPrint(opts: DynamicPrintOptions): Promise<{ jobs: PrintJob[] }> {
  const res = await fetch(`${apiBaseUrl()}/print/dynamic`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      copies: 1,
      mode: "auto",
      ...opts,
    }),
  });
  await throwOnError(res);
  return (await res.json()) as { jobs: PrintJob[] };
}

/** GET /print/jobs/{jobId} — current status of one print job. */
export async function getPrintJob(jobId: string): Promise<PrintJob> {
  const res = await fetch(`${apiBaseUrl()}/print/jobs/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(),
  });
  await throwOnError(res);
  return (await res.json()) as PrintJob;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the job until it reaches a terminal status ("success" / failed).
 *  Returns the final job; throws when the job failed or polling timed out. */
export async function waitForPrintJob(
  jobId: string,
  { timeoutMs = 30_000, intervalMs = 1_500 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<PrintJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getPrintJob(jobId);
    if (job.status === "success") return job;
    if (job.status === "failed" || job.status === "error") {
      throw new Error(
        `Print job ${job.status}${job.diagnostics?.length ? `: ${job.diagnostics.join("; ")}` : ""}`
      );
    }
    if (Date.now() >= deadline) throw new Error("Print job did not finish in time");
    await sleep(intervalMs);
  }
}
