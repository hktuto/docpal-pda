import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { users, shelves } from "./master.js";

// Ad-hoc put-away batches (spec 2026-10-07-ad-hoc-put-away-design.md):
// one row per confirmed batch — items with no receiving order (old store
// stock, write-out returns) put away directly to a shelf. The authoritative
// stock record lives in inventory_lots + inventory_transactions; this table
// is for audit and admin visibility only.
export const adHocPutAways = pgTable(
  "ad_hoc_put_aways",
  {
    id: text("id").primaryKey(),
    supplierCode: text("supplier_code").notNull(),
    shelfCode: text("shelf_code").notNull().references(() => shelves.code),
    orgId: integer("org_id").notNull(),
    subInventoryCode: text("sub_inventory_code").notNull(),
    totalQty: integer("total_qty").notNull(),
    itemCount: integer("item_count").notNull(),
    items: jsonb("items").notNull().default(sql`'[]'::jsonb`),
    actorId: text("actor_id").notNull().references(() => users.id),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    shelfIdx: index("idx_ad_hoc_put_aways_shelf").on(t.shelfCode),
    actorIdx: index("idx_ad_hoc_put_aways_actor").on(t.actorId),
    createdIdx: index("idx_ad_hoc_put_aways_created").on(t.createdDate),
  })
);
