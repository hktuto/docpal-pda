/**
 * Client for the backend print proxy (apps/backend/src/routes/print.ts), which
 * forwards to the label-printing-center print service (PRINT_API_BASE_URL on
 * the backend). The browser no longer talks to the print service directly.
 * Upstream API doc: docs/backend/print-service.md
 */
import QRCode from "qrcode";
import JsBarcode from "jsbarcode";
export interface PrintFileOptions {
  printerName: string;
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

/** Template used for shelf / shelf-box labels on the print service. */
export const LABEL_TEMPLATE_ID = "katata-label";

/** katata-label params for one shelf code label (QR + human-readable code). */
export function shelfLabelParams(code: string): Record<string, unknown> {
  return {
    deliveryName: "SHELF",
    itemNum: code,
    sku: code,
    qrcode: code,
    qty: "",
    cust: "",
    makeIn: "",
  };
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

/** GET /print/printers — available system printer names. */
export async function listPrinters(): Promise<string[]> {
  const res = await fetch(`${apiBaseUrl()}/print/printers`, { headers: authHeaders() });
  await throwOnError(res);
  const data = await res.json();
  return Array.isArray(data) ? data : ((data?.printers as string[] | undefined) ?? []);
}

/** POST /print/files (multipart upload). Returns the created job. */
export async function printFile(file: Blob, filename: string, opts: PrintFileOptions): Promise<PrintJob> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("printerName", opts.printerName);
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
