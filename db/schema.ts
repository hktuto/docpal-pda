import { pgTable, text, integer, boolean, real, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// ------------------------------------------------------------------
// Reference tables
// ------------------------------------------------------------------

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(), // demo only
  displayName: text("display_name").notNull(),
  role: text("role", { enum: ["operator", "admin"] }).notNull().default("operator"),
  createdAt: timestamp("created_at").notNull(),
});

export const suppliers = pgTable("suppliers", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
});

export const parts = pgTable("parts", {
  id: text("id").primaryKey(),
  partNo: text("part_no").notNull().unique(),        // customer part-id
  internalCode: text("internal_code"),                // e.g. KOA item code
  description: text("description"),
  defaultCoo: text("default_coo"),
});

export const shelves = pgTable("shelves", {
  code: text("code").primaryKey(),
  zone: text("zone"),
});

// ------------------------------------------------------------------
// Receiving
// ------------------------------------------------------------------

export const receivingOrderStatus = ["pending", "in_hand", "clear"] as const;

export const receivingOrders = pgTable("receiving_orders", {
  id: text("id").primaryKey(),
  refNo: text("ref_no").notNull(),                    // RO number
  supplierId: text("supplier_id").references(() => suppliers.id),
  deliveryDate: timestamp("delivery_date"),
  status: text("status", { enum: receivingOrderStatus }).notNull().default("pending"),
  arrivedAt: timestamp("arrived_at"),
  arrivedBy: text("arrived_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const receivingInvoices = pgTable("receiving_invoices", {
  id: text("id").primaryKey(),
  receivingOrderId: text("receiving_order_id")
    .notNull()
    .references(() => receivingOrders.id, { onDelete: "cascade" }),
  invoiceNo: text("invoice_no").notNull(),
  supplierId: text("supplier_id").references(() => suppliers.id),
});

export const mismatchReasons = [
  "not_found",
  "damaged",
  "qty_mismatch",
  "wrong_part",
  "over_shipment",
  "quality_rejection",
] as const;

export type MismatchReason = (typeof mismatchReasons)[number];

export const receivingInvoiceItems = pgTable("receiving_invoice_items", {
  id: text("id").primaryKey(),
  receivingInvoiceId: text("receiving_invoice_id")
    .notNull()
    .references(() => receivingInvoices.id, { onDelete: "cascade" }),
  partId: text("part_id").notNull().references(() => parts.id),
  poNo: text("po_no"),                                 // PO number
  poLine: text("po_line"),
  qty: integer("qty").notNull(),                       // expected qty
  receivedQty: integer("received_qty").notNull().default(0),
  pickedQty: integer("picked_qty").notNull().default(0),
  putAwayQty: integer("put_away_qty").notNull().default(0),
  boxId: text("box_id"),                               // optional pre-printed box id
  dateCode: text("date_code"),
  lotCode: text("lot_code"),
  coo: text("coo"),
  cow: text("cow"),
  reportedMismatch: boolean("reported_mismatch").notNull().default(false),
  mismatchReason: text("mismatch_reason", { enum: mismatchReasons }),
  mismatchQty: integer("mismatch_qty"),
  wrongPartNo: text("wrong_part_no"),
  mismatchNote: text("mismatch_note"),
});

// ------------------------------------------------------------------
// Picking
// ------------------------------------------------------------------

export const pickingOrderStatus = ["pending", "picking", "finished", "issue"] as const;

export const pickingIssueReasons = [
  "insufficient_stock",
  "cannot_divide",
  "merge",
  "other",
] as const;

export type PickingIssueReason = (typeof pickingIssueReasons)[number];

export const pickingOrders = pgTable("picking_orders", {
  id: text("id").primaryKey(),
  refNo: text("ref_no").notNull(),                    // TN / PI number
  supplierId: text("supplier_id").references(() => suppliers.id),
  deliveryDate: timestamp("delivery_date"),
  poNo: text("po_no"),                                 // may match receiving PO
  requiredDateCodeNotice: text("required_date_code_notice"),
  shipTo: text("ship_to"),
  destinationCountry: text("destination_country"),
  status: text("status", { enum: pickingOrderStatus }).notNull().default("pending"),
  issueReason: text("issue_reason", { enum: pickingIssueReasons }),
  issueQty: integer("issue_qty"),
  issuePackSize: integer("issue_pack_size"),
  issueNote: text("issue_note"),     // common note applied to all selected orders
  issueRemark: text("issue_remark"), // per-order remark
  issueReportedAt: timestamp("issue_reported_at"),
  issueReportedBy: text("issue_reported_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const pickingItems = pgTable("picking_items", {
  id: text("id").primaryKey(),
  pickingOrderId: text("picking_order_id")
    .notNull()
    .references(() => pickingOrders.id, { onDelete: "cascade" }),
  partId: text("part_id").notNull().references(() => parts.id),
  qty: integer("qty").notNull(),
  pickedQty: integer("picked_qty").notNull().default(0), // boxed quantity
  allocatedQty: integer("allocated_qty").notNull().default(0),
  requiredDateCode: text("required_date_code"),
  sourceShelfCode: text("source_shelf_code"),
});

export const packageSourceType = ["receiving_invoice_item", "inventory_lot"] as const;

export const pickingPackages = pgTable("picking_packages", {
  id: text("id").primaryKey(),
  pickingItemId: text("picking_item_id")
    .notNull()
    .references(() => pickingItems.id, { onDelete: "cascade" }),
  pickingOrderId: text("picking_order_id")
    .notNull()
    .references(() => pickingOrders.id, { onDelete: "cascade" }),
  sourceType: text("source_type", { enum: packageSourceType }).notNull(),
  sourceId: text("source_id").notNull(),
  qty: integer("qty").notNull(),
  shippingBoxId: text("shipping_box_id").references(() => shippingBoxes.id),
  dateCode: text("date_code"),
  lotCode: text("lot_code"),
  coo: text("coo"),
  cow: text("cow"),
  verified: boolean("verified").notNull().default(false),
  createdAt: timestamp("created_at").notNull(),
});

// ------------------------------------------------------------------
// Inventory & allocation
// ------------------------------------------------------------------

export const inventoryLots = pgTable("inventory_lots", {
  id: text("id").primaryKey(),
  partId: text("part_id").notNull().references(() => parts.id),
  dateCode: text("date_code"),
  lotCode: text("lot_code"),
  coo: text("coo"),
  cow: text("cow"),
  shelfCode: text("shelf_code").references(() => shelves.code),
  boxId: text("box_id"),                               // matches shipping_boxes.id or shelf_boxes.id, or null
  totalQty: integer("total_qty").notNull().default(0),
  allocatedQty: integer("allocated_qty").notNull().default(0),
  availableQty: integer("available_qty")
    .notNull()
    .generatedAlwaysAs(sql`total_qty - allocated_qty`),
}, (t) => ({
  // one lot per unique part + date + COO + COW + location combination
  // receiving-area lots (no location) may be duplicated so each allocation owns its own lot
  uniqueLot: uniqueIndex("inventory_lots_unique_lot")
    .on(t.partId, t.dateCode, t.coo, t.cow, t.shelfCode, t.boxId)
    .where(sql`${t.shelfCode} is not null or ${t.boxId} is not null`),
}));

export const inventoryLotSources = pgTable("inventory_lot_sources", {
  id: text("id").primaryKey(),
  inventoryLotId: text("inventory_lot_id")
    .notNull()
    .references(() => inventoryLots.id, { onDelete: "cascade" }),
  receivingInvoiceItemId: text("receiving_invoice_item_id")
    .notNull()
    .references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
  qty: integer("qty").notNull(),
}, (t) => ({
  uniqueSource: uniqueIndex("inventory_lot_sources_unique")
    .on(t.inventoryLotId, t.receivingInvoiceItemId),
}));

export const allocations = pgTable("allocations", {
  id: text("id").primaryKey(),
  pickingItemId: text("picking_item_id")
    .notNull()
    .references(() => pickingItems.id, { onDelete: "cascade" }),
  inventoryLotId: text("inventory_lot_id")
    .references(() => inventoryLots.id, { onDelete: "cascade" }),
  receivingInvoiceItemId: text("receiving_invoice_item_id")
    .references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
  qty: integer("qty").notNull(),
});

// ------------------------------------------------------------------
// Measuring tasks & shipping boxes
// ------------------------------------------------------------------

export const measuringTaskStatus = ["pending", "completed"] as const;

export const measuringTasks = pgTable("measuring_tasks", {
  id: text("id").primaryKey(),
  pickingOrderId: text("picking_order_id")
    .notNull()
    .references(() => pickingOrders.id, { onDelete: "cascade" })
    .unique(),
  status: text("status", { enum: measuringTaskStatus }).notNull().default("pending"),
  createdAt: timestamp("created_at").notNull(),
});

export const boxStatus = ["open", "closed", "verified"] as const;

export const shippingBoxes = pgTable("shipping_boxes", {
  id: text("id").primaryKey(),                         // printed shipping label
  pickingOrderId: text("picking_order_id").references(() => pickingOrders.id),
  measuringTaskId: text("measuring_task_id").references(() => measuringTasks.id),
  status: text("status", { enum: boxStatus }).notNull().default("open"),
  grossWeight: real("gross_weight"),
  netWeight: real("net_weight"),
  destinationCountry: text("destination_country"),
  boxSize: text("box_size"),
  createdAt: timestamp("created_at").notNull(),
});

export const shippingBoxItems = pgTable("shipping_box_items", {
  id: text("id").primaryKey(),
  shippingBoxId: text("shipping_box_id")
    .notNull()
    .references(() => shippingBoxes.id, { onDelete: "cascade" }),
  pickingItemId: text("picking_item_id").references(() => pickingItems.id),
  partId: text("part_id").notNull().references(() => parts.id),
  qty: integer("qty").notNull(),
});

// ------------------------------------------------------------------
// Shelf boxes (put-away / goods verify)
// ------------------------------------------------------------------

export const shelfBoxes = pgTable("shelf_boxes", {
  id: text("id").primaryKey(),                         // printed shelf-box label
  receivingOrderId: text("receiving_order_id").references(() => receivingOrders.id),
  shelfCode: text("shelf_code").references(() => shelves.code),
  status: text("status", { enum: boxStatus }).notNull().default("open"),
  createdAt: timestamp("created_at").notNull(),
});

export const shelfBoxItems = pgTable("shelf_box_items", {
  id: text("id").primaryKey(),
  shelfBoxId: text("shelf_box_id")
    .notNull()
    .references(() => shelfBoxes.id, { onDelete: "cascade" }),
  receivingInvoiceItemId: text("receiving_invoice_item_id")
    .references(() => receivingInvoiceItems.id),
  partId: text("part_id").notNull().references(() => parts.id),
  qty: integer("qty").notNull(),
  verified: boolean("verified").default(false),
  verifiedAt: timestamp("verified_at"),
});

// ------------------------------------------------------------------
// Transition logs
// ------------------------------------------------------------------

export const transitionLogs = pgTable("transition_logs", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),           // 'receiving_order' | 'picking_order' | 'shipping_box' | 'shelf_box' | 'measuring_task'
  entityId: text("entity_id").notNull(),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  actorId: text("actor_id").references(() => users.id),
  metadata: text("metadata"),                          // JSON blob for extra context
  createdAt: timestamp("created_at").notNull(),
});

