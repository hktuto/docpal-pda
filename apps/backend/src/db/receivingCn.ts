import { HTTPException } from "hono/http-exception";
import { sql, type SQL } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { AppDb } from "../db.js";
import { newId } from "./id.js";
import { now } from "./now.js";
import { queryAll, queryGet, queryRun, type DbOrTx } from "./query.js";
import {
  putAwayTasksCn,
  receivingCnWorkflows,
  receivingInvoiceItemsCn,
  receivingInvoicesCn,
  receivingOrdersCn,
  transactionLogs,
} from "./schema/index.js";
import { normalizePartNo } from "./scanParse.js";
import { emitEvent } from "./events.js";
import {
  deleteWorkflowAttachment,
  startProcess,
  uploadWorkflowFile,
} from "../docpalWorkflow.js";
import { docpalCnExcelWorkflowId, docpalCnPdfWorkflowId, putAwayConfig } from "../config.js";
import { computeItemShelfSuggestions } from "./putaway.js";

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
  /** 1-based position of the row in the sheet's item table (passes through to
   *  the workflow's excel_result_data so downstream steps can restore the
   *  original row order); defaulted to the array position when absent. */
  index?: number;
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
    let index: number | undefined;
    if (rawItem.index !== undefined && rawItem.index !== null) {
      index = typeof rawItem.index === "number" ? rawItem.index : Number(rawItem.index);
      if (!Number.isInteger(index) || index <= 0) {
        throw new HTTPException(400, { message: `invalid_payload: items[${i}].index must be a positive integer` });
      }
    }
    const item: CnUploadItem = { orderNo, partNo, qty };
    if (index !== undefined) item.index = index;
    else item.index = i + 1;
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
  /** "excel" = phase 1 (verified rows sent along); "pdf" = phase 2 (DocPal
   *  OCR extracts the data inside the workflow — no payload). */
  phase: "excel" | "pdf";
  file: { filename: string; mime: string; bytes: Uint8Array };
  /** Verified excel rows — required for phase "excel", omitted for "pdf". */
  payload?: CnUploadPayload;
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

/** Next `[brand]-yyyymmdd-[seq]` number in the shared CN numbering namespace.
 *  Counts the max numeric suffix across every table the namespace spans —
 *  `receiving_invoices_cn.invoice_no` (manual receipts), `receiving_orders_cn.batch_no`
 *  (synced orders) and `receiving_cn_workflows.batch_no` (pdf uploads) — so a
 *  manual TE receipt and a TE pdf upload never collide on the same day. */
export async function nextCnBrandedNo(db: AppDb, brand: string, at: Date = new Date()): Promise<string> {
  const ymd = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, "0"),
    String(at.getDate()).padStart(2, "0"),
  ].join("");
  const prefix = `${brand}-${ymd}-`;
  const row = await queryGet<{ max: number | null }>(
    db,
    sql`SELECT MAX(CAST(split_part(no, '-', 3) AS integer)) AS max FROM (
          SELECT invoice_no AS no FROM receiving_invoices_cn WHERE invoice_no LIKE ${`${prefix}%`}
          UNION ALL SELECT batch_no FROM receiving_orders_cn WHERE batch_no LIKE ${`${prefix}%`}
          UNION ALL SELECT batch_no FROM receiving_cn_workflows WHERE batch_no LIKE ${`${prefix}%`}
        ) s
        WHERE no ~ ${`^${brand}-[0-9]{8}-[0-9]+$`}`
  );
  return `${prefix}${String((row?.max ?? 0) + 1).padStart(2, "0")}`;
}

/**
 * Upload flow per spec: file → DocPal upload, kick the workflow definition
 * with the upload entry + the real-user creator variables, then one tx
 * inserting the tracking row (batch no in its own column; the stored payload
 * jsonb stays the verified data as sent by the client — `{}` for pdf) + audit
 * log. Phase shapes: "excel" adds `excelFiles` + `excel_result_data` (with the
 * generated batchNo); "pdf" adds `pdfFiles` only (DocPal OCR extracts the data
 * inside the workflow; the verify step is a later phase). A kick failure after
 * a successful upload deletes the orphaned attachment before the 502 escapes.
 */
