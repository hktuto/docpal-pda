import { pgTable, text, integer, boolean, timestamp, unique, foreignKey } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { subInventories } from "./master.js";

// Per-warehouse presentation labels for sub-inventories. Each warehouse is a
// separate instance/database, so no warehouse_id column is needed. The
// (org_id, sub_inventory_code) pair is the business key — a composite FK to
// org_info ensures the referenced sub-inventory exists. is_active controls PDA
// visibility; sort_order controls display order.
export const inventoryLabels = pgTable(
  "inventory_labels",
  {
    id: text("id").primaryKey(),
    orgId: integer("org_id").notNull(),
    subInventoryCode: text("sub_inventory_code").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    remark: text("remark"),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    orgSubinvUq: unique("inventory_labels_org_subinv_unique").on(t.orgId, t.subInventoryCode),
    subInvFk: foreignKey({
      name: "inventory_labels_sub_inv_fk",
      columns: [t.orgId, t.subInventoryCode],
      foreignColumns: [subInventories.orgId, subInventories.secondaryInventoryName],
    }),
  })
);