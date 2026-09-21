import { pgTable, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { now } from "../now.js";

// Remote-sync review mirrors of the receiving tables (remote DDL: demo.wms_*,
// wms_ prefix dropped here). Written by the external sync service, not by this
// app — intentionally no FKs and no sync_events trigger (same as the remote DDL).

export const receivingOrdersReview = pgTable("receiving_orders_review", {
  id: text("id").primaryKey(),
  batchNo: text("batch_no").notNull(),
  supplierCode: text("supplier_code"),
  deliveryDate: timestamp("delivery_date", { mode: "date" }),
  orgId: integer("org_id").notNull().default(2),
  dateCode: text("date_code"),
  status: text("status").notNull().default("pending"),
  arrivedAt: timestamp("arrived_at", { mode: "date" }),
  arrivedBy: text("arrived_by"),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

export const receivingInvoicesReview = pgTable("receiving_invoices_review", {
  id: text("id").primaryKey(),
  receivingOrderId: text("receiving_order_id").notNull(),
  invoiceNo: text("invoice_no").notNull(),
  supplierCode: text("supplier_code"),
  wclCompanyName: text("wcl_company_name"),
  totalQty: integer("total_qty"),
  totalCtn: integer("total_ctn"),
  deliveryDate: timestamp("delivery_date", { mode: "date" }),
  orgId: integer("org_id").notNull().default(2),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

export const receivingInvoiceItemsReview = pgTable("receiving_invoice_items_review", {
  id: text("id").primaryKey(),
  receivingInvoiceId: text("receiving_invoice_id").notNull(),
  partNo: text("part_no").notNull(),
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
  orgId: integer("org_id").notNull().default(2),
  subInventoryCode: text("sub_inventory_code"),
  drawingNo: text("drawing_no"),
  reportedMismatch: boolean("reported_mismatch").notNull().default(false),
  mismatchReason: text("mismatch_reason"),
  mismatchQty: integer("mismatch_qty"),
  wrongPartNo: text("wrong_part_no"),
  mismatchNote: text("mismatch_note"),
  additionalData: jsonb("additional_data"),
  orderData: jsonb("order_data"),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});
