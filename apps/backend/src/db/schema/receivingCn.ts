import { pgTable, text, integer, timestamp, index, uniqueIndex, foreignKey, jsonb } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, subInventories } from "./master.js";

// ---------------------------------------------------------------------------
// Customer receiving (CN) tables (spec
// docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md).
// Parallel world to the standard receiving flow: the external upstream-sync
// service writes these from the DocPal workflow output; our backend reads them
// for finalization + the dedicated CN put-away flow. Never joined with the
// standard receiving_orders chain.
// ---------------------------------------------------------------------------

// = CN receiving order (收貨確認及付款通知書); batch_no = the CN 編號.
export const receivingOrdersCn = pgTable(
  "receiving_orders_cn",
  {
    id: text("id").primaryKey(),
    batchNo: text("batch_no").notNull(), // CN 編號
    deliveryDate: timestamp("delivery_date", { mode: "date" }),
    orgId: integer("org_id").notNull().default(2), // 收货办公室, 2: HK
    dateCode: text("date_code"),
    status: text("status").notNull().default("pending"), // pending | in_hand | clear
    arrivedAt: timestamp("arrived_at", { mode: "date" }),
    arrivedBy: text("arrived_by").references(() => users.id),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    batchNoIdx: index("idx_receiving_orders_cn_batch_no").on(t.batchNo),
    statusIdx: index("idx_receiving_orders_cn_status").on(t.status),
  })
);

export const receivingInvoicesCn = pgTable(
  "receiving_invoices_cn",
  {
    id: text("id").primaryKey(),
    receivingOrderId: text("receiving_order_id").notNull().references(() => receivingOrdersCn.id, { onDelete: "cascade" }),
    invoiceNo: text("invoice_no").notNull(),
    totalQty: integer("total_qty"),
    totalCtn: integer("total_ctn"),
    deliveryDate: timestamp("delivery_date", { mode: "date" }),
    orgId: integer("org_id").notNull().default(2),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  }
);

export const receivingInvoiceItemsCn = pgTable(
  "receiving_invoice_items_cn",
  {
    id: text("id").primaryKey(),
    receivingInvoiceId: text("receiving_invoice_id").notNull().references(() => receivingInvoicesCn.id, { onDelete: "cascade" }),
    partNo: text("part_no").notNull(), // plain text (no FK — parts.part_no is not unique)
    wclItemNo: text("wcl_item_no"),
    poNo: text("po_no"),
    poLine: text("po_line"),
    lineQty: integer("line_qty"),
    receivedQty: integer("received_qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    putAwayQty: integer("put_away_qty").notNull().default(0),
    ctnNo: text("ctn_no"),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    drawingNo: text("drawing_no"),
    orgId: integer("org_id").notNull().default(2),
    subInventoryCode: text("sub_inventory_code"),
    reportedMismatch: integer("reported_mismatch").notNull().default(0),
    mismatchReason: text("mismatch_reason"),
    mismatchQty: integer("mismatch_qty"),
    wrongPartNo: text("wrong_part_no"),
    mismatchNote: text("mismatch_note"),
    additionalData: jsonb("additional_data"),
    orderData: jsonb("order_data"),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    invoiceIdx: index("idx_receiving_invoice_items_cn_invoice").on(t.receivingInvoiceId),
    partIdx: index("idx_receiving_invoice_items_cn_part").on(t.partNo),
    subInvFk: foreignKey({ name: "receiving_invoice_items_cn_sub_inv_fk", columns: [t.orgId, t.subInventoryCode], foreignColumns: [subInventories.orgId, subInventories.secondaryInventoryName] }),
  })
);

// Dedicated CN put-away task — does NOT touch put_away_tasks.
export const putAwayTasksCn = pgTable(
  "put_away_tasks_cn",
  {
    id: text("id").primaryKey(),
    receivingOrderCnId: text("receiving_order_cn_id").notNull()
      .references(() => receivingOrdersCn.id, { onDelete: "cascade" }),
    orgId: integer("org_id"), // uniform pair from the order's items, NULL when mixed
    subInventoryCode: text("sub_inventory_code"),
    status: text("status").notNull().default("pending"), // pending | completed
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    orderUq: uniqueIndex("idx_put_away_tasks_cn_order").on(t.receivingOrderCnId),
    statusIdx: index("idx_put_away_tasks_cn_status").on(t.status),
    subInvFk: foreignKey({ name: "put_away_tasks_cn_sub_inv_fk", columns: [t.orgId, t.subInventoryCode], foreignColumns: [subInventories.orgId, subInventories.secondaryInventoryName] }),
  })
);

// Upload tracking: one row per DocPal workflow kick (excel phase today, pdf in
// phase 2); the status cron polls DocPal and finalizes on completion.
export const receivingCnWorkflows = pgTable(
  "receiving_cn_workflows",
  {
    id: text("id").primaryKey(),
    phase: text("phase").notNull(), // excel | pdf
    invoiceNo: text("invoice_no"), // CN 編號 = batch_no (finalize matches on it)
    supplier: text("supplier"),
    filename: text("filename"),
    docpalDocumentId: text("docpal_document_id"),
    docpalProcessId: text("docpal_process_id"),
    docpalBusinessKey: text("docpal_business_key"),
    /** Generated correlation key (CN-YYYYMMDD-XXXXXX) — travels inside the
     *  workflow payload; the upstream sync stamps it onto the CN order's
     *  batch_no so the admin list can join order ↔ workflow. NULL on rows
     *  predating the column (those match by invoice_no). */
    batchNo: text("batch_no"),
    status: text("status").notNull().default("workflow_running"), // workflow_running | completed | failed | cancelled
    payload: jsonb("payload").notNull(), // the verified payload object (sent to DocPal as excel_result_data: [payload])
    error: text("error"),
    createdBy: text("created_by").notNull(),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    statusIdx: index("idx_receiving_cn_workflows_status").on(t.status),
    processIdx: index("idx_receiving_cn_workflows_process").on(t.docpalProcessId),
  })
);