export async function createCnUpload(db: AppDb, input: CreateCnUploadInput): Promise<{ id: string }> {
  const definitionId = input.phase === "excel" ? docpalCnExcelWorkflowId() : docpalCnPdfWorkflowId();
  if (!definitionId) {
    throw new HTTPException(500, { message: "docpal_workflow_definition_not_configured" });
  }
  if (input.phase === "excel" && !input.payload) {
    throw new HTTPException(400, { message: "invalid_payload" });
  }
  // pdf uploads are always TE and number like manual receipts
  // (`TE-yyyymmdd-seq`); the retired excel phase keeps the random CN- key.
  const batchNo = input.phase === "pdf" ? await nextCnBrandedNo(db, "TE") : generateCnBatchNo();
  const { filename, mime, bytes } = input.file;
  const data = await uploadWorkflowFile(filename, mime, bytes, filename);
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase() : "";
  const uploadName = typeof data.name === "string" && data.name ? data.name : filename;
  const fileEntry = {
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
  };
  const variables: Record<string, unknown> = {
    start_user_id: input.actor.username,
    batch_no: batchNo,
    __system__user_creator_id: input.actor.username,
    __system__user_creator_name: input.actor.displayName,
  };
  if (input.phase === "excel") {
    variables.excelFiles = [fileEntry];
    variables.excel_result_data = [{ ...input.payload!, batchNo }];
  } else {
    variables.pdfFiles = [fileEntry];
  }
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
      invoiceNo: input.payload?.invoiceNo ?? null,
      supplier: input.payload?.supplier ?? null,
      filename,
      docpalDocumentId: data.id,
      docpalProcessId: process.id,
      docpalBusinessKey: process.business_key ?? null,
      batchNo,
      status: "workflow_running",
      payload: input.payload ?? {},
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

// --- manual receipt (PDA 手動收貨) ---------------------------------------------
// Spec docs/superpowers/specs/2026-10-27-manual-receiving-pda-design.md: the
// PDA stages the task locally (order numbers + scanned label items) and commits
// it in one call — no DocPal workflow, no upstream sync. The tx writes the same
// _cn world finalizeCnOrder finalizes: order in_hand + arrived stamp, one
// invoice per order number, items at line_qty = received_qty = scanned qty,
// plus the dedicated CN put-away task.

export interface CnManualReceiptItemInput {
  partNo: string;
  qty: number;
  /** Client-resolved parts key (from the label parse); the backend falls
   *  back to its own parts lookup when absent. */
  wclItemNo?: string;
  dateCode?: string;
  lotCode?: string;
  coo?: string;
  cow?: string;
  ctnNo?: string;
  supplierCode?: string;
  /** The task brand (one per task, from the first label's matched template) —
   *  drives the invoice_no/batch_no `[brand]-yyyymmdd-[seq]`; required on at
   *  least one item. */
  brand?: string;
  /** The scanned label text — traceability only (stored in additional_data). */
  raw?: string;
}

export interface CnManualReceiptOrderInput {
  /** The 訂單號 the operator typed — stored as po_no on its items and used to
   *  derive each item's org/sub-inventory. */
  orderNo: string;
  items: CnManualReceiptItemInput[];
}

const MANUAL_ITEM_STRING_FIELDS = [
  "wclItemNo",
  "dateCode",
  "lotCode",
  "coo",
  "cow",
  "ctnNo",
  "supplierCode",
  "brand",
  "raw",
] as const;

/** Validate the manual-receipt commit body; 400 invalid_payload on any deviation. */
export function validateCnManualReceipt(raw: unknown): CnManualReceiptOrderInput[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HTTPException(400, { message: "invalid_payload" });
  }
  const body = (raw as Record<string, unknown>).orders;
  if (!Array.isArray(body) || body.length === 0) {
    throw new HTTPException(400, { message: "invalid_payload: orders must be a non-empty array" });
  }
  const seenOrderNos = new Set<string>();
  return body.map((rawOrder, i) => {
    if (typeof rawOrder !== "object" || rawOrder === null || Array.isArray(rawOrder)) {
      throw new HTTPException(400, { message: `invalid_payload: orders[${i}] must be an object` });
    }
    const o = rawOrder as Record<string, unknown>;
    const orderNo = typeof o.orderNo === "string" ? o.orderNo.trim() : "";
    if (!orderNo) throw new HTTPException(400, { message: `invalid_payload: orders[${i}].orderNo must be non-empty` });
    const orderKey = orderNo.toUpperCase().replace(/\s+/g, "");
    if (seenOrderNos.has(orderKey)) {
      throw new HTTPException(400, { message: `invalid_payload: duplicate orderNo ${orderNo}` });
    }
    seenOrderNos.add(orderKey);
    if (!Array.isArray(o.items) || o.items.length === 0) {
      throw new HTTPException(400, { message: `invalid_payload: orders[${i}].items must be a non-empty array` });
    }
    const items = o.items.map((rawItem, j) => {
      if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) {
        throw new HTTPException(400, { message: `invalid_payload: orders[${i}].items[${j}] must be an object` });
      }
      const r = rawItem as Record<string, unknown>;
      const partNo = typeof r.partNo === "string" ? r.partNo.trim() : "";
      if (!partNo) {
        throw new HTTPException(400, { message: `invalid_payload: orders[${i}].items[${j}].partNo must be non-empty` });
      }
      const qty = typeof r.qty === "number" ? r.qty : Number(r.qty);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new HTTPException(400, { message: `invalid_payload: orders[${i}].items[${j}].qty must be a positive integer` });
      }
      const item: CnManualReceiptItemInput = { partNo, qty };
      for (const field of MANUAL_ITEM_STRING_FIELDS) {
        const v = r[field];
        if (v === undefined || v === null) continue;
        if (typeof v !== "string") {
          throw new HTTPException(400, { message: `invalid_payload: orders[${i}].items[${j}].${field} must be a string` });
        }
        const trimmed = v.trim();
        if (trimmed !== "") item[field] = trimmed;
      }
      return item;
    });
    return { orderNo, items };
  });
}

/** SQL mirror of normalizePartNo (picking.ts): whitespace collapsed out,
 *  uppercase, TE "AMP(...)"/"TE-AMP(...)" wrapper unwrapped. */
const unwrappedPartCol = (col: SQL) =>
  sql`regexp_replace(upper(regexp_replace(${col}, '\\s', '', 'g')), '^(TE-)?AMP\\((.+)\\)$', '\\2')`;

/** parts.wcl_item_no for a scanned part no — only on a unique space/case-
 *  insensitive match (either parts column), else NULL (parts.part_no is not
 *  unique; a bare unknown part stays text-only). */
async function resolveWclItemNo(tx: DbOrTx, partNo: string): Promise<string | null> {
  const key = normalizePartNo(partNo);
  const rows = await queryAll<{ wclItemNo: string }>(
    tx,
    sql`SELECT wcl_item_no AS "wclItemNo" FROM parts
        WHERE ${unwrappedPartCol(sql`part_no`)} = ${key} OR ${unwrappedPartCol(sql`wcl_item_no`)} = ${key}
        GROUP BY wcl_item_no`
  );
  return rows.length === 1 ? rows[0].wclItemNo : null;
}

/** The parts-master row for a wcl_item_no — only on a unique space/case-
 *  insensitive match, else NULL. A wcl_item_no edit applies the matched
 *  part_no alongside (the admin combobox picks wcl_item_no values). */
