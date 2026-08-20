/**
 * Client helper for the server's print service (label-printing-center).
 * API doc: docs/backend/print-service.md
 *
 * Base URL: runtimeConfig.public.printBaseUrl when set
 * (NUXT_PUBLIC_PRINT_BASE_URL); otherwise derived from the API base URL by
 * swapping the port to 9003 — in prod both live on PRODUCTION_URL.
 */
export interface PrintFileOptions {
  printerName: string;
  copies?: number;
  mode?: string;
  validateOnly?: boolean;
  additionalArgs?: string[];
}

export interface PrintJob {
  jobId: string;
  status: string;
  diagnostics?: string[];
}

export function getPrintBaseUrl(): string {
  const config = useRuntimeConfig();
  const explicit = (config.public.printBaseUrl as string | undefined)?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const api = new URL(config.public.apiBaseUrl as string);
  api.port = "9003";
  return api.origin;
}

interface PrintEnvelope {
  ok: boolean;
  data?: any;
  error?: { code?: string; message?: string };
}

async function readEnvelope(res: Response): Promise<PrintEnvelope> {
  const body = (await res.json().catch(() => null)) as PrintEnvelope | null;
  if (!res.ok || !body?.ok) {
    const msg = body?.error?.message || res.statusText;
    throw new Error(`Print failed (${res.status}): ${msg}`);
  }
  return body;
}

/** POST /api/v1/print/files (multipart upload). Returns the created job. */
export async function printFile(
  baseUrl: string,
  file: Blob,
  filename: string,
  opts: PrintFileOptions
): Promise<PrintJob> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("printerName", opts.printerName);
  form.append("copies", String(opts.copies ?? 1));
  form.append("mode", opts.mode ?? "auto");
  if (opts.validateOnly) form.append("validateOnly", "true");
  for (const arg of opts.additionalArgs ?? []) form.append("additionalArgs", arg);

  const res = await fetch(`${baseUrl}/api/v1/print/files`, { method: "POST", body: form });
  const body = await readEnvelope(res);
  const job = body.data?.jobs?.[0] ?? body.data;
  if (!job?.jobId) throw new Error("Print failed: response did not include a jobId");
  return job as PrintJob;
}

/** GET /api/v1/print/jobs/{jobId} — current status of one print job. */
export async function getPrintJob(baseUrl: string, jobId: string): Promise<PrintJob> {
  const res = await fetch(`${baseUrl}/api/v1/print/jobs/${encodeURIComponent(jobId)}`);
  const body = await readEnvelope(res);
  return body.data as PrintJob;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the job until it reaches a terminal status ("success" / failed).
 *  Returns the final job; throws when the job failed or polling timed out. */
export async function waitForPrintJob(
  baseUrl: string,
  jobId: string,
  { timeoutMs = 30_000, intervalMs = 1_500 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<PrintJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getPrintJob(baseUrl, jobId);
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
