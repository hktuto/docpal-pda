import { pgTable, text, integer, boolean, timestamp, index, uniqueIndex, foreignKey, jsonb } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, suppliers, subInventories } from "./master.js";

// = Packing List Batch
export const receivingOrders = pgTable(
  "receiving_orders",
  {
    id: text("id").primaryKey(),
    batchNo: text("batch_no").notNull(), // 批次参考号（原 ref_no）
    supplierCode: text("supplier_code").references(() => suppliers.code),
    deliveryDate: timestamp("delivery_date", { mode: "date" }),
    orgId: integer("org_id").notNull().default(2), // 收货办公室, 2: HK
    subInventoryCode: text("sub_inventory_code").notNull(), // 收货入哪一个子库存（每单必有）
    dateCode: text("date_code"), // 整单 date code；行无 date_code 时继承此值
    status: text("status").notNull().default("pending"), // pending | in_hand | provisional_received | clear
    arrivedAt: timestamp("arrived_at", { mode: "date" }),
    arrivedBy: text("arrived_by").references(() => users.id),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    statusIdx: index("idx_receiving_orders_status").on(t.status),
    // Composite FK → sub_inventories (org_id, secondary_inventory_name) group (3-level model).
    subInvFk: foreignKey({ name: "receiving_orders_sub_inv_fk", columns: [t.orgId, t.subInventoryCode], foreignColumns: [subInventories.orgId, subInventories.secondaryInventoryName] }),
  })
);

// = Packing List Header
export const receivingInvoices = pgTable(
  "receiving_invoices",
  {
    id: text("id").primaryKey(),
    receivingOrderId: text("receiving_order_id").notNull().references(() => receivingOrders.id, { onDelete: "cascade" }),
    invoiceNo: text("invoice_no").notNull(),
    supplierCode: text("supplier_code").references(() => suppliers.code),
    wclCompanyName: text("wcl_company_name"), // 出货方公司名，非供应商名
    totalQty: integer("total_qty"), // 总组件数量
    totalCtn: integer("total_ctn"), // 总箱数
    deliveryDate: timestamp("delivery_date", { mode: "date" }), // 出货日期，非入库时间
    orgId: integer("org_id").notNull().default(2), // 出货方办公室, 2: HK
    subInventoryCode: text("sub_inventory_code"), // 放到哪一个子库存中，如 STORE1，允许为空
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    subInvFk: foreignKey({ name: "receiving_invoices_sub_inv_fk", columns: [t.orgId, t.subInventoryCode], foreignColumns: [subInventories.orgId, subInventories.secondaryInventoryName] }),
  })
);

// = Packing List Line Items
export const receivingInvoiceItems = pgTable(
  "receiving_invoice_items",
  {
    id: text("id").primaryKey(),
    receivingInvoiceId: text("receiving_invoice_id").notNull().references(() => receivingInvoices.id, { onDelete: "cascade" }),
    partNo: text("part_no").notNull(), // plain text (no FK — parts.part_no is not unique)
    wclItemNo: text("wcl_item_no"), // WCL Part No（行级冗余，便于 OCR 对账）
    poNo: text("po_no"),
    poLine: text("po_line"),
    lineQty: integer("line_qty").notNull(), // 应收 / Expected 单据量（与 Oracle DB line qty 一致）
    receivedQty: integer("received_qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    putAwayQty: integer("put_away_qty").notNull().default(0),
    ctnNo: text("ctn_no"), // 箱号（原 box_id）
    dateCode: text("date_code"),
    lotCode: text("lot_code"), // lot_no
    coo: text("coo"), // country_of_origin
    cow: text("cow"), // country_of_wafer
    orgId: integer("org_id").notNull().default(2), // 收货办公室, 2: HK
    subInventoryCode: text("sub_inventory_code"), // 子库存，允许为空
    reportedMismatch: boolean("reported_mismatch").notNull().default(false),
    mismatchReason: text("mismatch_reason"),
    mismatchQty: integer("mismatch_qty"),
    wrongPartNo: text("wrong_part_no"),
    mismatchNote: text("mismatch_note"),
    additionalData: jsonb("additional_data"), // 上游额外字段透传（无固定结构）
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    invoiceIdx: index("idx_receiving_invoice_items_invoice").on(t.receivingInvoiceId),
    partIdx: index("idx_receiving_invoice_items_part").on(t.partNo),
    subInvFk: foreignKey({ name: "receiving_invoice_items_sub_inv_fk", columns: [t.orgId, t.subInventoryCode], foreignColumns: [subInventories.orgId, subInventories.secondaryInventoryName] }),
  })
);

// Scanned-label dedup for receiving scans (S-key serial from the supplier QR
// template): one row per successfully scanned label that carried a serial;
// the unique index on (receiving_order_id, serial_no) rejects double-scanning
// the same physical label (409 label_already_scanned).
export const receivingScanLabels = pgTable(
  "receiving_scan_labels",
  {
    id: text("id").primaryKey(),
    receivingOrderId: text("receiving_order_id").notNull().references(() => receivingOrders.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
    serialNo: text("serial_no").notNull(),
    qty: integer("qty").notNull(),
    scannedBy: text("scanned_by").references(() => users.id),
    scannedAt: timestamp("scanned_at", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    orderSerialUq: uniqueIndex("idx_receiving_scan_labels_order_serial").on(t.receivingOrderId, t.serialNo),
  })
);