// ------------------------------------------------------------------
// Relations (optional, but handy for Drizzle queries)
// ------------------------------------------------------------------

export const receivingOrdersRelations = relations(receivingOrders, ({ many, one }) => ({
  supplier: one(suppliers, { fields: [receivingOrders.supplierId], references: [suppliers.id] }),
  invoices: many(receivingInvoices),
  shelfBoxes: many(shelfBoxes),
}));

export const receivingInvoicesRelations = relations(receivingInvoices, ({ one, many }) => ({
  receivingOrder: one(receivingOrders, { fields: [receivingInvoices.receivingOrderId], references: [receivingOrders.id] }),
  items: many(receivingInvoiceItems),
}));

export const receivingInvoiceItemsRelations = relations(receivingInvoiceItems, ({ one, many }) => ({
  invoice: one(receivingInvoices, { fields: [receivingInvoiceItems.receivingInvoiceId], references: [receivingInvoices.id] }),
  part: one(parts, { fields: [receivingInvoiceItems.partId], references: [parts.id] }),
  inventoryLotSources: many(inventoryLotSources),
  shelfBoxItems: many(shelfBoxItems),
  allocations: many(allocations),
}));

export const pickingOrdersRelations = relations(pickingOrders, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [pickingOrders.supplierId], references: [suppliers.id] }),
  issueReportedByUser: one(users, { fields: [pickingOrders.issueReportedBy], references: [users.id] }),
  items: many(pickingItems),
  packages: many(pickingPackages),
  measuringTask: one(measuringTasks, { fields: [pickingOrders.id], references: [measuringTasks.pickingOrderId] }),
  shippingBoxes: many(shippingBoxes),
}));

