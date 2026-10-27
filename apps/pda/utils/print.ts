/**
 * Client for the backend print proxy (/print/*), mirroring
 * apps/admin/utils/print.ts but over the shared services/apiClient wrapper
 * (token, base URL from the /server picker, error mapping) instead of raw
 * fetch. v1 sends no printerName — the print service uses the template's
 * default printer. Upstream API doc: docs/backend/print-service.md
 */
import { createApiClient, type ApiClient } from "../services/apiClient";
import { getApiBaseUrl } from "./serverHost";

export interface PrintJob {
  jobId: string;
  status: string;
  diagnostics?: string[];
}

let client: ApiClient | null = null;

/** Shared client, created lazily so the picker-saved host is already loaded. */
function api(): ApiClient {
  client ??= createApiClient({ baseUrl: getApiBaseUrl() });
  return client;
}

/** POST /print/dynamic — print one template; returns data incl. jobs[]. */
export async function dynamicPrint(opts: {
  templateId: string;
  printingParams: Record<string, unknown>[];
}): Promise<{ jobs: PrintJob[] }> {
  return api().post<{ jobs: PrintJob[] }>("/print/dynamic", {
    copies: 1,
    mode: "auto",
    ...opts,
  });
}

/** GET /print/jobs/:jobId — current status of one print job. */
export function getPrintJob(jobId: string): Promise<PrintJob> {
  return api().get<PrintJob>(`/print/jobs/${encodeURIComponent(jobId)}`);
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
