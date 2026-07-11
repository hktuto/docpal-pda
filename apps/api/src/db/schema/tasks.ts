import { sql } from "drizzle-orm";
import { sqliteTable, text, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";
import { pickingOrders } from "./picking.js";
import { shelfBoxes } from "./inventory.js";

export const measuringTasks = sqliteTable(
  "measuring_tasks",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }).unique(),
    status: text("status", { enum: ["pending", "completed"] }).notNull().default("pending"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ statusUpdatedIdx: index("measuring_tasks_status_updated_idx").on(t.status, t.updatedAt) })
);

export const verificationTasks = sqliteTable(
  "verification_tasks",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["pre_shipment", "cycle_count"] }).notNull(),
    status: text("status", { enum: ["pending", "completed"] }).notNull().default("pending"),
    dueAt: text("due_at"),
    pickingOrderId: text("picking_order_id").references(() => pickingOrders.id, { onDelete: "cascade" }),
    shelfBoxId: text("shelf_box_id").references(() => shelfBoxes.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    preShipmentFk: check("vt_pre_shipment_fk", sql`(kind = 'pre_shipment') = (picking_order_id IS NOT NULL)`),
    cycleCountFk: check("vt_cycle_count_fk", sql`(kind = 'cycle_count') = (shelf_box_id IS NOT NULL)`),
    kindStatusUpdatedIdx: index("verification_tasks_kind_status_updated_idx").on(t.kind, t.status, t.updatedAt),
    pickingOrderIdx: index("verification_tasks_picking_order_idx").on(t.pickingOrderId),
    shelfBoxIdx: index("verification_tasks_shelf_box_idx").on(t.shelfBoxId),
    cycleCoalesceUq: uniqueIndex("verification_tasks_cycle_coalesce_uq").on(t.kind, t.shelfBoxId, sql`date(${t.dueAt})`),
    preshipPendingUq: uniqueIndex("verification_tasks_preship_pending_uq").on(t.pickingOrderId).where(sql`kind='pre_shipment' AND status='pending'`),
  })
);