export const pickingItemsRelations = relations(pickingItems, ({ one, many }) => ({
  pickingOrder: one(pickingOrders, { fields: [pickingItems.pickingOrderId], references: [pickingOrders.id] }),
  part: one(parts, { fields: [pickingItems.partId], references: [parts.id] }),
  allocations: many(allocations),
  packages: many(pickingPackages),
  shippingBoxItems: many(shippingBoxItems),
}));

export const pickingPackagesRelations = relations(pickingPackages, ({ one }) => ({
  pickingItem: one(pickingItems, { fields: [pickingPackages.pickingItemId], references: [pickingItems.id] }),
  pickingOrder: one(pickingOrders, { fields: [pickingPackages.pickingOrderId], references: [pickingOrders.id] }),
  shippingBox: one(shippingBoxes, { fields: [pickingPackages.shippingBoxId], references: [shippingBoxes.id] }),
}));

export const inventoryLotsRelations = relations(inventoryLots, ({ one, many }) => ({
  part: one(parts, { fields: [inventoryLots.partId], references: [parts.id] }),
  sources: many(inventoryLotSources),
  allocations: many(allocations),
}));

export const inventoryLotSourcesRelations = relations(inventoryLotSources, ({ one }) => ({
  inventoryLot: one(inventoryLots, { fields: [inventoryLotSources.inventoryLotId], references: [inventoryLots.id] }),
  receivingInvoiceItem: one(receivingInvoiceItems, { fields: [inventoryLotSources.receivingInvoiceItemId], references: [receivingInvoiceItems.id] }),
}));

