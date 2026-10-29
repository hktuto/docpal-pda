/**
 * Client for the backend print proxy job reads (/print/jobs/*) — printing
 * itself goes through POST /picking-orders/:id/label-print (backend-side
 * param conversion, spec 2026-10-29). Uses the shared services/apiClient
 * wrapper (token, base URL from the /server picker, error mapping).
 */
import { createApiClient, type ApiClient } from "../services/apiClient";
import type { PrintJob } from "../services/types";
import { getApiBaseUrl } from "./serverHost";

let client: ApiClient | null = null;

/** Shared client, created lazily so the picker-saved host is already loaded. */
function api(): ApiClient {
  client ??= createApiClient({ baseUrl: getApiBaseUrl() });
  return client;
}

/** GET /print/jobs/:jobId — current status of one print job. */
export function getPrintJob(jobId: string): Promise<PrintJob> {
  return api().get<PrintJob>(`/print/jobs/${encodeURIComponent(jobId)}`);
}

/** One printer as returned by the print service's agent-printers list. */
export interface PrinterInfo {
  serviceId: string;
  deviceKey: string;
  name?: string;
  alias?: string;
}

/** GET /print/printers — available printers (flattened across print services). */
export async function listPrinters(): Promise<PrinterInfo[]> {
  const data = await api().get<unknown>("/print/printers");
  return Array.isArray(data) ? (data as PrinterInfo[]) : [];
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
