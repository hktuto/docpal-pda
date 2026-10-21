import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { AppDb } from "../db.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { queryAll, queryGet, type DbOrTx } from "./query.js";
import { receivingCnWorkflows, transactionLogs } from "./schema/index.js";
import { emitEvent } from "./events.js";
import {
  deleteWorkflowAttachment,
  startProcess,
  uploadWorkflowFile,
} from "../docpalWorkflow.js";
import { docpalCnExcelWorkflowId, docpalCnPdfWorkflowId } from "../config.js";

// ---------------------------------------------------------------------------
// Customer receiving (CN) upload domain (spec
// docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md).
// The admin uploads the customer receiving Excel + the verified rows; we
// forward both to DocPal (file upload → workflow kick) and track the workflow
// in receiving_cn_workflows. The status cron (src/jobs/receivingCnSync.ts)
// polls DocPal and, on completion, finalizes the CN order (written by the
// external upstream sync, matched by batch_no = CN 編號) and creates the
// dedicated CN put-away task.
// ---------------------------------------------------------------------------

export interface CnUploadItem {
  /** Wire contract: the sheet's 发货項 value (may be blank). */
  orderNo: string;
  cartonNo?: string;
  partNo: string;
  dateCode?: string;
  qty: number;
  weight?: string;
  office?: string;
  /** Wire contract: the sheet's 訂單號 value (required). */
  poNo?: string;
  remark?: string;
}

/** The verified excel_result_data the admin app sends alongside the file. */
export interface CnUploadPayload {
  receivedOffice?: string;
  supplier?: string;
  receiptNo?: string;
  invoiceNo?: string;
  receivedDate?: string;
  items: CnUploadItem[];
}

const HEADER_STRING_FIELDS = ["receivedOffice", "supplier", "receiptNo", "invoiceNo", "receivedDate"] as const;
const ITEM_STRING_FIELDS = ["orderNo", "cartonNo", "partNo", "dateCode", "weight", "office", "poNo", "remark"] as const;

function headerString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HTTPException(400, { message: `invalid_payload: ${field} must be a string` });
  return value;
}

/** Validate the verified upload payload; 400 invalid_payload on any deviation. */
export function validateCnPayload(raw: unknown): CnUploadPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HTTPException(400, { message: "invalid_payload" });
  }
  const body = raw as Record<string, unknown>;
  const payload: CnUploadPayload = { items: [] };
  for (const field of HEADER_STRING_FIELDS) {
    const v = headerString(body[field], field);
    if (v !== undefined) (payload as unknown as Record<string, unknown>)[field] = v;
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new HTTPException(400, { message: "invalid_payload: items must be a non-empty array" });
  }
  payload.items = body.items.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new HTTPException(400, { message: `invalid_payload: items[${i}] must be an object` });
    }
    const rawItem = entry as Record<string, unknown>;
    for (const field of ITEM_STRING_FIELDS) {
      const v = rawItem[field];
      if (v !== undefined && v !== null && typeof v !== "string" && typeof v !== "number") {
        throw new HTTPException(400, { message: `invalid_payload: items[${i}].${field} must be a string` });
      }
    }
    const partNo = typeof rawItem.partNo === "string" ? rawItem.partNo.trim() : "";
    const orderNo = typeof rawItem.orderNo === "string" ? rawItem.orderNo.trim() : "";
    // Wire contract (swapped vs the sheet/UI): `poNo` carries the sheet's
    // 訂單號 (always present) and `orderNo` the 发货項 value (may be blank).
    const poNo = typeof rawItem.poNo === "string" ? rawItem.poNo.trim() : "";
    if (!partNo || !poNo) {
      throw new HTTPException(400, { message: `invalid_payload: items[${i}] needs non-empty partNo and poNo` });
    }
    const qty = typeof rawItem.qty === "number" ? rawItem.qty : Number(rawItem.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new HTTPException(400, { message: `invalid_payload: items[${i}].qty must be a positive integer` });
    }
    const item: CnUploadItem = { orderNo, partNo, qty };
    for (const field of ITEM_STRING_FIELDS) {
      if (field === "partNo" || field === "orderNo") continue;
      const v = rawItem[field];
      if (v !== undefined && v !== null) item[field] = String(v);
    }
    return item;
  });
  return payload;
}

// --- upload ------------------------------------------------------------------

export interface CnUploadActor {
  /** users.id (transaction_logs.actor_id FK). */
  id: string;
  username: string;
  displayName: string;
}

