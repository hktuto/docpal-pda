import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";
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
  (t) => ({ statusUpdatedIdx: index("receiving_orders_status_updated_idx").on(t.status, t.updatedAt) })
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
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    partAvailIdx: index("rii_part_available_idx").on(t.partId, t.availableQty),
    invoiceIdx: index("rii_invoice_idx").on(t.receivingInvoiceId),
  })
);

export const receivingItemMismatches = sqliteTable(
  "receiving_item_mismatches",
  {
    id: text("id").primaryKey(),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ itemIdx: index("rim_item_idx").on(t.receivingInvoiceItemId) })
);
