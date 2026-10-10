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

// Label stock: 70 x 37 mm at 300 dpi, shared by the shelf and shelf-box
// labels. The layout is a QR code on the left (encoding the scannable code —
// the shelf code or the box id, which is what the PDA scans) with a big text
// line on the right and an optional smaller line below it.
const LABEL_STOCK_W = 826;
const LABEL_STOCK_H = 437;

interface LabelCell {
  /** Value encoded in the QR code (what the PDA scans). */
  qr: string;
  /** Big text line on the right of the QR. */
  main: string;
  /** Optional smaller line below the main text (e.g. the shelf zone). */
  sub?: string | null;
}

interface LabelLayout {
  /** Draw a light border around the label for easy cutting (SZ warehouse). */
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

// Draw one label cell (the 70 x 37 mm design) at (x, y), scaled by `s`, into
// an existing context. QR on the left, centered vertically; text block on the
// right, vertically centered like the single-label design.
async function drawLabelCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  s: number,
  cell: LabelCell,
  layout: LabelLayout
): Promise<void> {
  const qrSize = 360 * s;
  const qr = new Image();
  qr.src = await QRCode.toDataURL(cell.qr, {
    width: Math.max(1, Math.round(qrSize * 2)), // render sharp, draw scaled
    margin: 1,
    errorCorrectionLevel: "M",
  });
  await qr.decode();
  ctx.drawImage(qr, x + 28 * s, y + (h - qrSize) / 2, qrSize, qrSize);

  const textX = x + 416 * s;
  const textW = w - 416 * s - 28 * s;
  const cx = textX + textW / 2;
  const topPad = (h - LABEL_STOCK_H * s) / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#0f1720";
  ctx.font = `700 ${Math.round(112 * s)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillText(cell.main, cx, y + topPad + 260 * s, textW);
  const sub = cell.sub?.trim();
  if (sub) {
    ctx.fillStyle = "#4b5563";
    ctx.font = `${Math.round(32 * s)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillText(sub, cx, y + topPad + 340 * s, textW);
  }

  if (layout.border) {
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = Math.max(1, Math.round(2 * s));
    ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  }
}

/** Render one 70 x 37 mm label to a PNG blob for /print/files. */
async function renderStockLabelPng(cell: LabelCell, layout: LabelLayout): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = LABEL_STOCK_W;
  canvas.height = LABEL_STOCK_H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, LABEL_STOCK_W, LABEL_STOCK_H);
  await drawLabelCell(ctx, 0, 0, LABEL_STOCK_W, LABEL_STOCK_H, 1, cell, layout);
  return canvasToPng(canvas);
}

/** Render one shelf label to a PNG blob for /print/files. */
export function renderShelfLabelPng(
  code: string,
  zone?: string | null,
  displayName?: string | null,
  layout?: LabelLayout
): Promise<Blob> {
  return renderStockLabelPng({ qr: code, main: displayName?.trim() || code, sub: zone }, layout ?? {});
}

/** Render one shelf-box label to a PNG blob for /print/files. */
export function renderShelfBoxLabelPng(boxId: string, layout?: LabelLayout): Promise<Blob> {
  return renderStockLabelPng({ qr: boxId, main: boxId }, layout ?? {});
}

// A4 batch sheet for multi-select label printing: 3 x 8 labels per A4 page at
// 300 dpi (same cell content as the single labels, scaled to the grid).
export const A4_PAGE_W = 2480;
export const A4_PAGE_H = 3508;
const BATCH_COLS = 3;
const BATCH_ROWS = 8;
export const SHELF_BATCH_CELLS_PER_PAGE = BATCH_COLS * BATCH_ROWS;

/** Render one A4 page of labels to a PNG blob for /print/files. */
async function renderStockBatchPagePng(cells: LabelCell[], layout: LabelLayout): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = A4_PAGE_W;
  canvas.height = A4_PAGE_H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, A4_PAGE_W, A4_PAGE_H);

  const margin = 0; // no page margin — printer handles its own printable area
  const gap = 47; // 4mm between cells
  const cellW = (A4_PAGE_W - 2 * margin - (BATCH_COLS - 1) * gap) / BATCH_COLS;
  const cellH = (A4_PAGE_H - 2 * margin - (BATCH_ROWS - 1) * gap) / BATCH_ROWS;
  const s = cellW / LABEL_STOCK_W;

  for (const [i, cell] of cells.entries()) {
    const col = i % BATCH_COLS;
    const row = Math.floor(i / BATCH_COLS);
    const x = margin + col * (cellW + gap);
    const y = margin + row * (cellH + gap);
    await drawLabelCell(ctx, x, y, cellW, cellH, s, cell, layout);
  }

  return canvasToPng(canvas);
}

/** Render one A4 page of shelf labels to a PNG blob for /print/files. */
export function renderShelfBatchPagePng(
  cells: { code: string; zone?: string | null; displayName?: string | null }[],
  layout?: LabelLayout
): Promise<Blob> {
  return renderStockBatchPagePng(
    cells.map((c) => ({ qr: c.code, main: c.displayName?.trim() || c.code, sub: c.zone })),
    layout ?? {}
  );
}

/** Render one A4 page of shelf-box labels to a PNG blob for /print/files. */
export function renderShelfBoxBatchPagePng(boxIds: string[], layout?: LabelLayout): Promise<Blob> {
  return renderStockBatchPagePng(boxIds.map((id) => ({ qr: id, main: id })), layout ?? {});
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
