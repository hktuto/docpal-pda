/**
 * Client for the backend print proxy (apps/backend/src/routes/print.ts), which
 * forwards to the label-printing-center print service (PRINT_API_BASE_URL on
 * the backend). The browser no longer talks to the print service directly.
 * Upstream API doc: docs/backend/print-service.md
 */
import QRCode from "qrcode";
import JsBarcode from "jsbarcode";
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

// Shelf label stock: 70 x 37 mm at 300 dpi (same stock as the shelf-box
// labels). The layout is a QR code on the left, then "SHELF", the shelf code,
// and the zone (when set) on the right — the code is what the PDA scans.
const SHELF_LABEL_W = 826;
const SHELF_LABEL_H = 437;

/** Render one shelf label to a PNG blob for /print/files. */
export async function renderShelfLabelPng(code: string, zone?: string | null): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = SHELF_LABEL_W;
  canvas.height = SHELF_LABEL_H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, SHELF_LABEL_W, SHELF_LABEL_H);

  // QR code on the left, centered vertically.
  const qrSize = 360;
  const qr = new Image();
  qr.src = await QRCode.toDataURL(code, { width: qrSize, margin: 1, errorCorrectionLevel: "M" });
  await qr.decode();
  ctx.drawImage(qr, 28, (SHELF_LABEL_H - qrSize) / 2, qrSize, qrSize);

  // Text block on the right of the QR.
  const textX = 416;
  const textW = SHELF_LABEL_W - textX - 28;
  const cx = textX + textW / 2;
  ctx.textAlign = "center";
  ctx.fillStyle = "#64748b";
  ctx.font = "700 28px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText("SHELF", cx, 140, textW);
  ctx.fillStyle = "#0f1720";
  ctx.font = "700 56px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText(code, cx, 224, textW);
  const z = zone?.trim();
  if (z) {
    ctx.fillStyle = "#4b5563";
    ctx.font = "32px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(z, cx, 304, textW);
  }

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png"
    )
  );
}

// A4 batch sheet for multi-select shelf printing: 3 x 4 shelf labels per A4
// page at 300 dpi (QR + shelf code + zone per cell, same content as the
// single shelf label).
const A4_PAGE_W = 2480;
const A4_PAGE_H = 3508;
const BATCH_COLS = 3;
const BATCH_ROWS = 4;
export const SHELF_BATCH_CELLS_PER_PAGE = BATCH_COLS * BATCH_ROWS;

/** Render one A4 page of shelf labels to a PNG blob for /print/files. */
export async function renderShelfBatchPagePng(
  cells: { code: string; zone?: string | null }[]
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = A4_PAGE_W;
  canvas.height = A4_PAGE_H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, A4_PAGE_W, A4_PAGE_H);

  const margin = 118; // 10mm page margin
  const gap = 47; // 4mm between cells
  const cellW = (A4_PAGE_W - 2 * margin - (BATCH_COLS - 1) * gap) / BATCH_COLS;
  const cellH = (A4_PAGE_H - 2 * margin - (BATCH_ROWS - 1) * gap) / BATCH_ROWS;
  const qrSize = 520; // ~44mm

  for (const [i, cell] of cells.entries()) {
    const col = i % BATCH_COLS;
    const row = Math.floor(i / BATCH_COLS);
    const x = margin + col * (cellW + gap);
    const y = margin + row * (cellH + gap);
    const cx = x + cellW / 2;

    const qr = new Image();
    qr.src = await QRCode.toDataURL(cell.code, {
      width: qrSize,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    await qr.decode();

    // QR + code + optional zone, vertically centered as a stack in the cell.
    const zone = cell.zone?.trim();
    const stackH = qrSize + 110 + (zone ? 85 : 0);
    let cy = y + (cellH - stackH) / 2;
    ctx.drawImage(qr, cx - qrSize / 2, cy, qrSize, qrSize);
    cy += qrSize + 65;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#0f1720";
    ctx.font = "700 83px system-ui, sans-serif"; // ~20pt
    ctx.fillText(cell.code, cx, cy, cellW - 40);
    if (zone) {
      ctx.fillStyle = "#4b5563";
      ctx.font = "50px system-ui, sans-serif"; // ~12pt
      ctx.fillText(zone, cx, cy + 80, cellW - 40);
    }
  }

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png"
    )
  );
}

// Shelf-box label stock: 70 x 37 mm at 300 dpi. The layout is a QR code, then
// the box id as text, then a Code 128 barcode — all carrying the same value
// (the box id, which is what the PDA scans).
const BOX_LABEL_W = 826;
const BOX_LABEL_H = 437;

/**
 * Render one shelf-box label to a PNG blob for /print/files (same route as
 * the user badges).
 */
export async function renderShelfBoxLabelPng(boxId: string): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = BOX_LABEL_W;
  canvas.height = BOX_LABEL_H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, BOX_LABEL_W, BOX_LABEL_H);

  // QR code, centered at the top.
  const qrSize = 200;
  const qr = new Image();
  qr.src = await QRCode.toDataURL(boxId, { width: qrSize, margin: 1, errorCorrectionLevel: "M" });
  await qr.decode();
  ctx.drawImage(qr, (BOX_LABEL_W - qrSize) / 2, 18, qrSize, qrSize);

  // The label: the box id, centered below the QR.
  ctx.textAlign = "center";
  ctx.fillStyle = "#0f1720";
  ctx.font = "700 38px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText(boxId, BOX_LABEL_W / 2, 272);

  // Code 128 barcode of the same value, centered at the bottom.
  const barcode = document.createElement("canvas");
  JsBarcode(barcode, boxId, {
    format: "CODE128",
    displayValue: false,
    margin: 0,
    height: 84,
    width: 2,
  });
  const maxW = BOX_LABEL_W - 48;
  if (barcode.width > maxW) {
    JsBarcode(barcode, boxId, {
      format: "CODE128",
      displayValue: false,
      margin: 0,
      height: 84,
      width: (2 * maxW) / barcode.width,
    });
  }
  ctx.drawImage(barcode, (BOX_LABEL_W - barcode.width) / 2, 298);

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/png"
    )
  );
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