async function resolvePartByWclItemNo(tx: DbOrTx, wclItemNo: string): Promise<{ partNo: string; wclItemNo: string } | null> {
  const key = normalizePartNo(wclItemNo);
  const rows = await queryAll<{ partNo: string; wclItemNo: string }>(
    tx,
    sql`SELECT part_no AS "partNo", wcl_item_no AS "wclItemNo" FROM parts
        WHERE ${unwrappedPartCol(sql`wcl_item_no`)} = ${key}
        GROUP BY part_no, wcl_item_no`
  );
  return rows.length === 1 ? rows[0] : null;
}

export interface CreateCnManualReceiptResult {
  id: string;
  batchNo: string;
  putAwayTaskId: string;
}

/** po_no prefix → the item's stock location (spec: 319/317 → 7/SZSZ1,
 *  329/327 → 14/GZSZ, 339/337 → 5/SHSZ, 349/347 → 12/BJSZ, else 7/STORE1). */
const MANUAL_ORG_SUB_RULES: { prefixes: string[]; orgId: number; subInventoryCode: string }[] = [
  { prefixes: ["319", "317"], orgId: 7, subInventoryCode: "SZSZ1" },
  { prefixes: ["329", "327"], orgId: 14, subInventoryCode: "GZSZ" },
  { prefixes: ["339", "337"], orgId: 5, subInventoryCode: "SHSZ" },
  { prefixes: ["349", "347"], orgId: 12, subInventoryCode: "BJSZ" },
];

export function deriveCnManualOrgSub(poNo: string): { orgId: number; subInventoryCode: string } {
  for (const rule of MANUAL_ORG_SUB_RULES) {
    if (rule.prefixes.some((p) => poNo.startsWith(p))) {
      return { orgId: rule.orgId, subInventoryCode: rule.subInventoryCode };
    }
  }
  return { orgId: 7, subInventoryCode: "STORE1" };
}

/** Commit one PDA manual-receiving task: one order + ONE invoice + items +
 *  the CN put-away task + audit + SSE, one tx. The task's single brand (first
 *  scanned item's) drives the invoice number `[brand]-yyyymmdd-[seq]` (seq =
 *  that brand's invoice count for the day + 1); batch_no = invoice_no;
 *  delivery_date = the creation date; each order number lands on its items as
 *  po_no and derives their org/sub-inventory. */
export async function createCnManualReceipt(
  db: AppDb,
  input: { orders: CnManualReceiptOrderInput[]; actor: { id: string; username: string } }
): Promise<CreateCnManualReceiptResult> {
  const { orders, actor } = input;
  const brand = orders.flatMap((o) => o.items).find((item) => item.brand)?.brand;
  if (!brand) throw new HTTPException(400, { message: "invalid_payload: an item brand is required" });
  const orderId = newId();
  const invoiceId = newId();
  const taskId = newId();
  const at = now();
  const orderOrgId = deriveCnManualOrgSub(orders[0].orderNo).orgId;
  let invoiceNo = "";

  await db.transaction(async (tx) => {
    invoiceNo = await nextCnBrandedNo(tx, brand, at);

    await tx.insert(receivingOrdersCn).values({
      id: orderId,
      batchNo: invoiceNo,
      deliveryDate: at,
      status: "in_hand",
      arrivedAt: at,
      arrivedBy: actor.id,
      orgId: orderOrgId,
      createdDate: at,
      lastUpdateDate: at,
    });
    await tx.insert(receivingInvoicesCn).values({
      id: invoiceId,
      receivingOrderId: orderId,
      invoiceNo,
      totalQty: orders.reduce((s, o) => s + o.items.reduce((si, it) => si + it.qty, 0), 0),
      orgId: orderOrgId,
      createdDate: at,
      lastUpdateDate: at,
    });
    for (const order of orders) {
      const pair = deriveCnManualOrgSub(order.orderNo);
      for (const item of order.items) {
        await tx.insert(receivingInvoiceItemsCn).values({
          id: newId(),
          receivingInvoiceId: invoiceId,
          partNo: item.partNo,
          wclItemNo: item.wclItemNo ?? (await resolveWclItemNo(tx, item.partNo)),
          poNo: order.orderNo,
          lineQty: item.qty,
          receivedQty: item.qty,
          ctnNo: item.ctnNo ?? null,
          dateCode: item.dateCode ?? null,
          lotCode: item.lotCode ?? null,
          coo: item.coo ?? null,
          cow: item.cow ?? null,
          orgId: pair.orgId,
          subInventoryCode: pair.subInventoryCode,
          additionalData: {
            source: "manual",
            ...(item.raw ? { raw: item.raw } : {}),
            ...(item.supplierCode ? { supplierCode: item.supplierCode } : {}),
            scannedBy: actor.username,
          },
          createdDate: at,
          lastUpdateDate: at,
        });
      }
    }
    const derived = await cnOrderPair(tx, orderId);
    // Same pair rule as finalizeCnOrder: uniform item pair wins, else the
    // order's org with a NULL sub-inventory.
    await tx.insert(putAwayTasksCn).values({
      id: taskId,
      receivingOrderCnId: orderId,
      orgId: derived.orgId ?? orderOrgId,
      subInventoryCode: derived.subInventoryCode,
      status: "pending",
      createdDate: at,
      lastUpdateDate: at,
    });
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "receiving_order_cn",
      entityId: orderId,
      fromState: null,
      toState: "in_hand",
      actorId: actor.id,
      metadata: { source: "manual", orderNos: orders.map((o) => o.orderNo) },
      createdDate: at,
    });
    await tx.insert(transactionLogs).values({
      id: newId(),
      entityType: "put_away_task_cn",
      entityId: taskId,
      fromState: null,
      toState: "pending",
      actorId: actor.id,
      metadata: { receivingOrderCnId: orderId },
      createdDate: at,
    });
    await emitEvent(tx, {
      type: "receiving_cn.completed",
      topics: ["/admin/receiving-cn", "/put-away-tasks"],
      data: { receivingOrderCnId: orderId, batchNo: invoiceNo, source: "manual" },
    });
  });
  return { id: orderId, batchNo: invoiceNo, putAwayTaskId: taskId };
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
  /** users.display_name of arrivedBy (NULL when unset/unknown). */
  arrivedByName: string | null;
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
 * `search` (trimmed) ILIKE-filters BOTH sections across batch_no / the
 * matched workflow's invoice_no / supplier; `total` reflects the filter.
 */