export interface CreateCnUploadInput {
  /** "excel" today; "pdf" is phase 2. */
  phase: "excel" | "pdf";
  file: { filename: string; mime: string; bytes: Uint8Array };
  payload: CnUploadPayload;
  actor: CnUploadActor;
}

/** Correlation key for one CN upload: `CN-<YYYYMMDD>-<6 random uppercase
 *  alphanumerics>`. Travels inside the workflow payload; the upstream sync
 *  stamps it onto the CN order's batch_no so order ↔ workflow joins don't
 *  depend on the sheet's 編號 being unique. */
export function generateCnBatchNo(at: Date = new Date()): string {
  const ymd = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, "0"),
    String(at.getDate()).padStart(2, "0"),
  ].join("");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // unambiguous set
  const bytes = randomBytes(6);
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `CN-${ymd}-${code}`;
}

/**
 * Upload flow per spec: file → DocPal upload, kick the workflow definition
 * with the upload entry + verified payload (with the generated batchNo) +
 * real-user creator variables, then one tx inserting the tracking row (batch
 * no in its own column; the stored payload jsonb stays the verified data as
 * sent by the client) + audit log. A kick failure after a successful upload
 * deletes the orphaned attachment before the 502 escapes.
 */
export async function createCnUpload(db: AppDb, input: CreateCnUploadInput): Promise<{ id: string }> {
  const definitionId = input.phase === "excel" ? docpalCnExcelWorkflowId() : docpalCnPdfWorkflowId();
  if (!definitionId) {
    throw new HTTPException(500, { message: "docpal_workflow_definition_not_configured" });
  }
  const batchNo = generateCnBatchNo();
  const { filename, mime, bytes } = input.file;
  const data = await uploadWorkflowFile(filename, mime, bytes, filename);
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "";
  const uploadName = typeof data.name === "string" && data.name ? data.name : filename;
  const variables: Record<string, unknown> = {
    excelFiles: [
      {
        extension,
        file_name: filename,
        id: data.id,
        mime_type: mime,
        name: uploadName,
        response: {
          data: {
            fileContent: { mime_type: mime },
            fileContentExtension: extension,
            id: data.id,
            name: uploadName,
          },
        },
      },
    ],
    excel_result_data: [{ ...input.payload }],
    start_user_id: input.actor.username,
    batch_no:batchNo,
    __system__user_creator_id: input.actor.username,
    __system__user_creator_name: input.actor.displayName,
  };
  let process: { id: string; business_key?: string };
  try {
    process = await startProcess(definitionId, variables);
  } catch (e) {
    // The attachment is orphaned by the failed kick — best-effort cleanup.
    await deleteWorkflowAttachment(data.id).catch(() => undefined);
    throw e;
  }

  const id = newId();
  const at = now();
  await db.transaction(async (tx) => {
    await tx.insert(receivingCnWorkflows).values({
      id,
      phase: input.phase,
      invoiceNo: input.payload.invoiceNo ?? null,
      supplier: input.payload.supplier ?? null,
      filename,
      docpalDocumentId: data.id,
      docpalProcessId: process.id,
      docpalBusinessKey: process.business_key ?? null,
      batchNo,
      status: "workflow_running",
      payload: input.payload,
      createdBy: input.actor.username,
      createdDate: at,
      lastUpdateDate: at,
    });
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "receiving_cn_workflow",
      entityId: id,
      fromState: null,
      toState: "workflow_running",
      actorId: input.actor.id,
      metadata: { phase: input.phase, docpalProcessId: process.id, filename },
      createdDate: at,
    });
  });
  return { id };
}

// --- reads -------------------------------------------------------------------

export type CnWorkflowRow = typeof receivingCnWorkflows.$inferSelect;

export interface ListCnWorkflowsResult {
  rows: CnWorkflowRow[];
  total: number;
}

