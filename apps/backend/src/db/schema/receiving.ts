import { pgTable, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { defaultWarehouse } from "../../config.js";
import { users, suppliers, parts, subInventories, warehouseSections } from "./master.js";

// = Packing List Batch
export const receivingOrders = pgTable(
  "receiving_orders",
  {
    id: text("id").primaryKey(),
    refNo: text("ref_no").notNull(),
    externalId: text("external_id"), // ingest sync key (PUT /receiving-orders/:externalId); null = created locally
    supplierId: text("supplier_id").references(() => suppliers.id),
    deliveryDate: timestamp("delivery_date", { mode: "date" }),
    warehouseCode: text("warehouse_code").notNull().default("HK1").$defaultFn(defaultWarehouse), // 收货仓库（实例默认 WAREHOUSE_CODE）
    warehouseSectionCode: text("warehouse_section_code").references(() => warehouseSections.code), // 收货仓库分区
    subInventoryCode: text("sub_inventory_code").notNull().references(() => subInventories.code), // 收货入哪一个子库存（每单必有）
    dateCode: text("date_code"), // 整单 date code；行无 date_code 时继承此值
    status: text("status").notNull().default("pending"), // pending | provisional_received(暫收貨) | clear
    arrivedAt: timestamp("arrived_at", { mode: "date" }),
    arrivedBy: text("arrived_by").references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    statusIdx: index("idx_receiving_orders_status").on(t.status),
    externalIdUq: uniqueIndex("idx_receiving_orders_external_id").on(t.externalId),
  })
);

// = Packing List Header
export const receivingInvoices = pgTable("receiving_invoices", {
  id: text("id").primaryKey(),
  receivingOrderId: text("receiving_order_id").notNull().references(() => receivingOrders.id, { onDelete: "cascade" }),
  invoiceNo: text("invoice_no").notNull(),
  supplierId: text("supplier_id").references(() => suppliers.id),
  wclCompanyName: text("wcl_company_name"), // 出货方公司名，非供应商名
  totalQty: integer("total_qty"), // 总组件数量
  totalCtn: integer("total_ctn"), // 总箱数
  deliveryDate: timestamp("delivery_date", { mode: "date" }), // 出货日期，非入库时间
  orgId: integer("org_id").notNull().default(2), // 出货方办公室, 2: HK
  warehouseCode: text("warehouse_code").notNull().default("HK1").$defaultFn(defaultWarehouse), // 收货仓库（实例默认 WAREHOUSE_CODE）
  warehouseSectionCode: text("warehouse_section_code").references(() => warehouseSections.code), // 收货仓库分区
  subInventoryCode: text("sub_inventory_code").references(() => subInventories.code), // 放到哪一个子库仓库中，如 STORE1，允许为空
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
});

// = Packing List Line Items
export const receivingInvoiceItems = pgTable(
  "receiving_invoice_items",
  {
    id: text("id").primaryKey(),
    receivingInvoiceId: text("receiving_invoice_id").notNull().references(() => receivingInvoices.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull().references(() => parts.id),
    wclItemNo: text("wcl_item_no"), // WCL Part No（行级冗余，便于 OCR 对账）
    poNo: text("po_no"),
    poLine: text("po_line"),
    qty: integer("qty").notNull(), // 应收 / Expected 单据量
    receivedQty: integer("received_qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    putAwayQty: integer("put_away_qty").notNull().default(0),
    boxId: text("box_id"),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"), // country_of_origin
    cow: text("cow"), // country_of_wafer
    reportedMismatch: boolean("reported_mismatch").notNull().default(false),
    mismatchReason: text("mismatch_reason"),
    mismatchQty: integer("mismatch_qty"),
    wrongPartNo: text("wrong_part_no"),
    mismatchNote: text("mismatch_note"),
  },
  (t) => ({
    invoiceIdx: index("idx_receiving_invoice_items_invoice").on(t.receivingInvoiceId),
    partIdx: index("idx_receiving_invoice_items_part").on(t.partId),
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
    scannedAt: timestamp("scanned_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    orderSerialUq: uniqueIndex("idx_receiving_scan_labels_order_serial").on(t.receivingOrderId, t.serialNo),
  })
);
