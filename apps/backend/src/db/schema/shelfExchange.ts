import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, shelves } from "./master.js";
import { inventoryLots } from "./inventory.js";

// Shelf exchange audit rows (spec 2026-10-12-shelf-exchange-design.md): one
// row per confirmed shelf→shelf stock move. The authoritative stock record
// lives in inventory_lots + inventory_transactions; this table is for audit
// visibility only.
export const shelfExchanges = pgTable(
  "shelf_exchanges",
  {
    id: text("id").primaryKey(),
    sourceShelfCode: text("source_shelf_code").notNull().references(() => shelves.code),
    targetShelfCode: text("target_shelf_code").notNull().references(() => shelves.code),
    sourceLotId: text("source_lot_id").notNull().references(() => inventoryLots.id),
    targetLotId: text("target_lot_id").notNull().references(() => inventoryLots.id),
    partNo: text("part_no").notNull(), // plain text (no FK — parts.part_no is not unique)
    wclItemNo: text("wcl_item_no"),
    qty: integer("qty").notNull(),
    // Label snapshot (same shape as ad-hoc put-away items)
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    orgId: integer("org_id"), // copied from the source lot
    subInventoryCode: text("sub_inventory_code"),
    actorId: text("actor_id").notNull().references(() => users.id),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    sourceShelfIdx: index("idx_shelf_exchanges_source_shelf").on(t.sourceShelfCode),
    targetShelfIdx: index("idx_shelf_exchanges_target_shelf").on(t.targetShelfCode),
    partIdx: index("idx_shelf_exchanges_part").on(t.partNo),
    actorIdx: index("idx_shelf_exchanges_actor").on(t.actorId),
    createdIdx: index("idx_shelf_exchanges_created").on(t.createdDate),
  })
);
