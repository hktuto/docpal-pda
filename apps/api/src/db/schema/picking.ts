import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";
import { parts } from "./master.js";

export const pickingOrders = sqliteTable(
  "picking_orders",
  {
    id: text("id").primaryKey(),
    externalId: text("external_id").notNull().unique(),
    refNo: text("ref_no").notNull(),
    status: text("status", { enum: ["pending", "picking", "finished", "issue"] }).notNull(),
    shipTo: text("ship_to"),
    destinationCountry: text("destination_country"),
    issueReason: text("issue_reason"),
    issueNote: text("issue_note"),
    issueQty: integer("issue_qty"),
    issuePackSize: integer("issue_pack_size"),
    issueRemark: text("issue_remark"),
    issueReportedAt: text("issue_reported_at"),
    issueReportedBy: text("issue_reported_by"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ statusUpdatedIdx: index("picking_orders_status_updated_idx").on(t.status, t.updatedAt) })
);

export const pickingItems = sqliteTable(
  "picking_items",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull().references(() => parts.id),
    qty: integer("qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    allocatedQty: integer("allocated_qty").notNull().default(0), // MAINTAINED = Σ allocations.qty
    requiredDateCode: text("required_date_code"),
    sourceShelfCode: text("source_shelf_code"),
    scannedNotBoxedQty: integer("scanned_not_boxed_qty").notNull().default(0), // MAINTAINED
    remainingQty: integer("remaining_qty").generatedAlwaysAs(sql`qty - picked_qty - scanned_not_boxed_qty`, { mode: "stored" }),
    lineId: text("line_id"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    partIdx: index("picking_items_part_idx").on(t.partId),
    orderIdx: index("picking_items_order_idx").on(t.pickingOrderId),
    orderLineUq: unique("picking_items_order_line_uq").on(t.pickingOrderId, t.lineId),
  })
);

export const shippingBoxes = sqliteTable(
  "shipping_boxes",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["open", "closed", "verified"] }).notNull().default("open"),
    boxSize: text("box_size"),
    netWeightG: integer("net_weight_g"),
    grossWeightG: integer("gross_weight_g"),
    destinationCountry: text("destination_country"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("shipping_boxes_order_idx").on(t.pickingOrderId),
    statusIdx: index("shipping_boxes_status_idx").on(t.status),
  })
);

export const pickingPackages = sqliteTable(
  "picking_packages",
  {
    id: text("id").primaryKey(),
    pickingItemId: text("picking_item_id").notNull().references(() => pickingItems.id, { onDelete: "cascade" }),
    sourceType: text("source_type", { enum: ["receiving_invoice_item", "inventory_lot"] }).notNull(),
    sourceId: text("source_id").notNull(),
    qty: integer("qty").notNull().default(0),
    shippingBoxId: text("shipping_box_id").references(() => shippingBoxes.id),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    verified: integer("verified").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    boxIdx: index("picking_packages_box_idx").on(t.shippingBoxId),
    itemIdx: index("picking_packages_item_idx").on(t.pickingItemId),
  })
);