export async function listCnOrders(
  db: AppDb,
  { page = 1, pageSize = 20, search }: { page?: number; pageSize?: number; search?: string } = {}
): Promise<ListCnOrdersResult> {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 200) : 20;
  const term = search?.trim();
  const like = term ? `%${term}%` : null;
  const rows = await queryAll<CnOrderListRow & { totalCount: number }>(
    db,
    sql`SELECT ro.batch_no AS "batchNo",
               wf.invoice_no AS "invoiceNo", wf.supplier, ro.status,
               ro.delivery_date AS "deliveryDate", ro.arrived_at AS "arrivedAt", ro.arrived_by AS "arrivedBy",
               ua.display_name AS "arrivedByName",
               t.status AS "putAwayStatus", wf.docpal_business_key AS "docpalBusinessKey",
               ro.created_date AS "createdDate",
               COUNT(*) OVER()::int AS "totalCount"
        FROM receiving_orders_cn ro
        LEFT JOIN put_away_tasks_cn t ON t.receiving_order_cn_id = ro.id
        LEFT JOIN users ua ON ua.id = ro.arrived_by
        LEFT JOIN LATERAL (
          SELECT invoice_no, supplier, docpal_business_key
          FROM receiving_cn_workflows
          WHERE batch_no = ro.batch_no
             OR (batch_no IS NULL AND invoice_no = ro.batch_no)
          ORDER BY created_date DESC LIMIT 1
        ) wf ON true
        WHERE TRUE
        ${like ? sql`AND (ro.batch_no ILIKE ${like}
                    OR wf.invoice_no ILIKE ${like}
                    OR wf.supplier ILIKE ${like})` : sql``}
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
          ${like ? sql`AND (wf.batch_no ILIKE ${like}
                      OR wf.invoice_no ILIKE ${like}
                      OR wf.supplier ILIKE ${like})` : sql``}
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

export interface CnOrderDetailItem {
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
  /** On-hand stock this order's CN put-away created for the item, summed per
   *  shelf/box (from the PUT_AWAY ledger rows carrying the CN item id in
   *  metadata). Empty until put-away completes. */
  putAwayLocations: { shelfCode: string | null; boxId: string | null; qty: number }[];
  /** Advisory shelf: the admin override (additional_data.suggestedShelf) when
   *  set, else the computed suggestion (same helper as the CN task detail). */
  suggestedShelf: string | null;
  additionalData: Record<string, unknown> | null;
  orderData: Record<string, unknown> | null;
}

export interface CnOrderDetail {
  order: {
    id: string;
    batchNo: string;
    status: string;
    deliveryDate: Date | null;
    arrivedAt: Date | null;
    arrivedBy: string | null;
    /** users.display_name of arrivedBy (NULL when unset/unknown). */
    arrivedByName: string | null;
    orgId: number;
    dateCode: string | null;
    createdDate: Date;
  };
  invoices: { id: string; invoiceNo: string; totalQty: number | null; totalCtn: number | null; deliveryDate: Date | null }[];
  items: CnOrderDetailItem[];
  putAway: { id: string; status: string } | null;
  /** The matched upload workflow (newest batch_no match, legacy invoice_no
   *  fallback). The _cn tables don't carry the sheet's header fields — the
   *  Excel export falls back to these. */
  workflow: {
    supplier: string | null;
    receivedOffice: string | null;
    receiptNo: string | null;
    invoiceNo: string | null;
    receivedDate: string | null;
  } | null;
}

/** One CN order by batch_no with its invoices/items/put-away task; a
 *  pending-only workflow (no synced order) 404s — the UI shows the list chip. */
export async function getCnOrderDetail(db: AppDb, batchNo: string): Promise<CnOrderDetail> {
  const order = await queryGet<CnOrderDetail["order"]>(
    db,
    sql`SELECT ro.id, ro.batch_no AS "batchNo", ro.status, ro.delivery_date AS "deliveryDate",
               ro.arrived_at AS "arrivedAt", ro.arrived_by AS "arrivedBy",
               ua.display_name AS "arrivedByName",
               ro.org_id AS "orgId", ro.date_code AS "dateCode", ro.created_date AS "createdDate"
        FROM receiving_orders_cn ro
        LEFT JOIN users ua ON ua.id = ro.arrived_by
        WHERE ro.batch_no = ${batchNo}
        ORDER BY ro.created_date DESC LIMIT 1`
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
  const rawItems = await queryAll<Omit<CnOrderDetailItem, "putAwayLocations" | "suggestedShelf"> & { itemOrgId: number | null; itemSubInventoryCode: string | null }>(
    db,
    sql`SELECT rii.id, rii.receiving_invoice_id AS "receivingInvoiceId", ri.invoice_no AS "invoiceNo",
               rii.part_no AS "partNo", rii.wcl_item_no AS "wclItemNo", rii.po_no AS "poNo", rii.po_line AS "poLine",
               rii.line_qty AS "lineQty", rii.received_qty AS "receivedQty", rii.put_away_qty AS "putAwayQty",
               rii.ctn_no AS "ctnNo", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
               rii.coo, rii.cow, rii.org_id AS "orgId", rii.sub_inventory_code AS "subInventoryCode",
               rii.additional_data AS "additionalData", rii.order_data AS "orderData",
               rii.org_id AS "itemOrgId", rii.sub_inventory_code AS "itemSubInventoryCode"
        FROM receiving_invoice_items_cn rii
        JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${order.id}
        ORDER BY ri.invoice_no, rii.po_no, rii.po_line, rii.id`
  );
  const suggestions =
    putAwayConfig().suggestShelf !== "off"
      ? await computeItemShelfSuggestions(db, rawItems)
      : new Map<string, { shelfCode: string | null }>();
  const items: CnOrderDetailItem[] = rawItems.map((it) => {
    const override = it.additionalData?.suggestedShelf;
    const { itemOrgId: _o, itemSubInventoryCode: _si, ...row } = it;
    return {
      ...row,
      putAwayLocations: [],
      suggestedShelf:
        typeof override === "string" && override.trim() !== "" ? override : (suggestions.get(it.partNo)?.shelfCode ?? null),
    };
  });
  // Per-item put-away locations from this order's CN ledger rows (the CN item
  // id rides in metadata.receivingInvoiceItemCnId — see completeCnPutAwayTx).
  const locations = await queryAll<{ itemId: string; shelfCode: string | null; boxId: string | null; qty: number }>(
    db,
    sql`SELECT it.metadata->>'receivingInvoiceItemCnId' AS "itemId",
               it.shelf_code AS "shelfCode", it.box_id AS "boxId", SUM(it.qty_delta)::int AS qty
        FROM inventory_transactions it
        WHERE it.reference_type = 'receiving_order_cn' AND it.reference_id = ${order.id}
          AND it.qty_type = 'on_hand' AND it.qty_delta > 0
          AND it.metadata->>'receivingInvoiceItemCnId' IS NOT NULL
        GROUP BY 1, 2, 3`
  );
  const byItem = new Map<string, { shelfCode: string | null; boxId: string | null; qty: number }[]>();
  for (const loc of locations) {
    const list = byItem.get(loc.itemId) ?? [];
    list.push({ shelfCode: loc.shelfCode, boxId: loc.boxId, qty: loc.qty });
    byItem.set(loc.itemId, list);
  }
  for (const it of items) it.putAwayLocations = byItem.get(it.id) ?? [];
  const putAway = await queryGet<{ id: string; status: string }>(
    db,
    sql`SELECT id, status FROM put_away_tasks_cn WHERE receiving_order_cn_id = ${order.id}`
  );
  // Header-field fallback source: the matched upload workflow's payload
  // carries the verified 收貨辦事處/供應商/發票號碼/收貨日期 the _cn tables lack.
  const wf = await queryGet<{ supplier: string | null; payload: Record<string, unknown> | null }>(
    db,
    sql`SELECT supplier, payload FROM receiving_cn_workflows
        WHERE batch_no = ${order.batchNo} OR (batch_no IS NULL AND invoice_no = ${order.batchNo})
        ORDER BY created_date DESC LIMIT 1`
  );
  const payloadStr = (key: string): string | null => {
    const v = wf?.payload?.[key];
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  return {
    order,
    invoices,
    items,
    putAway: putAway ?? null,
    workflow: wf
      ? {
          supplier: wf.supplier,
          receivedOffice: payloadStr("receivedOffice"),
          receiptNo: payloadStr("receiptNo"),
          invoiceNo: payloadStr("invoiceNo"),
          receivedDate: payloadStr("receivedDate"),
        }
      : null,
  };
}

/** Re-derive every item's org/sub-inventory from its po_no prefix rules
 *  (deriveCnManualOrgSub). Items whose derived pair is missing from org_info
 *  are skipped (kept on the upstream pair) so a master-data gap never breaks
 *  the detail page. */
async function rederiveCnItemOrgSubTx(tx: AppDb, orderId: string, at: Date): Promise<void> {
  const items = await queryAll<{ id: string; poNo: string | null }>(
    tx,
    sql`SELECT rii.id, rii.po_no AS "poNo"
        FROM receiving_invoice_items_cn rii
        JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId} AND rii.po_no IS NOT NULL AND rii.po_no <> ''`
  );
  for (const item of items) {
    const pair = deriveCnManualOrgSub(item.poNo!);
    const known = await queryGet<{ n: number }>(
      tx,
      sql`SELECT COUNT(*)::int AS n FROM org_info
          WHERE org_id = ${pair.orgId} AND secondary_inventory_name = ${pair.subInventoryCode}`
    );
    if (!known?.n) continue;
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items_cn
          SET org_id = ${pair.orgId}, sub_inventory_code = ${pair.subInventoryCode}, last_update_date = ${at}
          WHERE id = ${item.id}
            AND (org_id IS DISTINCT FROM ${pair.orgId} OR sub_inventory_code IS DISTINCT FROM ${pair.subInventoryCode})`
    );
  }
}

