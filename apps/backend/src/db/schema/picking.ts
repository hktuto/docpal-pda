import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, bigint, boolean, real, timestamp, index, uniqueIndex, foreignKey, jsonb, check } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, subInventories } from "./master.js";
import { shelfBoxes } from "./inventory.js";

export const pickingOrders = pgTable(
  "picking_orders",
  {
    id: text("id").primaryKey(),
    orderNo: text("order_no").notNull(), // 订单/发票/TN 号 — 不唯一；上游 DB 复制同步/dedup key 是 caller-supplied id
    deliveryDate: timestamp("delivery_date", { mode: "date" }),
    poNo: text("po_no"),
    shipTo: text("ship_to"), // 收货方 / 出货目的描述（含目的国家，非结构化地址全文）
    customerCode: text("customer_code"), // 出货客户 — opaque upstream customer text (by convention a customer_accounts.party_name), no FK
    // 出货位置配对（nullable — allocation 只在订单带配对时按位置匹配）
    orgId: integer("org_id"), // 出货办公室, 2: HK
    subInventoryCode: text("sub_inventory_code"), // 从哪一个子库存出货
    prioritySeq: integer("priority_seq").notNull().default(0), // allocation/list order — lower first, admin-reorderable
    commodityInspection: text('commodity_inspection'),
    pickingOrderType: varchar("picking_order_type", { length: 64 }),
    remark: text("remark"),
    // Page-driven work lock: a PDA with this order open keeps its allocations
    // from being wiped by allocateAll. Expires 10 min after working_at.
    workingBy: text("working_by").references(() => users.id),
    workingAt: timestamp("working_at", { mode: "date" }),
    // Optional assignee (username, no FK — survives DocPal re-provisioning):
    // NULL = visible to everyone; set = only that user sees it on PDA.
    assignee: text("assignee"),
    issueReason: text("issue_reason"),
    issueQty: integer("issue_qty"),
    issuePackSize: integer("issue_pack_size"),
    issueNote: text("issue_note"),
    issueRemark: text("issue_remark"),
    issueReportedAt: timestamp("issue_reported_at", { mode: "date" }),
    issueReportedBy: text("issue_reported_by").references(() => users.id),
    status: text("status").notNull().default("pending"), // pending | allocated | skip | picking | issue | picking_finished | measuring_finished | shipped
    // Allocation coverage of the order's open items, maintained by allocateAll:
    // unallocated | partial | allocated (Σ allocated_qty vs Σ open qty).
    allocationStatus: text("allocation_status").notNull().default("unallocated"),
    shippedAt: timestamp("shipped_at", { mode: "date" }),
    shippedBy: text("shipped_by").references(() => users.id),
    // Labeling stage (待贴标签, spec 2026-10-28-picking-labeling-step-design.md):
    // set at picking finish when the labeling step is on and the order matches
    // a label print rule; cleared by labeling finish / admin status override.
    labelingPending: boolean("labeling_pending").notNull().default(false),
    labelingDoneAt: timestamp("labeling_done_at", { mode: "date" }),
    labelingDoneBy: text("labeling_done_by"),
    // Label printing stage (打印标签, spec 2026-11-02-label-printing-step-design.md):
    // set at picking finish when the label-printing step is on and the order
    // matches an internal label print rule; cleared by label-printing finish /
    // admin status override. Runs before the labeling stage.
    labelPrintingPending: boolean("label_printing_pending").notNull().default(false),
    labelPrintingDoneAt: timestamp("label_printing_done_at", { mode: "date" }),
    labelPrintingDoneBy: text("label_printing_done_by"),
    // Packaging stage (打包, spec 2026-11-10-packaging-shipping-steps-design.md):
    // confirmed per order once every box holding its packages is closed (+ its
    // verify task completed when the verify step is on). packaged_at IS the
    // packaged truth (status stays 'measuring_finished' until shipped);
    // packed_box_count is recomputed server-side at confirm; packed_pallet_count
    // non-NULL = pallet mode (boxes still counted). Weights in kg, ≤3 dp like
    // shipping_boxes.gross_weight. No status-column changes.
    packagedAt: timestamp("packaged_at", { mode: "date" }),
    packagedBy: text("packaged_by").references(() => users.id),
    packedWeight: real("packed_weight"),
    packedBoxCount: integer("packed_box_count"),
    packedPalletCount: integer("packed_pallet_count"),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    statusIdx: index("idx_picking_orders_status").on(t.status),
    subInvFk: foreignKey({ name: "picking_orders_sub_inv_fk", columns: [t.orgId, t.subInventoryCode], foreignColumns: [subInventories.orgId, subInventories.secondaryInventoryName] }),
  })
);

