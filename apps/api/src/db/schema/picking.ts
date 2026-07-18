import { pgTable, text, integer, boolean, real, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, suppliers, parts } from "./master.js";

export const pickingOrders = pgTable(
  "picking_orders",
  {
    id: text("id").primaryKey(),
    refNo: text("ref_no").notNull(),
    supplierId: text("supplier_id").references(() => suppliers.id),
    deliveryDate: timestamp("delivery_date", { mode: "date" }),
    poNo: text("po_no"),
    requiredDateCodeNotice: text("required_date_code_notice"),
    shipTo: text("ship_to"),
    destinationCountry: text("destination_country"),
    issueReason: text("issue_reason"),
    issueQty: integer("issue_qty"),
    issuePackSize: integer("issue_pack_size"),
    issueNote: text("issue_note"),
    issueRemark: text("issue_remark"),
    issueReportedAt: timestamp("issue_reported_at", { mode: "date" }),
    issueReportedBy: text("issue_reported_by").references(() => users.id),
    status: text("status", { enum: ["pending", "picking", "finished", "issue"] }).notNull().default("pending"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    statusIdx: index("idx_picking_orders_status").on(t.status),
  })
);

export const pickingItems = pgTable(
  "picking_items",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull().references(() => parts.id),
    qty: integer("qty").notNull(),
    pickedQty: integer("picked_qty").notNull().default(0),
    allocatedQty: integer("allocated_qty").notNull().default(0), // MAINTAINED = Σ allocations.qty
    requiredDateCode: text("required_date_code"),
    sourceShelfCode: text("source_shelf_code"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("idx_picking_items_order").on(t.pickingOrderId),
    partIdx: index("idx_picking_items_part").on(t.partId),
  })
);

export const measuringTasks = pgTable(
  "measuring_tasks",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "completed"] }).notNull().default("pending"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    pickingOrderUq: uniqueIndex("idx_measuring_tasks_picking_order").on(t.pickingOrderId),
  })
);

export const shippingBoxes = pgTable(
  "shipping_boxes",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").references(() => pickingOrders.id),
    measuringTaskId: text("measuring_task_id").references(() => measuringTasks.id),
    status: text("status", { enum: ["open", "closed", "verified"] }).notNull().default("open"),
    grossWeight: real("gross_weight"),
    netWeight: real("net_weight"),
    destinationCountry: text("destination_country"),
    boxSize: text("box_size"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    taskIdx: index("idx_shipping_boxes_task").on(t.measuringTaskId),
    orderIdx: index("idx_shipping_boxes_order").on(t.pickingOrderId),
  })
);

export const pickingPackages = pgTable(
  "picking_packages",
  {
    id: text("id").primaryKey(),
    pickingItemId: text("picking_item_id").notNull().references(() => pickingItems.id, { onDelete: "cascade" }),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    sourceType: text("source_type", { enum: ["receiving_invoice_item", "inventory_lot"] }).notNull(),
    sourceId: text("source_id").notNull(),
    qty: integer("qty").notNull(),
    shippingBoxId: text("shipping_box_id").references(() => shippingBoxes.id),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    verified: boolean("verified").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    itemIdx: index("idx_picking_packages_item").on(t.pickingItemId),
    orderIdx: index("idx_picking_packages_order").on(t.pickingOrderId),
    boxIdx: index("idx_picking_packages_box").on(t.shippingBoxId),
  })
);

// Compat table — the packing truth stays in picking_packages.
export const shippingBoxItems = pgTable(
  "shipping_box_items",
  {
    id: text("id").primaryKey(),
    shippingBoxId: text("shipping_box_id").notNull().references(() => shippingBoxes.id, { onDelete: "cascade" }),
    pickingItemId: text("picking_item_id").references(() => pickingItems.id),
    partId: text("part_id").notNull().references(() => parts.id),
    qty: integer("qty").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    boxIdx: index("idx_shipping_box_items_box").on(t.shippingBoxId),
  })
);
