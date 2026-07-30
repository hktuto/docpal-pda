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
  createdDate: timestamp("created_date", { mode: "date" }).notNull().$defaultFn(now),
  lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().$defaultFn(now),
});
