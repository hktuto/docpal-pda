import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { parts, shelves } from "./master.js";
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
    shelfCode: text("shelf_code").references(() => shelves.code), // dock lots use a virtual dock shelf_code (shelves.location_type)
    boxId: text("box_id"),
    supplierInvoiceNo: text("supplier_invoice_no"),
    expectedQty: integer("expected_qty").notNull().default(0),
    totalQty: integer("total_qty").notNull().default(0),
    allocatedQty: integer("allocated_qty").notNull().default(0), // MAINTAINED = Σ allocations.qty
    availableQty: integer("available_qty").generatedAlwaysAs(sql`total_qty - allocated_qty`),
  },
  (t) => ({
    uniqueLot: uniqueIndex("inventory_lots_unique_lot")
      .on(t.partId, t.dateCode, t.coo, t.cow, t.shelfCode, t.boxId)
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
    shelfCode: text("shelf_code").references(() => shelves.code), // null = staged (scanned, not yet shelved)
    status: text("status", { enum: ["open", "closed", "verified"] }).notNull().default("open"),
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
