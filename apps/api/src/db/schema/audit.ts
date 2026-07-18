import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, parts, shelves } from "./master.js";
import { inventoryLots } from "./inventory.js";
import { receivingInvoiceItems } from "./receiving.js";

// Unified state-change audit for documents/tasks (replaces transition_logs).
export const transactionLogs = pgTable(
  "transaction_logs",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(), // receiving_order / picking_order / shelf_box ...
    entityId: text("entity_id").notNull(),
    fromState: text("from_state"), // null = newly created
    toState: text("to_state").notNull(),
    actorId: text("actor_id").references(() => users.id),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    entityIdx: index("idx_transaction_logs_entity").on(t.entityType, t.entityId),
    createdAtIdx: index("idx_transaction_logs_created_at").on(t.createdAt),
  })
);

// Inventory movement ledger: one row = one qty change of one qty class.
export const inventoryTransactions = pgTable(
  "inventory_transactions",
  {
    id: text("id").primaryKey(),
    inventoryLotId: text("inventory_lot_id").references(() => inventoryLots.id),
    partId: text("part_id").notNull().references(() => parts.id),
    shelfCode: text("shelf_code").references(() => shelves.code),
    boxId: text("box_id"),
    txnType: text("txn_type").notNull(), // EXPECTED_CREATE / RECEIVE_TO_DOCK / PUT_AWAY / RESERVE / PICK / SHIP_CONFIRM / ADJUST
    qtyType: text("qty_type").notNull(), // expected | dock | on_hand | reserved
    qtyDelta: integer("qty_delta").notNull(),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    receivingInvoiceItemId: text("receiving_invoice_item_id").references(() => receivingInvoiceItems.id),
    actorId: text("actor_id").references(() => users.id),
    txnReason: text("txn_reason"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    txnAt: timestamp("txn_at", { mode: "date" }).notNull(),
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
