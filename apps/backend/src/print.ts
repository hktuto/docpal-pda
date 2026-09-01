// Client for the label-printing-center print service. Base URL comes from
// PRINT_API_BASE_URL (config.printApiBaseUrl). The HTTP surface is
// src/routes/print.ts; upstream API doc: docs/backend/print-service.md.

import { HTTPException } from "hono/http-exception";
import { printApiBaseUrl } from "./config.js";

interface PrintEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

export interface DynamicPrintBody {
  templateId: string;
  printingParams: Record<string, unknown>[];
  printerName?: string;
  copies?: number;
  mode?: string;
  orientation?: string;
}

/** Upstream reads (printer list, job status) are quick; prints block until the
 *  job reaches the printer, so they get a generous timeout. */
const READ_TIMEOUT_MS = 10_000;
const PRINT_TIMEOUT_MS = 120_000;

async function readEnvelope(res: Response): Promise<unknown> {
  const body = (await res.json().catch(() => null)) as PrintEnvelope | null;
  if (!res.ok || !body?.ok) {
    const msg = body?.error?.message || res.statusText || "print service error";
    throw new HTTPException(502, { message: `print service: ${msg}` });
  }
  return body.data;
}

async function callPrintService(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${printApiBaseUrl()}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw new HTTPException(502, { message: `print service unreachable: ${(e as Error).message}` });
  }
  return readEnvelope(res);
}

/** GET /api/v1/printers — available system printers. */
export async function listPrinters(): Promise<unknown> {
  return callPrintService("/api/v1/printers", {}, READ_TIMEOUT_MS);
}

/** POST /api/v1/templates/dynamic-print — print one template with params. */
export async function dynamicPrint(payload: DynamicPrintBody): Promise<unknown> {
  return callPrintService(
    "/api/v1/templates/dynamic-print",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    PRINT_TIMEOUT_MS,
  );
}

/** POST /api/v1/print/files — forward a direct file print (multipart upload or
 *  JSON with filePath/pdfPath/imagePath) verbatim. */
export async function printFiles(req: Request): Promise<unknown> {
  const headers: Record<string, string> = {};
  const contentType = req.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  return callPrintService(
    "/api/v1/print/files",
    {
      method: "POST",
      headers,
      body: req.body,
      // @ts-expect-error Node fetch requires duplex when body is a stream
      duplex: "half",
    },
    PRINT_TIMEOUT_MS,
  );
}

/** GET /api/v1/print/jobs/{jobId} — current status of one print job. */
export async function getPrintJob(jobId: string): Promise<unknown> {
  return callPrintService(`/api/v1/print/jobs/${encodeURIComponent(jobId)}`, {}, READ_TIMEOUT_MS);
}