/** Tracking list, newest first; ?status filter (single or repeated). */
export async function listCnWorkflows(
  db: AppDb,
  { status, page = 1, pageSize = 20 }: { status?: string[]; page?: number; pageSize?: number }
): Promise<ListCnWorkflowsResult> {
  const statuses = status?.map((s) => s.trim()).filter(Boolean) ?? [];
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 200) : 20;
  const rows = await queryAll<CnWorkflowRow & { totalCount: number }>(
    db,
    sql`SELECT id, phase, invoice_no AS "invoiceNo", supplier, filename,
               docpal_document_id AS "docpalDocumentId", docpal_process_id AS "docpalProcessId",
               docpal_business_key AS "docpalBusinessKey", batch_no AS "batchNo", status, payload, error,
               created_by AS "createdBy", created_date AS "createdDate", last_update_date AS "lastUpdateDate",
               COUNT(*) OVER()::int AS "totalCount"
        FROM receiving_cn_workflows
        WHERE TRUE
        ${statuses.length ? sql`AND status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : sql``}
        ORDER BY created_date DESC, id
        LIMIT ${safePageSize} OFFSET ${(safePage - 1) * safePageSize}`
  );
  return {
    rows: rows.map(({ totalCount: _t, ...row }) => row),
    total: rows[0]?.totalCount ?? 0,
  };
}

/** One tracking row (detail incl. payload items); 404 receiving_cn_workflow_not_found. */
export async function getCnWorkflow(db: AppDb, id: string): Promise<CnWorkflowRow> {
  const row = await queryGet<CnWorkflowRow>(
    db,
    sql`SELECT id, phase, invoice_no AS "invoiceNo", supplier, filename,
               docpal_document_id AS "docpalDocumentId", docpal_process_id AS "docpalProcessId",
               docpal_business_key AS "docpalBusinessKey", batch_no AS "batchNo", status, payload, error,
               created_by AS "createdBy", created_date AS "createdDate", last_update_date AS "lastUpdateDate"
        FROM receiving_cn_workflows WHERE id = ${id}`
  );
  if (!row) throw new HTTPException(404, { message: "receiving_cn_workflow_not_found" });
  return row;
}

// --- order-centric reads (admin list) -----------------------------------------

export interface CnOrderListRow {
  kind: "order";
  batchNo: string;
  invoiceNo: string | null;
  supplier: string | null;
  status: string;
  deliveryDate: Date | null;
  arrivedAt: Date | null;
  arrivedBy: string | null;
  putAwayStatus: string | null;
  docpalBusinessKey: string | null;
  createdDate: Date;
}

export interface CnPendingOrderRow {
  kind: "pending";
  batchNo: string;
  invoiceNo: string | null;
  supplier: string | null;
  status: string;
  error: string | null;
  docpalBusinessKey: string | null;
  createdDate: Date;
}

export interface ListCnOrdersResult {
  rows: CnOrderListRow[];
  total: number;
  pending: CnPendingOrderRow[];
}

/**
 * The admin CN list, order-centric: `rows` pages receiving_orders_cn newest
 * first (matched workflow joined on the generated batch_no, legacy fallback
 * on invoice_no; put-away task status alongside). `pending` lists running
 * uploads whose order hasn't synced yet (any workflow status — DocPal
 * currently never reports terminal states), newest first, not paged.
 */
export async function listCnOrders(
  db: AppDb,
  { page = 1, pageSize = 20 }: { page?: number; pageSize?: number } = {}
): Promise<ListCnOrdersResult> {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 200) : 20;
  const rows = await queryAll<CnOrderListRow & { totalCount: number }>(
    db,
    sql`SELECT ro.batch_no AS "batchNo",
               wf.invoice_no AS "invoiceNo", wf.supplier, ro.status,
               ro.delivery_date AS "deliveryDate", ro.arrived_at AS "arrivedAt", ro.arrived_by AS "arrivedBy",
               t.status AS "putAwayStatus", wf.docpal_business_key AS "docpalBusinessKey",
               ro.created_date AS "createdDate",
               COUNT(*) OVER()::int AS "totalCount"
        FROM receiving_orders_cn ro
        LEFT JOIN put_away_tasks_cn t ON t.receiving_order_cn_id = ro.id
        LEFT JOIN LATERAL (
          SELECT invoice_no, supplier, docpal_business_key
          FROM receiving_cn_workflows
          WHERE batch_no = ro.batch_no
             OR (batch_no IS NULL AND invoice_no = ro.batch_no)
          ORDER BY created_date DESC LIMIT 1
        ) wf ON true
        ORDER BY ro.created_date DESC, ro.id
        LIMIT ${safePageSize} OFFSET ${(safePage - 1) * safePageSize}`
  );
  const pending = await queryAll<Omit<CnPendingOrderRow, "kind" | "status"> & { status: string }>(
    db,
    sql`SELECT COALESCE(batch_no, invoice_no) AS "batchNo",
               invoice_no AS "invoiceNo", supplier, status, error,
               docpal_business_key AS "docpalBusinessKey", created_date AS "createdDate"
        FROM receiving_cn_workflows wf
        WHERE COALESCE(batch_no, invoice_no) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM receiving_orders_cn ro
            WHERE ro.batch_no = COALESCE(wf.batch_no, wf.invoice_no)
          )
        ORDER BY created_date DESC, id`
  );
  return {
    rows: rows.map(({ totalCount: _t, ...row }) => ({ ...row, kind: "order" as const })),
    total: rows[0]?.totalCount ?? 0,
    // UI-facing status: uploads in flight show as "processing" (DocPal
    // currently never reports terminal states anyway); anything else passes
    // through verbatim.
    pending: pending.map((row) => ({
      ...row,
      kind: "pending" as const,
      status: row.status === "workflow_running" ? "processing" : row.status,
    })),
  };
}

export interface CnOrderDetail {
  order: {
    id: string;
    batchNo: string;
    status: string;
    deliveryDate: Date | null;
    arrivedAt: Date | null;
    arrivedBy: string | null;
    orgId: number;
    dateCode: string | null;
    createdDate: Date;
  };
  invoices: { id: string; invoiceNo: string; totalQty: number | null; totalCtn: number | null; deliveryDate: Date | null }[];
  items: {
    id: string;
    receivingInvoiceId: string;
    invoiceNo: string;
    partNo: string;
    wclItemNo: string | null;
    poNo: string | null;
    poLine: string | null;
    lineQty: number | null;
    receivedQty: number;
    putAwayQty: number;
    ctnNo: string | null;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    orgId: number;
    subInventoryCode: string | null;
  }[];
  putAway: { id: string; status: string } | null;
}

/** One CN order by batch_no with its invoices/items/put-away task; a
 *  pending-only workflow (no synced order) 404s — the UI shows the list chip. */
export async function getCnOrderDetail(db: AppDb, batchNo: string): Promise<CnOrderDetail> {
  const order = await queryGet<CnOrderDetail["order"]>(
    db,
    sql`SELECT id, batch_no AS "batchNo", status, delivery_date AS "deliveryDate",
               arrived_at AS "arrivedAt", arrived_by AS "arrivedBy",
               org_id AS "orgId", date_code AS "dateCode", created_date AS "createdDate"
        FROM receiving_orders_cn
        WHERE batch_no = ${batchNo}
        ORDER BY created_date DESC LIMIT 1`
  );
  if (!order) throw new HTTPException(404, { message: "receiving_cn_order_not_found" });
  const invoices = await queryAll<CnOrderDetail["invoices"][number]>(
    db,
    sql`SELECT id, invoice_no AS "invoiceNo", total_qty AS "totalQty", total_ctn AS "totalCtn",
               delivery_date AS "deliveryDate"
        FROM receiving_invoices_cn
        WHERE receiving_order_id = ${order.id}
        ORDER BY invoice_no, id`
  );
  const items = await queryAll<CnOrderDetail["items"][number]>(
    db,
    sql`SELECT rii.id, rii.receiving_invoice_id AS "receivingInvoiceId", ri.invoice_no AS "invoiceNo",
               rii.part_no AS "partNo", rii.wcl_item_no AS "wclItemNo", rii.po_no AS "poNo", rii.po_line AS "poLine",
               rii.line_qty AS "lineQty", rii.received_qty AS "receivedQty", rii.put_away_qty AS "putAwayQty",
               rii.ctn_no AS "ctnNo", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
               rii.coo, rii.cow, rii.org_id AS "orgId", rii.sub_inventory_code AS "subInventoryCode"
        FROM receiving_invoice_items_cn rii
        JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${order.id}
        ORDER BY ri.invoice_no, rii.po_no, rii.po_line, rii.id`
  );
  const putAway = await queryGet<{ id: string; status: string }>(
    db,
    sql`SELECT id, status FROM put_away_tasks_cn WHERE receiving_order_cn_id = ${order.id}`
  );
  return { order, invoices, items, putAway: putAway ?? null };
}

// --- finalize (cron) ----------------------------------------------------------

/** The CN order's item-derived uniform stock-location pair (orderPair mirror
 *  over the _cn tables): the single DISTINCT item pair, NULL when mixed. */
async function cnOrderPair(
  tx: DbOrTx,
  orderCnId: string
): Promise<{ orgId: number | null; subInventoryCode: string | null }> {
  const rows = await queryAll<{ orgId: number | null; subInventoryCode: string | null }>(
    tx,
    sql`SELECT DISTINCT rii.org_id AS "orgId", rii.sub_inventory_code AS "subInventoryCode"
        FROM receiving_invoice_items_cn rii
        JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderCnId}`
  );
  if (rows.length === 1) return rows[0];
  return { orgId: null, subInventoryCode: null };
}

/**
 * Workflow-terminal completion (spec): the upstream sync has written the CN
 * order stamped with the workflow's batch_no — if not there yet, return false
 * so the cron retries on the next poll. Workflows predating the batch_no
 * column (NULL) fall back to the legacy invoice_no match. One tx: order →
 * in_hand (+arrived stamp), idempotent put_away_tasks_cn insert, audit logs,
 * workflow → completed, SSE.
 */
export async function finalizeCnOrder(db: AppDb, workflowRow: CnWorkflowRow, actorId: string | null): Promise<boolean> {
  const matchKey = workflowRow.batchNo ?? workflowRow.invoiceNo;
  if (!matchKey) return false;
  const order = await queryGet<{ id: string; status: string }>(
    db,
    sql`SELECT id, status FROM receiving_orders_cn
        WHERE batch_no = ${matchKey}
        ORDER BY created_date DESC LIMIT 1`
  );
  if (!order) return false;

  await db.transaction(async (tx) => {
    const pair = await cnOrderPair(tx, order.id);
    const at = now();
    const changed = await queryGet<{ id: string }>(
      tx,
      sql`UPDATE receiving_orders_cn
          SET status = 'in_hand', arrived_at = ${at},
              arrived_by = COALESCE(${actorId}, arrived_by), last_update_date = ${at}
          WHERE id = ${order.id} AND status <> 'in_hand'
          RETURNING id`
    );
    if (changed) {
      await tx.insert(transactionLogs).values({
        id: newId(),
        entityType: "receiving_order_cn",
        entityId: order.id,
        fromState: order.status,
        toState: "in_hand",
        actorId,
        metadata: { workflowId: workflowRow.id },
        createdDate: at,
      });
    }
    const task = await queryAll<{ id: string }>(
      tx,
      sql`INSERT INTO put_away_tasks_cn (id, receiving_order_cn_id, org_id, sub_inventory_code, status, created_date)
          VALUES (${newId()}, ${order.id}, ${pair.orgId}, ${pair.subInventoryCode}, 'pending', ${at})
          ON CONFLICT (receiving_order_cn_id) DO NOTHING
          RETURNING id`
    );
    if (task.length > 0) {
      await tx.insert(transactionLogs).values({
        id: newId(),
        entityType: "put_away_task_cn",
        entityId: task[0].id,
        fromState: null,
        toState: "pending",
        actorId,
        metadata: { receivingOrderCnId: order.id },
        createdDate: at,
      });
    }
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "receiving_cn_workflow",
      entityId: workflowRow.id,
      fromState: workflowRow.status,
      toState: "completed",
      actorId,
      metadata: { receivingOrderCnId: order.id },
      createdDate: at,
    });
    await tx
      .update(receivingCnWorkflows)
      .set({ status: "completed", error: null, lastUpdateDate: at })
      .where(sql`id = ${workflowRow.id}`);
    await emitEvent(tx, {
      type: "receiving_cn.completed",
      topics: ["/admin/receiving-cn"],
      data: { workflowId: workflowRow.id, receivingOrderCnId: order.id, putAwayTaskCreated: task.length > 0 },
    });
  });
  return true;
}

/** Workflow-terminal failure/cancellation (cron): stamp status + error, audit
 *  log, SSE so the admin tracking list reloads. */
export async function markCnWorkflowTerminal(
  db: AppDb,
  input: { id: string; status: "failed" | "cancelled"; error: string | null; actorId: string | null }
): Promise<void> {
  const at = now();
  await db.transaction(async (tx) => {
    await tx
      .update(receivingCnWorkflows)
      .set({ status: input.status, error: input.error, lastUpdateDate: at })
      .where(sql`id = ${input.id}`);
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "receiving_cn_workflow",
      entityId: input.id,
      fromState: "workflow_running",
      toState: input.status,
      actorId: input.actorId,
      metadata: input.error ? { error: input.error } : {},
      createdDate: at,
    });
    await emitEvent(tx, {
      type: `receiving_cn.${input.status}`,
      topics: ["/admin/receiving-cn"],
      data: { workflowId: input.id, error: input.error },
    });
  });
}
