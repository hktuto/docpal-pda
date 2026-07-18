import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, parts, shelves } from "./master.js";
import { inventoryLots } from "./inventory.js";
import { receivingInvoiceItems } from "./receiving.js";

// 单据/任务状态审计（统一命名 transaction_logs，不用 transition_logs）
export const transactionLogs = pgTable(
  "transaction_logs",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(), // 实体类型：receiving_order / picking_order / shelf_box 等
    entityId: text("entity_id").notNull(), // 实体主键 ID
    fromState: text("from_state"), // 变更前状态（可为空，表示新建）
    toState: text("to_state").notNull(), // 变更后状态
    actorId: text("actor_id").references(() => users.id), // 操作人
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`), // 扩展审计信息（JSON）
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now), // 状态变更时间
  },
  (t) => ({
    entityIdx: index("idx_transaction_logs_entity").on(t.entityType, t.entityId),
    createdAtIdx: index("idx_transaction_logs_created_at").on(t.createdAt),
  })
);

// 库存出入流水：支撑「昨天有出入纪录仓位」/ 每日盘点
// 简化规则：一行只记「某一类库存」的一次数量变化；多类同时变则写多行
export const inventoryTransactions = pgTable(
  "inventory_transactions",
  {
    id: text("id").primaryKey(),
    inventoryLotId: text("inventory_lot_id").references(() => inventoryLots.id), // 关联库存批次（可空）
    partId: text("part_id").notNull().references(() => parts.id),
    shelfCode: text("shelf_code").references(() => shelves.code), // 发生出入的仓位（盘点筛选用）
    boxId: text("box_id"), // 箱号（可空）
    txnType: text("txn_type").notNull(), // 业务动作：EXPECTED_CREATE / RECEIVE_TO_DOCK / PUT_AWAY / RESERVE / PICK / SHIP_CONFIRM / ADJUST
    qtyType: text("qty_type").notNull(), // 影响的库存类型：expected | dock | on_hand | reserved
    qtyDelta: integer("qty_delta").notNull(), // 数量变化（正=增加，负=减少）
    dateCode: text("date_code"), // 批次快照（可空）
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    referenceType: text("reference_type"), // 来源单据类型
    referenceId: text("reference_id"), // 来源单据 ID
    receivingInvoiceItemId: text("receiving_invoice_item_id").references(() => receivingInvoiceItems.id),
    actorId: text("actor_id").references(() => users.id),
    txnReason: text("txn_reason"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`), // 可选：变动前/后数量等扩展信息
    txnAt: timestamp("txn_at", { mode: "date" }).notNull(), // 业务发生时间
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    qtyTypeCheck: check("chk_inventory_transactions_qty_type", sql`qty_type IN ('expected', 'dock', 'on_hand', 'reserved')`),
    shelfTimeIdx: index("idx_inventory_transactions_shelf_time").on(t.shelfCode, t.txnAt),
    lotTimeIdx: index("idx_inventory_transactions_lot_time").on(t.inventoryLotId, t.txnAt),
    partTimeIdx: index("idx_inventory_transactions_part_time").on(t.partId, t.txnAt),
    txnTypeIdx: index("idx_inventory_transactions_txn_type").on(t.txnType),
    referenceIdx: index("idx_inventory_transactions_reference").on(t.referenceType, t.referenceId),
    receivingItemIdx: index("idx_inventory_transactions_receiving_item").on(t.receivingInvoiceItemId),
  })
);
