import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, timestamp, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { parts, shelves, subInventories, users } from "./master.js";
import { receivingInvoiceItems } from "./receiving.js";

export const inventoryLots = pgTable(
  "inventory_lots",
  {
    id: text("id").primaryKey(),
    partNo: text("part_no").notNull().references(() => parts.partNo),
    wclItemNo: text("wcl_item_no"),
    dateCode: text("date_code"),
    lotCode: text("lot_code"), // lot_no
    coo: text("coo"),
    cow: text("cow"),
    shelfCode: text("shelf_code").references(() => shelves.code),
    boxId: text("box_id"),
    // 库存位置配对（put-away 时从 shelf 盖章）— 与 org_id 一起识别库存分区
    orgId: integer("org_id"), // 批次所属办公室, 2: HK
    subInventoryCode: text("sub_inventory_code").references(() => subInventories.code), // 批次所属子库存
    // 如果 location 是 DOCK（虚拟 shelf_code），totalQty 值为 expected_qty；SHELF 则为货架存量
    totalQty: integer("total_qty").notNull().default(0),
    allocatedQty: integer("allocated_qty").notNull().default(0), // 已预留数量
    availableQty: integer("available_qty").generatedAlwaysAs(sql`total_qty - allocated_qty`),
  },
  (t) => ({
    // GIT/DOCK 也使用虚拟 shelf_code，避免 NULL 导致重复 lot
    uniqueLot: uniqueIndex("inventory_lots_unique_lot")
      .on(t.partNo, t.dateCode, t.coo, t.cow, t.shelfCode, t.boxId, t.orgId, t.subInventoryCode)
      .where(sql`shelf_code IS NOT NULL OR box_id IS NOT NULL`),
    partIdx: index("idx_inventory_lots_part").on(t.partNo),
    availIdx: index("idx_inventory_lots_available").on(t.partNo, t.availableQty),
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
    id: text("id").primaryKey(), // server-generated BOX-H-<YYYYMMDD>-<seq>
    shelfCode: text("shelf_code").references(() => shelves.code),
    status: text("status").notNull().default("open"), // open | closed | verified
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    shelfIdx: index("idx_shelf_boxes_shelf").on(t.shelfCode),
  })
);

export const shelfBoxItems = pgTable(
  "shelf_box_items",
  {
    id: text("id").primaryKey(),
    shelfBoxId: text("shelf_box_id").notNull().references(() => shelfBoxes.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").references(() => receivingInvoiceItems.id),
    partNo: text("part_no").notNull().references(() => parts.partNo),
    wclItemNo: text("wcl_item_no"),
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
    partNo: text("part_no").notNull().references(() => parts.partNo),
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
