import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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
  validateCnPayload,
} from "../../db/receivingCn.js";

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
// Registered BEFORE /receiving-cn/:id — Hono's param route would otherwise
// capture the literal "orders".
adminReceivingCnRoute.get("/receiving-cn/orders", async (c) => {
  return c.json(
    await listCnOrders(db, {
      page: Number(c.req.query("page") ?? 1),
      pageSize: Number(c.req.query("pageSize") ?? 20),
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
