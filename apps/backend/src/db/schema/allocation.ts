import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, timestamp, index, check } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { pickingItems } from "./picking.js";
import { inventoryLots } from "./inventory.js";
import { receivingInvoiceItems, receivingOrders } from "./receiving.js";
import { internalTransferItems } from "./internal-transfer.js";

export const allocations = pgTable(
  "allocations",
  {
    id: text("id").primaryKey(),
    pickingItemId: text("picking_item_id").notNull().references(() => pickingItems.id, { onDelete: "cascade" }),
    inventoryLotId: text("inventory_lot_id").references(() => inventoryLots.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
    receivingOrderId: text("receiving_order_id").references(() => receivingOrders.id, { onDelete: "cascade" }), // 整单分配（行无 box_id 时）
    // Transfer-item supply promise (spec
    // 2026-11-17-internal-transfer-allocation-supply-design.md): the picking
    // item is allocated against a confirmed internal transfer item — item
    // level, no sub-lot detail; the physical lot split happens at the
    // transfer's own picking/finish cross-dock.
    internalTransferItemId: text("internal_transfer_item_id").references(() => internalTransferItems.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull(),
    // Pinned hand-made allocation (admin console): allocateAll /
    // runScopedAllocation never wipe it and subtract its qty from the item's
    // auto-allocation demand. Removed only via the admin (x) action.
    manual: boolean("manual").notNull().default(false),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    sourceCheck: check(
      "chk_allocations_source",
      sql`inventory_lot_id IS NOT NULL OR receiving_invoice_item_id IS NOT NULL OR receiving_order_id IS NOT NULL OR internal_transfer_item_id IS NOT NULL`
    ),
    itemIdx: index("idx_allocations_picking_item").on(t.pickingItemId),
    transferItemIdx: index("idx_allocations_internal_transfer_item").on(t.internalTransferItemId),
    lotIdx: index("idx_allocations_lot").on(t.inventoryLotId),
    receivingItemIdx: index("idx_allocations_receiving_item").on(t.receivingInvoiceItemId),
    receivingOrderIdx: index("idx_allocations_receiving_order").on(t.receivingOrderId),
  })
);
