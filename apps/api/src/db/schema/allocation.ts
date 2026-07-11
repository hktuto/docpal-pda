import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, check, unique } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";
import { pickingItems } from "./picking.js";
import { inventoryLots } from "./inventory.js";
import { receivingOrders, receivingInvoiceItems } from "./receiving.js";

export const allocations = sqliteTable(
  "allocations",
  {
    id: text("id").primaryKey(),
    pickingItemId: text("picking_item_id").notNull().references(() => pickingItems.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull().default(0),
    remark: text("remark"),
    inventoryLotId: text("inventory_lot_id").references(() => inventoryLots.id),
    receivingOrderId: text("receiving_order_id").references(() => receivingOrders.id),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    targetXor: check("allocations_target_xor", sql`(inventory_lot_id IS NOT NULL) != (receiving_order_id IS NOT NULL)`),
    itemIdx: index("allocations_item_idx").on(t.pickingItemId),
    lotIdx: index("allocations_lot_idx").on(t.inventoryLotId),
    receivingOrderIdx: index("allocations_receiving_order_idx").on(t.receivingOrderId),
  })
);

export const allocationReceivingItems = sqliteTable(
  "allocation_receiving_items",
  {
    id: text("id").primaryKey(),
    allocationId: text("allocation_id").notNull().references(() => allocations.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id),
    qty: integer("qty").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    allocItemUq: unique("ari_allocation_item_uq").on(t.allocationId, t.receivingInvoiceItemId),
    itemIdx: index("ari_item_idx").on(t.receivingInvoiceItemId),
    allocationIdx: index("ari_allocation_idx").on(t.allocationId),
  })
);
