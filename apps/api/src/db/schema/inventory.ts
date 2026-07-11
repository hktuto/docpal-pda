import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";
import { parts } from "./master.js";
import { receivingInvoiceItems } from "./receiving.js";

export const inventoryLots = sqliteTable(
  "inventory_lots",
  {
    id: text("id").primaryKey(),
    partId: text("part_id").notNull().references(() => parts.id),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    dateCodeNorm: text("date_code_norm"),
    lotCodeNorm: text("lot_code_norm"),
    cooNorm: text("coo_norm"),
    cowNorm: text("cow_norm"),
    shelfCode: text("shelf_code"), // null = receiving-area lot
    boxId: text("box_id"),
    totalQty: integer("total_qty").notNull().default(0),
    allocatedQty: integer("allocated_qty").notNull().default(0), // MAINTAINED = Σ allocations.qty
    availableQty: integer("available_qty").generatedAlwaysAs(sql`total_qty - allocated_qty`, { mode: "stored" }),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    partShelfAvailIdx: index("inventory_lots_part_shelf_avail_idx").on(t.partId, t.shelfCode, t.availableQty),
  })
);

export const inventoryLotSources = sqliteTable(
  "inventory_lot_sources",
  {
    id: text("id").primaryKey(),
    inventoryLotId: text("inventory_lot_id").notNull().references(() => inventoryLots.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id),
    qty: integer("qty").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    lotIdx: index("ils_lot_idx").on(t.inventoryLotId),
    itemIdx: index("ils_item_idx").on(t.receivingInvoiceItemId),
  })
);

export const shelfBoxes = sqliteTable(
  "shelf_boxes",
  {
    id: text("id").primaryKey(),
    shelfCode: text("shelf_code").notNull(),
    boxId: text("box_id"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ shelfIdx: index("shelf_boxes_shelf_idx").on(t.shelfCode) })
);

export const shelfBoxItems = sqliteTable(
  "shelf_box_items",
  {
    id: text("id").primaryKey(),
    shelfBoxId: text("shelf_box_id").notNull().references(() => shelfBoxes.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull().references(() => parts.id),
    qty: integer("qty").notNull().default(0),
    verified: integer("verified").notNull().default(0),
    verifiedAt: text("verified_at"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    boxIdx: index("shelf_box_items_box_idx").on(t.shelfBoxId),
    partIdx: index("shelf_box_items_part_idx").on(t.partId),
  })
);

export const putAwayScans = sqliteTable(
  "put_away_scans",
  {
    id: text("id").primaryKey(),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id),
    qty: integer("qty").notNull().default(0),
    shelfBoxId: text("shelf_box_id").references(() => shelfBoxes.id), // null = scanned, not yet shelved
    verified: integer("verified").notNull().default(0),
    verifiedAt: text("verified_at"),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    itemIdx: index("put_away_scans_item_idx").on(t.receivingInvoiceItemId),
    boxIdx: index("put_away_scans_box_idx").on(t.shelfBoxId),
  })
);
