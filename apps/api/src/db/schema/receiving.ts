import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";
import { mismatchStatuses } from "@warehouse/shared";
import { now } from "../now.js";
import { suppliers, parts } from "./master.js";

export const receivingOrders = sqliteTable(
  "receiving_orders",
  {
    id: text("id").primaryKey(),
    externalId: text("external_id").notNull().unique(),
    refNo: text("ref_no").notNull(),
    deliveryDate: text("delivery_date"),
    status: text("status", { enum: ["pending", "in_hand", "clear"] }).notNull(),
    supplierId: text("supplier_id").references(() => suppliers.id),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    statusUpdatedIdx: index("receiving_orders_status_updated_idx").on(t.status, t.updatedAt),
    supplierIdx: index("receiving_orders_supplier_idx").on(t.supplierId),
  })
);

export const receivingInvoices = sqliteTable(
  "receiving_invoices",
  {
    id: text("id").primaryKey(),
    externalId: text("external_id"),
    receivingOrderId: text("receiving_order_id").notNull().references(() => receivingOrders.id, { onDelete: "cascade" }),
    invoiceNo: text("invoice_no").notNull(),
    supplierId: text("supplier_id").references(() => suppliers.id),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("receiving_invoices_order_idx").on(t.receivingOrderId),
    orderInvoiceUq: unique("receiving_invoices_order_invoice_uq").on(t.receivingOrderId, t.invoiceNo),
    supplierIdx: index("receiving_invoices_supplier_idx").on(t.supplierId),
  })
);

export const receivingInvoiceItems = sqliteTable(
  "receiving_invoice_items",
  {
    id: text("id").primaryKey(),
    receivingInvoiceId: text("receiving_invoice_id").notNull().references(() => receivingInvoices.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull().references(() => parts.id),
    qty: integer("qty").notNull().default(0),
    receivedQty: integer("received_qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    putAwayQty: integer("put_away_qty").notNull().default(0),
    allocatedQty: integer("allocated_qty").notNull().default(0), // MAINTAINED = Σ allocation_receiving_items.qty
    availableQty: integer("available_qty").notNull().default(0), // MAINTAINED = received - picked - put_away - allocated
    boxId: text("box_id"),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    dateCodeNorm: text("date_code_norm"),
    lotCodeNorm: text("lot_code_norm"),
    cooNorm: text("coo_norm"),
    cowNorm: text("cow_norm"),
    lineNo: integer("line_no"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    partAvailIdx: index("rii_part_available_idx").on(t.partId, t.availableQty),
    invoiceIdx: index("rii_invoice_idx").on(t.receivingInvoiceId),
    invoiceLineUq: unique("rii_invoice_line_uq").on(t.receivingInvoiceId, t.lineNo),
  })
);

export const receivingItemMismatches = sqliteTable(
  "receiving_item_mismatches",
  {
    id: text("id").primaryKey(),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // mirrors the web's `reason` (mismatchReasons enum)
    mismatchQty: integer("mismatch_qty"),
    wrongPartNo: text("wrong_part_no"),
    note: text("note"),
    status: text("status", { enum: mismatchStatuses }).notNull().default("pending"),
    effectiveReceivedQty: integer("effective_received_qty"),
    previousReceivedQty: integer("previous_received_qty"),
    reportedBy: text("reported_by"),
    confirmedBy: text("confirmed_by"),
    confirmedAt: text("confirmed_at"),
    cancelledBy: text("cancelled_by"),
    cancelledAt: text("cancelled_at"),
    createdAt: text("created_at").notNull().$defaultFn(now), // plays the role of the web's reported_at
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ itemIdx: index("rim_item_idx").on(t.receivingInvoiceItemId) })
);
