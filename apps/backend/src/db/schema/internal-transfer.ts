import { sql } from "drizzle-orm";
import { pgTable, text, integer, bigint, boolean, timestamp, index, foreignKey, check, jsonb } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, subInventories, shelves } from "./master.js";
import { pickingOrders } from "./picking.js";
import { inventoryLots } from "./inventory.js";
import { receivingInvoiceItems, receivingOrders } from "./receiving.js";

// Internal transfer orders (spec 2026-09-28-internal-transfer-order-design.md):
// stock moves WITHIN this warehouse — from one (org_id, sub_inventory_code)
// partition to another, usually physically shelf → shelf, re-stamping the
// lot's org/sub-inventory. They never ship (no delivery). Distinct from the
// existing "transfer picking" (picking_items.additional_data.from_subinventory
// + pickingFromSubinventoryOrgs), which ships another warehouse's stock out.
export const internalTransferOrders = pgTable(
  "internal_transfer_orders",
  {
    id: text("id").primaryKey(),
    orderNo: text("order_no").notNull(), // 上游单号 — 不唯一；sync/dedup key 是 caller-supplied id
    // 源库存位置配对（nullable — allocation 只在订单带配对时按位置匹配）
    fromOrgId: integer("from_org_id"), // 移出办公室, 2: HK
    fromSubInventoryCode: text("from_sub_inventory_code"), // 从哪一个子库存移出
    // 目标库存位置配对 — 指派 delegated picking order 时默认取该订单的配对
    toOrgId: integer("to_org_id"), // 移入办公室
    toSubInventoryCode: text("to_sub_inventory_code"), // 移入哪一个子库存
    // Delegated picking order: the ship-out order this transfer gathers stock
    // for. After transfer picking, stock moves to the to_ pair and the next
    // allocateAll allocates it to this picking order there.
    pickingOrderId: text("picking_order_id").references(() => pickingOrders.id, { onDelete: "set null" }),
    prioritySeq: integer("priority_seq").notNull().default(0), // allocation/list order shared with picking — lower first
    // Page-driven work lock: a PDA with this order open keeps its allocations
    // from being wiped by allocateAll. Expires 10 min after working_at.
    workingBy: text("working_by").references(() => users.id),
    workingAt: timestamp("working_at", { mode: "date" }),
    issueReason: text("issue_reason"),
    issueQty: integer("issue_qty"),
    issueNote: text("issue_note"),
    issueRemark: text("issue_remark"),
    issueReportedAt: timestamp("issue_reported_at", { mode: "date" }),
    issueReportedBy: text("issue_reported_by").references(() => users.id),
    status: text("status").notNull().default("pending"), // pending | allocated | picking | issue | finished — picking model minus skip/shipped (never ships)
    // Allocation coverage of the order's open items, maintained by allocateAll:
    // unallocated | partial | allocated (Σ allocated_qty vs Σ open qty).
    allocationStatus: text("allocation_status").notNull().default("unallocated"),
    remark: text("remark"),
    additionalData: jsonb("additional_data"), // 上游额外字段透传（无固定结构）
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    statusIdx: index("idx_internal_transfer_orders_status").on(t.status),
    pickingOrderIdx: index("idx_internal_transfer_orders_picking_order").on(t.pickingOrderId),
    fromSubInvFk: foreignKey({ name: "internal_transfer_orders_from_sub_inv_fk", columns: [t.fromOrgId, t.fromSubInventoryCode], foreignColumns: [subInventories.orgId, subInventories.secondaryInventoryName] }),
    toSubInvFk: foreignKey({ name: "internal_transfer_orders_to_sub_inv_fk", columns: [t.toOrgId, t.toSubInventoryCode], foreignColumns: [subInventories.orgId, subInventories.secondaryInventoryName] }),
  })
);

export const internalTransferItems = pgTable(
  "internal_transfer_items",
  {
    id: text("id").primaryKey(),
    transferOrderId: text("transfer_order_id").notNull().references(() => internalTransferOrders.id, { onDelete: "cascade" }),
    partNo: text("part_no").notNull(), // plain text (no FK — parts.part_no is not unique)
    wclItemNo: text("wcl_item_no"), // business-key copy (parts.wcl_item_no)
    qty: integer("qty").notNull(), // 需求数量（要移动）
    pickedQty: integer("picked_qty").notNull().default(0), // 已扫描数量
    allocatedQty: integer("allocated_qty").notNull().default(0), // 已预留 Reserved
    // 上游订单行标识（sync 透传，可空 — 上游缺失时以 part_no reconcile）
    lineId: bigint("line_id", { mode: "number" }),
    lineNumber: integer("line_number"),
    status: text("status").notNull().default("pending"), // pending | picked — backend-maintained from picked_qty vs qty
    additionalData: jsonb("additional_data"), // 上游额外字段透传（无固定结构）
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("idx_internal_transfer_items_order").on(t.transferOrderId),
    partIdx: index("idx_internal_transfer_items_part").on(t.partNo),
  })
);

// Mirror of `allocations` for transfer demands — same three-source shape so
// the engine reuses its source-loading logic; sources are restricted to the
// order's from_ pair by the engine (spec §schema).
export const internalTransferAllocations = pgTable(
  "internal_transfer_allocations",
  {
    id: text("id").primaryKey(),
    transferItemId: text("transfer_item_id").notNull().references(() => internalTransferItems.id, { onDelete: "cascade" }),
    inventoryLotId: text("inventory_lot_id").references(() => inventoryLots.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
    receivingOrderId: text("receiving_order_id").references(() => receivingOrders.id, { onDelete: "cascade" }), // 整单分配（行无 box_id 时）
    qty: integer("qty").notNull(),
    // Pinned hand-made allocation (admin console): wipe/rebuild never removes
    // it and subtracts its qty from the item's auto-allocation demand.
    manual: boolean("manual").notNull().default(false),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    sourceCheck: check(
      "chk_internal_transfer_allocations_source",
      sql`inventory_lot_id IS NOT NULL OR receiving_invoice_item_id IS NOT NULL OR receiving_order_id IS NOT NULL`
    ),
    itemIdx: index("idx_internal_transfer_allocations_item").on(t.transferItemId),
    lotIdx: index("idx_internal_transfer_allocations_lot").on(t.inventoryLotId),
    receivingItemIdx: index("idx_internal_transfer_allocations_receiving_item").on(t.receivingInvoiceItemId),
    receivingOrderIdx: index("idx_internal_transfer_allocations_receiving_order").on(t.receivingOrderId),
  })
);

// Physical pick records for transfer orders — mirror of picking_packages
// minus shipping. shelf_code is the destination shelf, stamped at put-away.
export const internalTransferPackages = pgTable(
  "internal_transfer_packages",
  {
    id: text("id").primaryKey(),
    transferItemId: text("transfer_item_id").notNull().references(() => internalTransferItems.id, { onDelete: "cascade" }),
    transferOrderId: text("transfer_order_id").notNull().references(() => internalTransferOrders.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(), // receiving_invoice_item | inventory_lot
    sourceId: text("source_id").notNull(),
    qty: integer("qty").notNull(),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    shelfCode: text("shelf_code").references(() => shelves.code), // destination shelf — stamped at put-away
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    itemIdx: index("idx_internal_transfer_packages_item").on(t.transferItemId),
    orderIdx: index("idx_internal_transfer_packages_order").on(t.transferOrderId),
  })
);
