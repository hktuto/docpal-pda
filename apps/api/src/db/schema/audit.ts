import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";

export const transitionLogs = sqliteTable(
  "transition_logs",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actorId: text("actor_id"),
    note: text("note"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ entityIdx: index("transition_logs_entity_idx").on(t.entityType, t.entityId) })
);
