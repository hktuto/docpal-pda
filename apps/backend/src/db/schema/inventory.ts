import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, timestamp, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { defaultWarehouse } from "../../config.js";
import { parts, shelves, subInventories, users, warehouseSections } from "./master.js";
import { receivingInvoiceItems, receivingOrders } from "./receiving.js";

export const inventoryLots = pgTable(
  "inventory_lots",
  {
    id: text("id").primaryKey(),
    partId: text("part_id").notNull().references(() => parts.id),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    shelfCode: text("shelf_code").references(() => shelves.code), // 配合 shelves.location_type 区分 dock/shelf
    boxId: text("box_id"),
    warehouseCode: text("warehouse_code").notNull().default("HK1").$defaultFn(defaultWarehouse), // 批次所属仓库（实例默认 WAREHOUSE_CODE）
    warehouseSectionCode: text("warehouse_section_code").references(() => warehouseSections.code), // 批次所属仓库分区
    subInventoryCode: text("sub_inventory_code").references(() => subInventories.code), // 批次所属子库存
    supplierInvoiceNo: text("supplier_invoice_no"), // 供应商发票号，用于追溯和唯一
    expectedQty: integer("expected_qty").notNull().default(0), // 收货时 Expected 数量
    // if location_type = 'dock', 值为 expected_qty；如果是 SHELF (expected_qty=0)，这个就是货架存量
    totalQty: integer("total_qty").notNull().default(0),
    allocatedQty: integer("allocated_qty").notNull().default(0), // 已预留数量
    availableQty: integer("available_qty").generatedAlwaysAs(sql`total_qty - allocated_qty`),
  },
  (t) => ({
    // GIT/DOCK 也使用虚拟 shelf_code，避免 NULL 导致重复 lot
    uniqueLot: uniqueIndex("inventory_lots_unique_lot")
      .on(t.partId, t.dateCode, t.coo, t.cow, t.shelfCode, t.boxId, t.warehouseSectionCode, t.subInventoryCode, t.warehouseCode)
      .where(sql`shelf_code IS NOT NULL OR box_id IS NOT NULL`),
    partIdx: index("idx_inventory_lots_part").on(t.partId),
    availIdx: index("idx_inventory_lots_available").on(t.partId, t.availableQty),
    locationIdx: index("idx_inventory_lots_location").on(t.shelfCode, t.boxId),
  })
);

export const inventoryLotSources = pgTable(
  "inventory_lot_sources",
  {
    id: text("id").primaryKey(),
    inventoryLotId: text("inventory_lot_id").notNull().references(() => inventoryLots.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull(),
  },
  (t) => ({
    lotItemUq: uniqueIndex("inventory_lot_sources_unique").on(t.inventoryLotId, t.receivingInvoiceItemId),
    itemIdx: index("idx_inventory_lot_sources_receiving_item").on(t.receivingInvoiceItemId),
    lotIdx: index("idx_inventory_lot_sources_lot").on(t.inventoryLotId),
  })
);

export const shelfBoxes = pgTable(
  "shelf_boxes",
  {
    id: text("id").primaryKey(),
    receivingOrderId: text("receiving_order_id").references(() => receivingOrders.id),
    shelfCode: text("shelf_code").references(() => shelves.code),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("idx_shelf_boxes_order").on(t.receivingOrderId),
    shelfIdx: index("idx_shelf_boxes_shelf").on(t.shelfCode),
  })
);

export const shelfBoxItems = pgTable(
  "shelf_box_items",
  {
    id: text("id").primaryKey(),
    shelfBoxId: text("shelf_box_id").notNull().references(() => shelfBoxes.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").references(() => receivingInvoiceItems.id),
    partId: text("part_id").notNull().references(() => parts.id),
    qty: integer("qty").notNull(),
    verified: boolean("verified").default(false),
    verifiedAt: timestamp("verified_at", { mode: "date" }),
  },
  (t) => ({
    boxIdx: index("idx_shelf_box_items_box").on(t.shelfBoxId),
  })
);

// Daily goods-verify tasks (concept 7): generated at day end from
// inventory_transactions — one task per inventory lot with movement that day.
// Put-away/verify is box-based (printed box label), so the task carries box_id.
export const goodsVerifyTasks = pgTable(
  "goods_verify_tasks",
  {
    id: text("id").primaryKey(),
    taskDate: date("task_date", { mode: "date" }).notNull(), // the day being counted
    inventoryLotId: text("inventory_lot_id").notNull().references(() => inventoryLots.id),
    shelfCode: text("shelf_code").references(() => shelves.code),
    boxId: text("box_id"), // box-based verify (put-away is per box)
    partId: text("part_id").notNull().references(() => parts.id),
    expectedQty: integer("expected_qty").notNull(), // stock snapshot at generation time
    status: text("status").notNull().default("pending"), // pending | verified | skipped
    verifiedBy: text("verified_by").references(() => users.id),
    verifiedAt: timestamp("verified_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    lotDayUq: uniqueIndex("goods_verify_tasks_lot_day_unique").on(t.taskDate, t.inventoryLotId),
    shelfDayIdx: index("idx_goods_verify_tasks_shelf").on(t.shelfCode, t.taskDate),
    statusIdx: index("idx_goods_verify_tasks_status").on(t.status),
  })
);
