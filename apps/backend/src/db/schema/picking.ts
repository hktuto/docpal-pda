import { pgTable, text, integer, bigint, boolean, real, timestamp, index, uniqueIndex, foreignKey, jsonb } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, parts, customerProfiles, subInventories } from "./master.js";
import { shelfBoxes } from "./inventory.js";

export const pickingOrders = pgTable(
  "picking_orders",
  {
    id: text("id").primaryKey(),
    orderNo: text("order_no").notNull().unique(), // 订单/发票/TN 号 — 上游 DB 复制同步/dedup key
    deliveryDate: timestamp("delivery_date", { mode: "date" }),
    poNo: text("po_no"),
    shipTo: text("ship_to"), // 收货方 / 出货目的描述（含目的国家，非结构化地址全文）
    customerCode: text("customer_code").references(() => customerProfiles.code), // 出货客户
    // 出货位置配对（nullable — allocation 只在订单带配对时按位置匹配）
    orgId: integer("org_id"), // 出货办公室, 2: HK
    subInventoryCode: text("sub_inventory_code"), // 从哪一个子库存出货
    prioritySeq: integer("priority_seq").notNull().default(0), // allocation/list order — lower first, admin-reorderable
    commodityInspection: text('commodity_inspection'),
    // Page-driven work lock: a PDA with this order open keeps its allocations
    // from being wiped by allocateAll. Expires 10 min after working_at.
    workingBy: text("working_by").references(() => users.id),
    workingAt: timestamp("working_at", { mode: "date" }),
    issueReason: text("issue_reason"),
    issueQty: integer("issue_qty"),
    issuePackSize: integer("issue_pack_size"),
    issueNote: text("issue_note"),
    issueRemark: text("issue_remark"),
    issueReportedAt: timestamp("issue_reported_at", { mode: "date" }),
    issueReportedBy: text("issue_reported_by").references(() => users.id),
    status: text("status").notNull().default("pending"), // pending | picking | issue | finished | shipped
    // Allocation coverage of the order's open items, maintained by allocateAll:
    // unallocated | partial | allocated (Σ allocated_qty vs Σ open qty).
    allocationStatus: text("allocation_status").notNull().default("unallocated"),
    shippedAt: timestamp("shipped_at", { mode: "date" }),
    shippedBy: text("shipped_by").references(() => users.id),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    statusIdx: index("idx_picking_orders_status").on(t.status),
    subInvFk: foreignKey({ name: "picking_orders_sub_inv_fk", columns: [t.orgId, t.subInventoryCode], foreignColumns: [subInventories.orgId, subInventories.code] }),
  })
);

export const pickingItems = pgTable(
  "picking_items",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    partNo: text("part_no").notNull().references(() => parts.partNo),
    qty: integer("qty").notNull(), // 需求数量（要出货）
    pickedQty: integer("picked_qty").notNull().default(0), // 已扫描装数量
    allocatedQty: integer("allocated_qty").notNull().default(0), // 已预留 Reserved
    // 上游 Oracle 订单行标识（ingest 透传；reconcile 仍以 part_no 为 key）
    lineId: bigint("line_id", { mode: "number" }).notNull(),
    lineNumber: integer("line_number").notNull(),
    shipmentNumber: integer("shipment_number").notNull(),
    status: text("status").notNull().default("pending"), // pending | picked — backend-maintained from picked_qty vs qty
    additionalData: jsonb("additional_data"), // 上游额外字段透传（无固定结构）
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("idx_picking_items_order").on(t.pickingOrderId),
    partIdx: index("idx_picking_items_part").on(t.partNo),
  })
);

// Verify tasks bind to the shipping box (2026-08-11 box-scoped design): one
// pending task per closed box, created by closeShippingBox when the verify
// step is enabled. measuring_tasks is gone — closing a box IS the measuring
// completion.
export const verifyTasks = pgTable(
  "verify_tasks",
  {
    id: text("id").primaryKey(),
    shippingBoxId: text("shipping_box_id").notNull().references(() => shippingBoxes.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // pending | completed
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    shippingBoxUq: uniqueIndex("idx_verify_tasks_shipping_box").on(t.shippingBoxId),
  })
);

export const shippingBoxes = pgTable(
  "shipping_boxes",
  {
    id: text("id").primaryKey(), // server-generated BOX-S-<YYYYMMDD>-<seq>
    // Informational "created for" order only — a box may hold packages from
    // any open picking order (cross-order packing).
    pickingOrderId: text("picking_order_id").references(() => pickingOrders.id),
    status: text("status").notNull().default("open"), // open | closed
    grossWeight: real("gross_weight"),
    netWeight: real("net_weight"),
    destinationCountry: text("destination_country"),
    boxSize: text("box_size"),
    // Per-box shipping: stamped by shipShippingBox (admin).
    shippedAt: timestamp("shipped_at", { mode: "date" }),
    shippedBy: text("shipped_by").references(() => users.id),
    // Whole-box claim: the reused shelf carton this box was created from.
    sourceShelfBoxId: text("source_shelf_box_id").references(() => shelfBoxes.id),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("idx_shipping_boxes_order").on(t.pickingOrderId),
  })
);

export const pickingPackages = pgTable(
  "picking_packages",
  {
    id: text("id").primaryKey(),
    pickingItemId: text("picking_item_id").notNull().references(() => pickingItems.id, { onDelete: "cascade" }),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(), // receiving_invoice_item | inventory_lot
    sourceId: text("source_id").notNull(),
    qty: integer("qty").notNull(),
    shippingBoxId: text("shipping_box_id").references(() => shippingBoxes.id),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    verified: boolean("verified").notNull().default(false),
    verifyVerified: boolean("verify_verified").notNull().default(false), // verify-step re-scan flag
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    itemIdx: index("idx_picking_packages_item").on(t.pickingItemId),
    orderIdx: index("idx_picking_packages_order").on(t.pickingOrderId),
    boxIdx: index("idx_picking_packages_box").on(t.shippingBoxId),
  })
);

// 保留兼容，装箱真相以 picking_packages 为准
export const shippingBoxItems = pgTable(
  "shipping_box_items",
  {
    id: text("id").primaryKey(),
    shippingBoxId: text("shipping_box_id").notNull().references(() => shippingBoxes.id, { onDelete: "cascade" }),
    pickingItemId: text("picking_item_id").references(() => pickingItems.id),
    partNo: text("part_no").notNull().references(() => parts.partNo),
    qty: integer("qty").notNull(),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    boxIdx: index("idx_shipping_box_items_box").on(t.shippingBoxId),
  })
);