export const allocationsRelations = relations(allocations, ({ one }) => ({
  pickingItem: one(pickingItems, { fields: [allocations.pickingItemId], references: [pickingItems.id] }),
  inventoryLot: one(inventoryLots, { fields: [allocations.inventoryLotId], references: [inventoryLots.id] }),
  receivingInvoiceItem: one(receivingInvoiceItems, { fields: [allocations.receivingInvoiceItemId], references: [receivingInvoiceItems.id] }),
}));

export const measuringTasksRelations = relations(measuringTasks, ({ one, many }) => ({
  pickingOrder: one(pickingOrders, { fields: [measuringTasks.pickingOrderId], references: [pickingOrders.id] }),
  shippingBoxes: many(shippingBoxes),
}));

export const shippingBoxesRelations = relations(shippingBoxes, ({ one, many }) => ({
  pickingOrder: one(pickingOrders, { fields: [shippingBoxes.pickingOrderId], references: [pickingOrders.id] }),
  measuringTask: one(measuringTasks, { fields: [shippingBoxes.measuringTaskId], references: [measuringTasks.id] }),
  items: many(shippingBoxItems),
  packages: many(pickingPackages),
}));

export const shippingBoxItemsRelations = relations(shippingBoxItems, ({ one }) => ({
  shippingBox: one(shippingBoxes, { fields: [shippingBoxItems.shippingBoxId], references: [shippingBoxes.id] }),
  pickingItem: one(pickingItems, { fields: [shippingBoxItems.pickingItemId], references: [pickingItems.id] }),
  part: one(parts, { fields: [shippingBoxItems.partId], references: [parts.id] }),
}));

export const shelfBoxesRelations = relations(shelfBoxes, ({ one, many }) => ({
  receivingOrder: one(receivingOrders, { fields: [shelfBoxes.receivingOrderId], references: [receivingOrders.id] }),
  shelf: one(shelves, { fields: [shelfBoxes.shelfCode], references: [shelves.code] }),
  items: many(shelfBoxItems),
}));

export const shelfBoxItemsRelations = relations(shelfBoxItems, ({ one }) => ({
  shelfBox: one(shelfBoxes, { fields: [shelfBoxItems.shelfBoxId], references: [shelfBoxes.id] }),
  receivingInvoiceItem: one(receivingInvoiceItems, { fields: [shelfBoxItems.receivingInvoiceItemId], references: [receivingInvoiceItems.id] }),
  part: one(parts, { fields: [shelfBoxItems.partId], references: [parts.id] }),
}));