/**
 * Pending-order cleanup, run when the admin opens the order detail: the pdf
 * workflow never finalizes, so the synced order sits at `pending` until the
 * admin confirms it. Opening the detail normalizes the record — item
 * org/sub-inventory from the po_no prefix rules, and the arrival stamp
 * (arrived_at / arrived_by, filled only when NULL). No-op for non-pending
 * orders. Never throws on unknown batch_no.
 */
export async function prepareCnOrderDetail(db: AppDb, batchNo: string, actorId: string | null): Promise<void> {
  const order = await queryGet<{ id: string; status: string }>(
    db,
    sql`SELECT id, status FROM receiving_orders_cn WHERE batch_no = ${batchNo} ORDER BY created_date DESC LIMIT 1`
  );
  if (!order || order.status !== "pending") return;
  const at = now();
  await db.transaction(async (tx) => {
    await rederiveCnItemOrgSubTx(tx, order.id, at);
    await queryRun(
      tx,
      sql`UPDATE receiving_orders_cn
          SET arrived_at = COALESCE(arrived_at, ${at}),
              arrived_by = COALESCE(arrived_by, ${actorId}),
              last_update_date = ${at}
          WHERE id = ${order.id}`
    );
  });
}

/**
 * Admin confirm of a pending CN order (spec phase 2): the receipt moment for
 * the pdf path — re-runs the po_no cleanup, fills received_qty from line_qty,
 * stamps the order in_hand + arrived, creates the CN put-away task, audit rows
 * + receiving_cn.completed SSE. 404 receiving_cn_order_not_found; 409
 * order_not_pending unless the order is pending.
 */
