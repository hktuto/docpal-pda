import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../../db.js";
import { actorFrom } from "../../auth/middleware.js";
import { cnReceiving } from "../../config.js";
import { queryGet } from "../../db/query.js";
import { sql } from "drizzle-orm";
import {
  confirmCnOrder,
  createCnUpload,
  getCnOrderDetail,
  getCnWorkflow,
  listCnOrders,
  listCnWorkflows,
  listCnOrderLogs,
  prepareCnOrderDetail,
  updateCnReceivingItemFields,
  validateCnPayload,
} from "../../db/receivingCn.js";
import type { OrderLogsParams } from "../../db/receiving.js";

// Customer receiving (CN) upload tracking (spec
// docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md):
// the admin console's tracking list + the upload endpoints. Phase 1 (excel) is
// superseded by the PDA manual receiving flow; phase 2 (pdf) uploads the
// scanned PDF and lets DocPal OCR extract the data inside the workflow (the
// verify step comes later). All calls carry the admin JWT (mounted under
// /admin); actor comes from the token.

export const adminReceivingCnRoute = new Hono();

// The whole CN surface is config-gated: with the `receiving-cn` flow step off
// (the default) every route 404s, matching the PDA /put-away-cn gating — a
// warehouse runs either the standard or the CN flow, so the API stays
// invisible until the admin enables the step.
adminReceivingCnRoute.use("*", async (c, next) => {
  if (!cnReceiving()) throw new HTTPException(404, { message: "not_found" });
  await next();
});

// Tracking list, newest first. ?status= filters (repeatable), ?page=&pageSize=
// for server paging → {rows, total}.
adminReceivingCnRoute.get("/receiving-cn", async (c) => {
  const repeated = c.req.queries("status");
  const single = c.req.query("status");
  const status = repeated ?? (single ? [single] : undefined);
  return c.json(
    await listCnWorkflows(db, {
      status,
      page: Number(c.req.query("page") ?? 1),
      pageSize: Number(c.req.query("pageSize") ?? 20),
    }),
    200
  );
});

// Order-centric list: paged receiving_orders_cn rows + "pending" placeholders
// for workflows whose order hasn't synced yet → {rows, total, pending}.
// `?search=` ILIKE-filters both sections (batch_no / workflow invoice_no /
// supplier). Registered BEFORE /receiving-cn/:id — Hono's param route would
// otherwise capture the literal "orders".
adminReceivingCnRoute.get("/receiving-cn/orders", async (c) => {
  return c.json(
    await listCnOrders(db, {
      page: Number(c.req.query("page") ?? 1),
      pageSize: Number(c.req.query("pageSize") ?? 20),
      search: c.req.query("search"),
    }),
    200
  );
});

// One CN order by batch_no: order + invoices + items (invoice no on each
// item) + the put-away task. 404 receiving_cn_order_not_found — a pending-only
// workflow has no order yet (the list chip carries its status). Opening the
// detail first runs the pending-order prepare (item org/sub from po_no +
// arrival stamp) so the admin always sees the normalized record.
adminReceivingCnRoute.get("/receiving-cn/orders/:batchNo", async (c) => {
  const batchNo = c.req.param("batchNo");
  await prepareCnOrderDetail(db, batchNo, actorFrom(c).id);
  return c.json(await getCnOrderDetail(db, batchNo), 200);
});

// Admin confirm of a pending CN order (the pdf path's receipt moment):
// pending → in_hand + arrival stamp, received_qty fill, CN put-away task,
// audit + SSE. 404 receiving_cn_order_not_found; 409 order_not_pending.
adminReceivingCnRoute.post("/receiving-cn/orders/:batchNo/confirm", async (c) => {
  const actor = actorFrom(c);
  return c.json(
    await confirmCnOrder(db, c.req.param("batchNo"), { id: actor.id, username: actor.username }),
    200
  );
});

// Audit trail (transaction_logs) for one CN order: order rows + its
// invoice-item rows (+ the finalize task/workflow rows referencing the order).
// Optional ?page/?pageSize/?q/?sort/?dir — same convention as the standard
// GET /admin/receiving-orders/:id/logs (sort whitelist createdDate, actorName,
// toState); without them the full array is returned.
function logParams(c: { req: { query: (name: string) => string | undefined } }): OrderLogsParams {
  const page = c.req.query("page");
  const q = (c.req.query("q") ?? "").trim();
  const sort = c.req.query("sort");
  const rawDir = c.req.query("dir");
  const dir: "asc" | "desc" | undefined = rawDir === "asc" || rawDir === "desc" ? rawDir : undefined;
  return {
    page: page !== undefined ? Math.max(1, Number(page) || 1) : undefined,
    pageSize: Math.min(200, Math.max(1, Number(c.req.query("pageSize")) || 50)),
    q: q || undefined,
    sort,
    dir,
  };
}

adminReceivingCnRoute.get("/receiving-cn/orders/:batchNo/logs", async (c) => {
  const params = logParams(c);
  if (params.page === undefined && !params.q) return c.json(await listCnOrderLogs(db, c.req.param("batchNo")));
  return c.json(await listCnOrderLogs(db, c.req.param("batchNo"), params));
});

