import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, index, check } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { pickingItems } from "./picking.js";
import { inventoryLots } from "./inventory.js";
import { receivingInvoiceItems, receivingOrders } from "./receiving.js";

export const allocations = pgTable(
  "allocations",
  {
    id: text("id").primaryKey(),
    pickingItemId: text("picking_item_id").notNull().references(() => pickingItems.id, { onDelete: "cascade" }),
    inventoryLotId: text("inventory_lot_id").references(() => inventoryLots.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
    receivingOrderId: text("receiving_order_id").references(() => receivingOrders.id, { onDelete: "cascade" }), // 整单分配（行无 box_id 时）
    qty: integer("qty").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().$defaultFn(now),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().$defaultFn(now),
  },
  (t) => ({
    sourceCheck: check(
      "chk_allocations_source",
      sql`inventory_lot_id IS NOT NULL OR receiving_invoice_item_id IS NOT NULL OR receiving_order_id IS NOT NULL`
    ),
    itemIdx: index("idx_allocations_picking_item").on(t.pickingItemId),
    lotIdx: index("idx_allocations_lot").on(t.inventoryLotId),
    receivingItemIdx: index("idx_allocations_receiving_item").on(t.receivingInvoiceItemId),
    receivingOrderIdx: index("idx_allocations_receiving_order").on(t.receivingOrderId),
  })
);
