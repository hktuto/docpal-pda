import { pgTable, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, suppliers, parts } from "./master.js";

export const receivingOrders = pgTable(
  "receiving_orders",
  {
    id: text("id").primaryKey(),
    refNo: text("ref_no").notNull(),
    supplierId: text("supplier_id").references(() => suppliers.id),
    deliveryDate: timestamp("delivery_date", { mode: "date" }),
    status: text("status", { enum: ["pending", "in_hand", "provisional_received", "clear"] }).notNull().default("pending"),
    arrivedAt: timestamp("arrived_at", { mode: "date" }),
    arrivedBy: text("arrived_by").references(() => users.id),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    statusIdx: index("idx_receiving_orders_status").on(t.status),
  })
);

export const receivingInvoices = pgTable("receiving_invoices", {
  id: text("id").primaryKey(),
  receivingOrderId: text("receiving_order_id").notNull().references(() => receivingOrders.id, { onDelete: "cascade" }),
  invoiceNo: text("invoice_no").notNull(),
  supplierId: text("supplier_id").references(() => suppliers.id),
  wclCompanyName: text("wcl_company_name"),
  totalQty: integer("total_qty"),
  totalCtn: integer("total_ctn"),
  deliveryDate: timestamp("delivery_date", { mode: "date" }),
  orgId: integer("org_id").notNull().default(2),
  subInventoryCode: text("sub_inventory_code"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
});

export const receivingInvoiceItems = pgTable(
  "receiving_invoice_items",
  {
    id: text("id").primaryKey(),
    receivingInvoiceId: text("receiving_invoice_id").notNull().references(() => receivingInvoices.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull().references(() => parts.id),
    wclItemNo: text("wcl_item_no"),
    poNo: text("po_no"),
    poLine: text("po_line"),
    qty: integer("qty").notNull(),
    receivedQty: integer("received_qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    putAwayQty: integer("put_away_qty").notNull().default(0),
    boxId: text("box_id"),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
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