// Editable fields on one CN receiving invoice item (part no, wcl item no,
// po no, qty, date code, lot code, COO, COW, CTN no, sub-inventory, suggested
// shelf override) — mirrors the standard flow's PATCH
// /admin/receiving-invoice-items/:id. `null` or "" clears a string field;
// absent keys stay unchanged; a non-null subInventory must exist in org_info
// for the item's org; lineQty must be a positive integer (received_qty
// follows while still 0). A wclItemNo change wins over partNo: a unique
// parts-master match supplies the canonical wcl_item_no AND applies its
// part_no; a bare partNo change re-resolves wcl_item_no (NULL when no unique
// match). suggestedShelf persists inside additional_data (override; cleared
// back to the computed suggestion with null/""). Returns the updated item row.
const CN_ITEM_EDITABLE = ["partNo", "wclItemNo", "poNo", "dateCode", "lotCode", "coo", "cow", "ctnNo"] as const;
const CN_ITEM_SUB_INVENTORY = "subInventory";
const CN_ITEM_SUGGESTED_SHELF = "suggestedShelf";

// Empty bodies parse as {} (same convention as the flow routes).
async function readJson<T>(c: Context): Promise<T> {
  const text = await c.req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

function parseNullableString(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v !== null && typeof v !== "string") throw new HTTPException(400, { message: `${key} must be a string` });
  return v === null || v.trim() === "" ? null : v.trim();
}

adminReceivingCnRoute.patch("/receiving-cn/items/:id", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const fields: Record<string, string | null> = {};
  for (const k of CN_ITEM_EDITABLE) {
    const parsed = parseNullableString(body, k);
    if (parsed !== undefined) fields[k] = parsed;
  }
  const subInventory = parseNullableString(body, CN_ITEM_SUB_INVENTORY);
  const suggestedShelf = parseNullableString(body, CN_ITEM_SUGGESTED_SHELF);
  let lineQty: number | undefined;
  if ("lineQty" in body) {
    const v = body.lineQty;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new HTTPException(400, { message: "lineQty must be a positive integer" });
    }
    lineQty = v;
  }
  if (Object.keys(fields).length === 0 && subInventory === undefined && suggestedShelf === undefined && lineQty === undefined)
    throw new HTTPException(400, {
      message: `at least one of ${[...CN_ITEM_EDITABLE, "lineQty", CN_ITEM_SUB_INVENTORY, CN_ITEM_SUGGESTED_SHELF].join(", ")} is required`,
    });
  return c.json(
    await updateCnReceivingItemFields(db, {
      itemId: c.req.param("id"),
      fields,
      actorId: actorFrom(c).id,
      lineQty,
      subInventory,
      suggestedShelf,
    }),
    200
  );
});

// One tracking row incl. the verified payload items.
adminReceivingCnRoute.get("/receiving-cn/:id", async (c) => {
  return c.json(await getCnWorkflow(db, c.req.param("id")), 200);
});

/** Token user + users.display_name for the workflow creator variables. */
async function cnUploadActor(c: Context): Promise<{ id: string; username: string; displayName: string }> {
  const tokenUser = actorFrom(c);
  const displayName =
    (
      await queryGet<{ displayName: string }>(
        db,
        sql`SELECT display_name AS "displayName" FROM users WHERE id = ${tokenUser.id}`
      )
    )?.displayName ?? tokenUser.username;
  return { id: tokenUser.id, username: tokenUser.username, displayName };
}

// Excel upload (phase 1, superseded by the PDA manual receiving flow — kept
// for existing workflow definitions): multipart (file + data JSON string of
// the verified rows) → DocPal file upload + workflow kick + tracking row.
// 400 file_required / invalid_payload; 502 docpal_workflow: ...;
// 500 docpal_workflow_token_not_configured.
adminReceivingCnRoute.post("/receiving-cn/excel", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) throw new HTTPException(400, { message: "file_required" });
  const rawData = body.data;
  if (typeof rawData !== "string") throw new HTTPException(400, { message: "invalid_payload" });
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawData);
  } catch {
    throw new HTTPException(400, { message: "invalid_payload" });
  }
  const payload = validateCnPayload(parsedJson);
  const result = await createCnUpload(db, {
    phase: "excel",
    file: { filename: file.name || "upload.xls", mime: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) },
    payload,
    actor: await cnUploadActor(c),
  });
  return c.json(result, 201);
});

// PDF upload (phase 2): multipart file only — no verified payload; DocPal OCR
// extracts the receiving data inside the workflow (the verify step comes
// later). The kick sends the file entry under variables.pdfFiles. 400
// file_required / invalid_file_type; 502 docpal_workflow: ...; 500
// docpal_workflow_token_not_configured / docpal_workflow_definition_not_configured.
adminReceivingCnRoute.post("/receiving-cn/pdf", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) throw new HTTPException(400, { message: "file_required" });
  const filename = file.name || "upload.pdf";
  if (file.type !== "application/pdf" && !filename.toLowerCase().endsWith(".pdf")) {
    throw new HTTPException(400, { message: "invalid_file_type" });
  }
  const result = await createCnUpload(db, {
    phase: "pdf",
    file: { filename, mime: file.type || "application/pdf", bytes: new Uint8Array(await file.arrayBuffer()) },
    actor: await cnUploadActor(c),
  });
  return c.json(result, 201);
});
