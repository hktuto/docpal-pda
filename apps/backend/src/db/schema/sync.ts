import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { now } from "../now.js";

// Electric sync consumer checkpoints: one row per synced remote table holding
// the Electric shape handle + log offset, so the consumer resumes where it
// stopped across restarts instead of re-reading the whole shape log
// (spec: docs/superpowers/specs/2026-08-18-electric-sql-sync-design.md).
// Internal bookkeeping — intentionally no sync_events trigger.
export const syncCheckpoints = pgTable("sync_checkpoints", {
  tableName: text("table_name").primaryKey(), // remote table, e.g. "demo.wms_parts"
  shapeHandle: text("shape_handle").notNull(),
  shapeOffset: text("shape_offset").notNull(),
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});