export async function confirmCnOrder(
  db: AppDb,
  batchNo: string,
  actor: { id: string; username: string }
): Promise<{ id: string; batchNo: string; putAwayTaskId: string | null }> {
  const order = await queryGet<{ id: string; status: string; orgId: number; dateCode: string | null }>(
    db,
    sql`SELECT id, status, org_id AS "orgId", date_code AS "dateCode" FROM receiving_orders_cn
        WHERE batch_no = ${batchNo} ORDER BY created_date DESC LIMIT 1`
  );
  if (!order) throw new HTTPException(404, { message: "receiving_cn_order_not_found" });
  if (order.status !== "pending") throw new HTTPException(409, { message: "order_not_pending" });
  let taskId: string | null = null;
  await db.transaction(async (tx) => {
    const at = now();
    await rederiveCnItemOrgSubTx(tx, order.id, at);
    const result = await receiveCnOrderTx(tx, order, actor.id, at, { source: "admin_confirm" });
    taskId = result.taskId;
    await emitEvent(tx, {
      type: "receiving_cn.completed",
      topics: ["/admin/receiving-cn", "/put-away-tasks"],
      data: { receivingOrderCnId: order.id, batchNo, source: "admin_confirm", putAwayTaskCreated: taskId !== null },
    });
  });
  return { id: order.id, batchNo, putAwayTaskId: taskId };
}

// --- order audit logs -----------------------------------------------------------------

/** Reuse the standard log row/params/page shapes (src/db/receiving.ts). */
import type { TransactionLogRow, OrderLogsParams, OrderLogsPage } from "./receiving.js";

const CN_LOG_SORTS: Record<string, SQL> = {
  createdDate: sql`tl.created_date`,
  actorName: sql`u.display_name`,
  toState: sql`tl.to_state`,
};

/** CN mirror of receiving.ts's logsQueryParts: `scope` scopes to one order,
 *  `q` adds the ILIKE predicate, sort whitelist createdDate/actorName/toState. */
function cnLogsQueryParts(params: OrderLogsParams | undefined, scope: SQL) {
  const q = params?.q?.trim();
  const like = `%${(q ?? "").replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const where = q
    ? sql`(${scope}) AND (u.display_name ILIKE ${like} OR tl.from_state ILIKE ${like} OR tl.to_state ILIKE ${like} OR tl.entity_type ILIKE ${like} OR tl.metadata::text ILIKE ${like})`
    : scope;
  const col = CN_LOG_SORTS[params?.sort ?? ""] ?? CN_LOG_SORTS.createdDate;
  const dir = params?.dir === "asc" ? sql`ASC` : sql`DESC`;
  return { where, orderBy: sql`ORDER BY ${col} ${dir} NULLS LAST, tl.id ${dir}` };
}

/**
 * Audit trail for one CN receiving order, mirroring listReceivingOrderLogs:
 * order-level rows (receiving_order_cn), the order's invoice-item rows
 * (receiving_invoice_item_cn — item edits etc., carrying the item's part no
 * as `partNo`), and the order-referencing task/workflow rows (finalize writes
 * put_away_task_cn + receiving_cn_workflow rows with the order id in their
 * metadata). Newest first by default; with `params.page` set returns
 * `{rows, total}`, otherwise the full array. 404 when the order is absent.
 */
export async function listCnOrderLogs(
  db: AppDb,
  batchNo: string,
  params?: OrderLogsParams
): Promise<TransactionLogRow[] | OrderLogsPage> {
  const order = await queryGet<{ id: string }>(
    db,
    sql`SELECT id FROM receiving_orders_cn WHERE batch_no = ${batchNo} ORDER BY created_date DESC LIMIT 1`
  );
  if (!order) throw new HTTPException(404, { message: "receiving_cn_order_not_found" });
  const { where, orderBy } = cnLogsQueryParts(
    params,
    sql`(tl.entity_type = 'receiving_order_cn' AND tl.entity_id = ${order.id})
        OR (tl.entity_type = 'receiving_invoice_item_cn' AND tl.entity_id IN (
              SELECT rii.id FROM receiving_invoice_items_cn rii
              JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
              WHERE ri.receiving_order_id = ${order.id}))
        OR (tl.entity_type = 'put_away_task_cn' AND tl.metadata->>'receivingOrderCnId' = ${order.id})
        OR (tl.entity_type = 'receiving_cn_workflow' AND tl.metadata->>'receivingOrderCnId' = ${order.id})`
  );
  const from = sql`FROM transaction_logs tl
        LEFT JOIN users u ON u.id = tl.actor_id
        LEFT JOIN receiving_invoice_items_cn rii
          ON tl.entity_type = 'receiving_invoice_item_cn' AND rii.id = tl.entity_id
        WHERE ${where}`;
  const select = sql`SELECT tl.id, tl.entity_type AS "entityType", tl.entity_id AS "entityId",
               tl.from_state AS "fromState", tl.to_state AS "toState",
               tl.actor_id AS "actorId", u.display_name AS "actorName",
               rii.part_no AS "partNo",
               tl.metadata, tl.created_date AS "createdDate"`;
  if (params?.page !== undefined) {
    const page = Math.max(1, params.page);
    const pageSize = Math.min(200, Math.max(1, params.pageSize ?? 50));
    const [rows, count] = await Promise.all([
      queryAll<TransactionLogRow & { partNo: string | null }>(
        db,
        sql`${select} ${from} ${orderBy} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
      ),
      queryGet<{ total: number }>(db, sql`SELECT COUNT(*)::int AS total ${from}`),
    ]);
    return { rows, total: count?.total ?? 0 };
  }
  return queryAll<TransactionLogRow & { partNo: string | null }>(db, sql`${select} ${from} ${orderBy}`);
}