// Per-step assignee side table for the labeling / label-printing / packaging
// queues (CR-048, plan 2026-11-06-uat-open-items.md; packaging per spec
// 2026-11-10-packaging-shipping-steps-design.md): picking_orders is upstream-
// synced, so these queue steps can't get a column — their assignee lives
// here, keyed by (order, step). Absent row = unassigned = visible to everyone
// (same convention as the queue assignees). The picking step keeps using
// picking_orders.assignee.
export const pickingTasks = pgTable(
  "picking_tasks",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    step: text("step").notNull(), // labeling | label-printing | packaging
    assignee: text("assignee"), // optional assignee username, no FK — NULL = visible to everyone
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    orderStepUq: uniqueIndex("idx_picking_tasks_order_step").on(t.pickingOrderId, t.step),
    stepCheck: check("chk_picking_tasks_step", sql`step IN ('labeling', 'label-printing', 'packaging')`),
  })
);

export const pickingItems = pgTable(
  "picking_items",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    partNo: text("part_no").notNull(), // plain text (no FK — parts.part_no is not unique)
    qty: integer("qty").notNull(), // 需求数量（要出货）
    pickedQty: integer("picked_qty").notNull().default(0), // 已扫描装数量
    allocatedQty: integer("allocated_qty").notNull().default(0), // 已预留 Reserved
    // 上游 Oracle 订单行标识（ingest 透传，可空 — 上游缺失时以 part_no reconcile）
    lineId: bigint("line_id", { mode: "number" }),
    lineNumber: integer("line_number"),
    shipmentNumber: integer("shipment_number"),
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
    assignee: text("assignee"), // optional assignee username — NULL = visible to everyone
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
    // Carton label verification (2026-10-30 label-aware verify): stamped when
    // the printed carton label is scanned (box entry or verify scan).
    cartonLabelVerified: boolean("carton_label_verified").notNull().default(false),
    cartonLabelVerifiedAt: timestamp("carton_label_verified_at", { mode: "date" }),
    cartonLabelVerifiedBy: text("carton_label_verified_by"),
    // Measuring queue assignee (username, no FK) — NULL = visible to everyone.
    assignee: text("assignee"),
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
    // Raw scan string of the physical label this package (portion) came from;
    // NULL for legacy rows and camera/OCR scans — those keep qty matching.
    labelBarcode: text("label_barcode"),
    // Scanned part identity (2026-10-05 measuring scan-truth): the label's
    // itemId / wclItemNo groups as scanned, verbatim. NULL for legacy rows and
    // paths without a parsed label — consumers fall back to the picking item's
    // part (measuring/verify detail + aggregate matcher).
    scannedPartNo: text("scanned_part_no"),
    scannedWclItemNo: text("scanned_wcl_item_no"),
    // Pick-time scanned batch fields (2026-10-14): the label's parsed
    // lot/coo/cow as scanned, verbatim, and the date code canonicalized to
    // YYWW (it arrives in the label format and is converted at this in
    // boundary, spec 2026-10-22). Verify/measuring re-scans compare against
    // THESE (falling back to the source snapshot for legacy NULL rows) so
    // matching is anchored to the physical label, not upstream stock data.
    scannedDateCode: text("scanned_date_code"),
    scannedLotCode: text("scanned_lot_code"),
    scannedCoo: text("scanned_coo"),
    scannedCow: text("scanned_cow"),
    verified: boolean("verified").notNull().default(false),
    verifyVerified: boolean("verify_verified").notNull().default(false), // verify-step re-scan flag
    // Aggregate re-scan truth (2026-10-03): credited qty from verify scans —
    // completion when rescanned_qty >= qty; mode-agnostic (both flags ride along).
    rescannedQty: integer("rescanned_qty").notNull().default(0),
    // Item/item-box label verification (2026-10-30 label-aware verify):
    // stamped when the package's printed label is scanned.
    labelVerified: boolean("label_verified").notNull().default(false),
    labelVerifiedAt: timestamp("label_verified_at", { mode: "date" }),
    labelVerifiedBy: text("label_verified_by"),
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
    partNo: text("part_no").notNull(), // plain text (no FK — parts.part_no is not unique)
    qty: integer("qty").notNull(),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    boxIdx: index("idx_shipping_box_items_box").on(t.shippingBoxId),
  })
);
