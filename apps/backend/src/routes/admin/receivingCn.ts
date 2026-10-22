import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { db } from "../../db.js";
import { actorFrom } from "../../auth/middleware.js";
import { queryGet } from "../../db/query.js";
import { sql } from "drizzle-orm";
import {
  createCnUpload,
  getCnOrderDetail,
  getCnWorkflow,
  listCnOrders,
  listCnWorkflows,
  listCnOrderLogs,
  updateCnReceivingItemFields,
  validateCnPayload,
} from "../../db/receivingCn.js";
import type { OrderLogsParams } from "../../db/receiving.js";

// Customer receiving (CN) upload tracking (spec
// docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md):
// the admin console's tracking list + the Excel upload endpoint. All calls
// carry the admin JWT (mounted under /admin); actor comes from the token.
// PDF routes are phase 2 (blocked on the DocPal OCR-result endpoint).

export const adminReceivingCnRoute = new Hono();

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
// workflow has no order yet (the list chip carries its status).
adminReceivingCnRoute.get("/receiving-cn/orders/:batchNo", async (c) => {
  return c.json(await getCnOrderDetail(db, c.req.param("batchNo")), 200);
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

// Editable fields on one CN receiving invoice item (date code, lot code,
// COO, COW, CTN no, sub-inventory) — mirrors the standard flow's
// PATCH /admin/receiving-invoice-items/:id. `null` or "" clears a field;
// absent keys stay unchanged; a non-null subInventory must exist in org_info
// for the item's org. Returns the updated item row.
const CN_ITEM_EDITABLE = ["dateCode", "lotCode", "coo", "cow", "ctnNo"] as const;
const CN_ITEM_SUB_INVENTORY = "subInventory";

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

adminReceivingCnRoute.patch("/receiving-cn/items/:id", async (c) => {
  const body = await readJson<Record<string, unknown>>(c);
  const fields: Record<string, string | null> = {};
  for (const k of CN_ITEM_EDITABLE) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v !== null && typeof v !== "string") throw new HTTPException(400, { message: `${k} must be a string` });
    fields[k] = v === null || v.trim() === "" ? null : v.trim();
  }
  let subInventory: string | null | undefined = undefined;
  if (CN_ITEM_SUB_INVENTORY in body) {
    const v = body[CN_ITEM_SUB_INVENTORY];
    if (v !== null && typeof v !== "string")
      throw new HTTPException(400, { message: `${CN_ITEM_SUB_INVENTORY} must be a string` });
    subInventory = v === null || v.trim() === "" ? null : v.trim();
  }
  if (Object.keys(fields).length === 0 && subInventory === undefined)
    throw new HTTPException(400, { message: `at least one of ${[...CN_ITEM_EDITABLE, CN_ITEM_SUB_INVENTORY].join(", ")} is required` });
  return c.json(
    await updateCnReceivingItemFields(db, {
      itemId: c.req.param("id"),
      fields,
      actorId: actorFrom(c).id,
      subInventory,
    }),
    200
  );
});

// One tracking row incl. the verified payload items.
adminReceivingCnRoute.get("/receiving-cn/:id", async (c) => {
  return c.json(await getCnWorkflow(db, c.req.param("id")), 200);
});

// Excel upload: multipart (file + data JSON string of the verified rows) →
// DocPal file upload + workflow kick + tracking row. 400 file_required /
// invalid_payload; 502 docpal_workflow: ...; 500 docpal_workflow_token_not_configured.
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
  const tokenUser = actorFrom(c);
  const displayName =
    (
      await queryGet<{ displayName: string }>(
        db,
        sql`SELECT display_name AS "displayName" FROM users WHERE id = ${tokenUser.id}`
      )
    )?.displayName ?? tokenUser.username;
  const result = await createCnUpload(db, {
    phase: "excel",
    file: { filename: file.name || "upload.xls", mime: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) },
    payload,
    actor: { id: tokenUser.id, username: tokenUser.username, displayName },
  });
  return c.json(result, 201);
});