// --- admin item edit ----------------------------------------------------------------

/** Editable fields on a CN receiving invoice item (camelCase → column) —
 *  mirrors the standard flow's RECEIVING_ITEM_FIELDS
 *  (src/db/adminedits.ts). */
const CN_ITEM_FIELDS = {
  partNo: "part_no",
  wclItemNo: "wcl_item_no",
  poNo: "po_no",
  dateCode: "date_code",
  lotCode: "lot_code",
  coo: "coo",
  cow: "cow",
  ctnNo: "ctn_no",
} as const;

export type CnItemField = keyof typeof CN_ITEM_FIELDS;

export interface CnItemRow {
  id: string;
  receivingInvoiceId: string;
  invoiceNo: string | null;
  partNo: string;
  wclItemNo: string | null;
  poNo: string | null;
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
}

const CN_ITEM_SELECT = sql`SELECT rii.id, rii.receiving_invoice_id AS "receivingInvoiceId", ri.invoice_no AS "invoiceNo",
               rii.part_no AS "partNo", rii.wcl_item_no AS "wclItemNo", rii.po_no AS "poNo", rii.line_qty AS "lineQty",
               rii.received_qty AS "receivedQty", rii.put_away_qty AS "putAwayQty",
               rii.ctn_no AS "ctnNo", rii.date_code AS "dateCode", rii.lot_code AS "lotCode",
               rii.coo, rii.cow, rii.org_id AS "orgId", rii.sub_inventory_code AS "subInventoryCode"
        FROM receiving_invoice_items_cn rii
        LEFT JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id`;

/** Set (or clear with null) editable fields on one CN receiving invoice item.
 *  One tx; one transaction_logs audit row per actually-changed field
 *  (to_state "admin_edit", metadata field/from/to — same pattern as the
 *  standard updateReceivingItemFields). `subInventory` validates the value
 *  against the item's org pair in org_info (the composite FK target);
 *  null/"" clears the nullable column. `suggestedShelf` read-modify-writes
 *  the override inside additional_data (null/"" clears the key back to the
 *  computed suggestion); free-text, advisory only. A `wclItemNo` change wins
 *  over `partNo`: a unique parts-master match supplies the canonical
 *  wcl_item_no and applies its part_no; a bare `partNo` change re-resolves
 *  wcl_item_no (NULL when ambiguous). Returns the updated row. */
