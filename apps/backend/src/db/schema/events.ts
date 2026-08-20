import { sql } from "drizzle-orm";
import { pgTable, text, bigserial, timestamp, jsonb } from "drizzle-orm/pg-core";
import { now } from "../now.js";

// SSE outbox (design: docs/superpowers/specs/2026-07-18-sse-events-and-swr-cache-design.md).
// Mutations insert a row inside the same transaction as the domain change;
// GET /events polls this table and streams new rows to connected clients.
export const appEvents = pgTable("app_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(), // monotonic resume cursor (first non-text PK in the schema)
  type: text("type").notNull(), // e.g. allocation.computed / picking_order.created
  topics: text("topics").array().notNull(), // URL path prefixes for client cache invalidation
  data: jsonb("data").notNull().default(sql`'{}'::jsonb`), // free-form payload (order id, counts, ...)
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});

// Table-change feed for external sync services (catalog:
// docs/backend/event-catalog.md). Rows are written by the
// sync_events_notify() trigger on every business table — only for changes
// committed by the backend's own Postgres role — never by application code.
// GET /sync-events?since= lets a service poll with id as its cursor.
export const syncEvents = pgTable("sync_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(), // monotonic resume cursor
  eventType: text("event_type").notNull(), // <table>.<insert|update|delete>
  eventData: jsonb("event_data").notNull(), // {table, action, new, old}
  createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
});
