import { sql } from "drizzle-orm";
import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { now } from "../now.js";

// Per-warehouse settings (spec: docs/superpowers/specs/2026-08-10-flow-config-design.md).
// One row per key; the "flow" row holds the flow-config JSON (same shape as
// the FLOW_CONFIG env var, which wins when set). Written by seed / SQL,
// loaded once at boot — changes need a backend restart.
// Intentionally no sync_events trigger: internal config, not synced out.
export const warehouseConfig = pgTable("warehouse_config", {
  key: text("key").primaryKey(), // e.g. "flow"
  value: jsonb("value").notNull(), // config payload (partial JSON merged over defaults)
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});
