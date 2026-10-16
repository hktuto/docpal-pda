// Client for the DocPal workflow/file APIs (spec
// docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md).
// Mirrors src/print.ts error handling: AbortSignal timeout, upstream failure →
// HTTPException 502 with a "docpal_workflow: " message prefix. All calls send
// Authorization: Bearer <DOCPAL_WORKFLOW_TOKEN> (a static service token; the
// API is confirmed not to verify it — the real user travels in the start
// variables instead).

import { HTTPException } from "hono/http-exception";
import { docpalBaseUrl, docpalWorkflowToken } from "./config.js";

const TIMEOUT_MS = 30_000;

/** DocPal wraps most payloads in {code, result, data} — unwrap when present. */
function unwrapEnvelope(body: unknown): unknown {
  if (
    typeof body === "object" && body !== null && !Array.isArray(body) &&
    "data" in body &&
    ("code" in body || "result" in body)
  ) {
    return (body as { data: unknown }).data;
  }
  return body;
}

async function readBody(res: Response): Promise<unknown> {
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg =
      (typeof body === "object" && body !== null && "message" in body && String((body as { message: unknown }).message)) ||
      res.statusText ||
      "docpal workflow error";
    throw new HTTPException(502, { message: `docpal_workflow: ${msg}` });
  }
  return unwrapEnvelope(body);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = docpalWorkflowToken();
  if (!token) throw new HTTPException(500, { message: "docpal_workflow_token_not_configured" });
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function callDocpal(path: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const base = docpalBaseUrl();
  if (!base) throw new HTTPException(500, { message: "docpal_url_not_configured" });
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw new HTTPException(502, { message: `docpal_workflow: unreachable: ${(e as Error).message}` });
  }
  return readBody(res);
}

export interface WorkflowFileUpload {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/** POST /api/docpal/workflow/upload/file — multipart upload of one workflow
 *  attachment; returns the data object (document id = data.id). */
export async function uploadWorkflowFile(
  filename: string,
  mime: string,
  bytes: Uint8Array,
  title: string
): Promise<WorkflowFileUpload> {
  const form = new FormData();
  form.set("document", JSON.stringify({ properties: { "dc:title": title }, type: "File" }));
  form.set("nonPermission", "true");
  form.set("file", new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }), filename);
  const data = await callDocpal(
    "/api/docpal/workflow/upload/file",
    { method: "POST", headers: authHeaders(), body: form }
  );
  if (typeof data !== "object" || data === null || typeof (data as { id?: unknown }).id !== "string") {
    throw new HTTPException(502, { message: "docpal_workflow: upload response missing data.id" });
  }
  return data as WorkflowFileUpload;
}

/** DELETE /api/docpal/workflow/task/attachment — cleanup for an uploaded
 *  attachment when the process kick fails. */
export async function deleteWorkflowAttachment(documentId: string): Promise<void> {
  await callDocpal(
    `/api/docpal/workflow/task/attachment?attachmentId=${encodeURIComponent(documentId)}`,
    { method: "DELETE", headers: authHeaders() }
  );
}

export interface StartedProcess {
  id: string;
  business_key?: string;
  [key: string]: unknown;
}

/** POST /oniflow/api/v1/processes — kick a workflow definition with variables. */
export async function startProcess(
  definitionId: string,
  variables: Record<string, unknown>
): Promise<StartedProcess> {
  const data = await callDocpal(
    "/oniflow/api/v1/processes",
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ start_user_id: variables.start_user_id, definition_id: definitionId, variables }),
    }
  );
  if (typeof data !== "object" || data === null || typeof (data as { id?: unknown }).id !== "string") {
    throw new HTTPException(502, { message: "docpal_workflow: process start response missing data.id" });
  }
  return data as StartedProcess;
}

/** GET /oniflow/api/v1/processes/:id — process status for the cron. Tolerates
 *  DocPal's {code,result,data} envelope. */
export async function getProcess(processId: string): Promise<{ state?: { type?: string } } & Record<string, unknown>> {
  const data = await callDocpal(
    `/oniflow/api/v1/processes/${encodeURIComponent(processId)}`,
    { method: "GET", headers: authHeaders() }
  );
  if (typeof data !== "object" || data === null) {
    throw new HTTPException(502, { message: "docpal_workflow: unexpected process response" });
  }
  return data as { state?: { type?: string } } & Record<string, unknown>;
}

/** Phase 2 (PDF + OCR): DocPal OCR-result endpoint is not yet confirmed. */
export async function getOcrResult(_documentId: string): Promise<never> {
  throw new HTTPException(500, { message: "docpal_workflow: ocr_result_not_implemented" });
}