export async function updateCnReceivingItemFields(
  db: AppDb,
  input: {
    itemId: string;
    fields: Partial<Record<CnItemField, string | null>>;
    actorId: string | null;
    /** Positive integer; received_qty follows while it is still 0. */
    lineQty?: number;
    subInventory?: string | null;
    suggestedShelf?: string | null;
  }
): Promise<CnItemRow> {
  const keys = (Object.keys(CN_ITEM_FIELDS) as CnItemField[]).filter((k) => k in input.fields);
  const hasSubInventory = input.subInventory !== undefined;
  const hasSuggestedShelf = input.suggestedShelf !== undefined;
  const hasLineQty = input.lineQty !== undefined;
  if (keys.length === 0 && !hasSubInventory && !hasSuggestedShelf && !hasLineQty)
    throw new HTTPException(400, { message: "no_fields" });
  const existing = await queryGet<
    Record<string, string | null> & {
      partNo: string;
      wclItemNo: string | null;
      orgId: number;
      lineQty: number | null;
      receivedQty: number;
      additionalData: Record<string, unknown> | null;
    }
  >(
    db,
    sql`SELECT part_no AS "partNo", wcl_item_no AS "wclItemNo", org_id AS "orgId",
               po_no AS "poNo", line_qty AS "lineQty", received_qty AS "receivedQty",
               date_code AS "dateCode", lot_code AS "lotCode", coo, cow, ctn_no AS "ctnNo",
               sub_inventory_code AS "subInventoryCode", additional_data AS "additionalData"
        FROM receiving_invoice_items_cn WHERE id = ${input.itemId}`
  );
  if (!existing) throw new HTTPException(404, { message: "receiving_cn_item_not_found" });
  if (input.subInventory !== null && input.subInventory !== undefined) {
    const pair = await queryGet<{ n: number }>(
      db,
      sql`SELECT COUNT(*)::int AS n FROM org_info
          WHERE org_id = ${existing.orgId} AND secondary_inventory_name = ${input.subInventory}`
    );
    if (!pair?.n) throw new HTTPException(400, { message: "invalid_sub_inventory" });
  }
  const itemMeta: Record<string, unknown> = { partNo: existing.partNo };
  if (existing.wclItemNo) itemMeta.wclItemNo = existing.wclItemNo;

  await db.transaction(async (tx) => {
    // A wcl_item_no edit wins over partNo: the uniquely matched master row
    // supplies the canonical wcl_item_no AND applies its part_no alongside.
    const wclChange = "wclItemNo" in input.fields ? input.fields.wclItemNo : undefined;
    const partNoChange = "partNo" in input.fields ? input.fields.partNo : undefined;
    const matchedPart = wclChange ? await resolvePartByWclItemNo(tx, wclChange) : null;
    // A bare part-no edit (no wcl change in the same call) re-resolves the
    // WCL key from the parts master (NULL when there is no unique match).
    const resolvedWcl =
      wclChange === undefined && partNoChange ? await resolveWclItemNo(tx, partNoChange) : undefined;
    const directKeys = keys.filter((k) => k !== "wclItemNo" && !(k === "partNo" && wclChange !== undefined));
    await queryRun(
      tx,
      sql`UPDATE receiving_invoice_items_cn SET ${sql.join(
        [
          ...directKeys.map((k) => sql`${sql.raw(CN_ITEM_FIELDS[k])} = ${input.fields[k] ?? null}`),
          ...(wclChange !== undefined ? [sql`wcl_item_no = ${matchedPart?.wclItemNo ?? wclChange}`] : []),
          ...(matchedPart ? [sql`part_no = ${matchedPart.partNo}`] : []),
          ...(wclChange === undefined && partNoChange !== undefined
            ? [sql`wcl_item_no = ${resolvedWcl ?? null}`]
            : []),
          ...(hasLineQty
            ? [
                sql`line_qty = ${input.lineQty!}`,
                sql`received_qty = CASE WHEN received_qty = 0 THEN ${input.lineQty!} ELSE received_qty END`,
              ]
            : []),
          ...(hasSubInventory ? [sql`sub_inventory_code = ${input.subInventory ?? null}`] : []),
          ...(hasSuggestedShelf
            ? input.suggestedShelf === null
              ? [sql`additional_data = additional_data - 'suggestedShelf'`]
              : [sql`additional_data = jsonb_set(COALESCE(additional_data, '{}'::jsonb), '{suggestedShelf}', to_jsonb(${input.suggestedShelf}::text))`]
            : []),
        ],
        sql`, `
      )}, last_update_date = ${now()} WHERE id = ${input.itemId}`
    );
    const existingOverride = existing.additionalData?.suggestedShelf;
    const auditEntries: { field: string; from: string | null; to: string | null }[] = directKeys.map((k) => ({
      field: CN_ITEM_FIELDS[k],
      from: existing[k],
      to: input.fields[k] ?? null,
    }));
    if (wclChange !== undefined) {
      auditEntries.push({
        field: "wcl_item_no",
        from: existing.wclItemNo,
        to: matchedPart?.wclItemNo ?? wclChange,
      });
      if (matchedPart) {
        auditEntries.push({ field: "part_no", from: existing.partNo, to: matchedPart.partNo });
      }
    } else if (partNoChange !== undefined) {
      auditEntries.push({
        field: "wcl_item_no",
        from: existing.wclItemNo,
        to: resolvedWcl ?? null,
      });
    }
    if (hasLineQty) {
      auditEntries.push({
        field: "line_qty",
        from: existing.lineQty === null ? null : String(existing.lineQty),
        to: String(input.lineQty!),
      });
    }
    if (hasSubInventory) {
      auditEntries.push({ field: "sub_inventory_code", from: existing.subInventoryCode, to: input.subInventory ?? null });
    }
    if (hasSuggestedShelf) {
      auditEntries.push({
        field: "suggested_shelf",
        from: typeof existingOverride === "string" ? existingOverride : null,
        to: input.suggestedShelf ?? null,
      });
    }
    for (const entry of auditEntries) {
      if (entry.from === entry.to) continue;
      await tx.insert(transactionLogs).values({
        id: newId(),
        entityType: "receiving_invoice_item_cn",
        entityId: input.itemId,
        fromState: null,
        toState: "admin_edit",
        actorId: input.actorId,
        metadata: { ...itemMeta, field: entry.field, from: entry.from, to: entry.to },
        createdDate: now(),
      });
    }
  });
  const row = await queryGet<CnItemRow>(db, sql`${CN_ITEM_SELECT} WHERE rii.id = ${input.itemId}`);
  return row!;
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
/** The receipt moment shared by the workflow finalize (cron) and the admin
 *  confirm: fill received_qty from line_qty (date code falls back to the
 *  order's), stamp the order in_hand + arrived, insert the CN put-away task
 *  (uniform item pair wins; else the order's org with NULL sub-inventory),
 *  with the audit rows. `orderLogMetadata` rides on the order's log row. */
async function receiveCnOrderTx(
  tx: AppDb,
  order: { id: string; status: string; orgId: number; dateCode: string | null },
  actorId: string | null,
  at: Date,
  orderLogMetadata: Record<string, unknown>
): Promise<{ changed: boolean; taskId: string | null }> {
  // Rows the sync left at received_qty = 0 inherit line_qty; rows with a real
  // received qty are untouched.
  await queryRun(
    tx,
    sql`UPDATE receiving_invoice_items_cn rii
        SET received_qty = rii.line_qty,
            date_code = COALESCE(rii.date_code, ${order.dateCode}),
            last_update_date = ${at}
        FROM receiving_invoices_cn ri
        WHERE rii.receiving_invoice_id = ri.id AND ri.receiving_order_id = ${order.id}
          AND rii.received_qty = 0 AND rii.line_qty IS NOT NULL`
  );
  const derived = await cnOrderPair(tx, order.id);
  const pair = { orgId: derived.orgId ?? order.orgId, subInventoryCode: derived.subInventoryCode };
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
      metadata: orderLogMetadata,
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
  return { changed: !!changed, taskId: task[0]?.id ?? null };
}

export async function finalizeCnOrder(db: AppDb, workflowRow: CnWorkflowRow, actorId: string | null): Promise<boolean> {
  const matchKey = workflowRow.batchNo ?? workflowRow.invoiceNo;
  if (!matchKey) return false;
  const order = await queryGet<{ id: string; status: string; orgId: number; dateCode: string | null }>(
    db,
    sql`SELECT id, status, org_id AS "orgId", date_code AS "dateCode" FROM receiving_orders_cn
        WHERE batch_no = ${matchKey}
        ORDER BY created_date DESC LIMIT 1`
  );
  if (!order) return false;

  await db.transaction(async (tx) => {
    const at = now();
    const { taskId } = await receiveCnOrderTx(tx, order, actorId, at, { workflowId: workflowRow.id });
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
      data: { workflowId: workflowRow.id, receivingOrderCnId: order.id, putAwayTaskCreated: taskId !== null },
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
