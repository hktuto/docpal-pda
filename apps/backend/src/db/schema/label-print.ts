import { pgTable, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { now } from "../now.js";

// Admin-managed rules that decide which print template a label print uses.
// conditions: { combinator: "and"|"or", conditions: [{ field, operator, value }] }
// — field ∈ org_id|sub_inventory|supplier|order_no|order_type|customer, operator ∈ eq|match
// (glob, `*` = any sequence), value non-empty string (org_id numeric).
// priority: first matching active rule wins (ascending).
export const labelPrintRules = pgTable("label_print_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  labelType: text("label_type").notNull(), // carton | item_box | item
  conditions: jsonb("conditions").notNull(),
  printTemplateId: text("print_template_id").notNull(), // upstream print-service template slug
  priority: integer("priority").notNull().default(100),
  active: boolean("active").notNull().default(true),
  remark: text("remark"),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});
