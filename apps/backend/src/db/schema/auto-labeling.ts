import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { pickingOrders } from "./picking.js";

// Auto labeling machine print jobs (spec 2026-11-12): one row per
// auto_machine label print request created from the PDA. The machine claims
// the job via POST /auto-labeling/jobs/fetch (status → printing) and reports
// completion via PATCH /auto-labeling/jobs/:id (→ completed | failed).
// payload: the converted label rows ({shippingBoxId, packageId, params}, same
// shape as label_prints.payload) — the machine prints from this directly.
// order_snapshot: picking order details for the machine to display/check;
// scan_snapshot: the pick-time scanned records (per package part/qty +
// scanned date/lot/coo/cow). Auto jobs are NOT written to label_prints and do
// not participate in label-mode verify (the machine verifies itself).
export const autoLabelingJobs = pgTable(
  "auto_labeling_jobs",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id),
    machineId: text("machine_id"), // reserved for multi-machine; NULL today
    payload: jsonb("payload").notNull(),
    orderSnapshot: jsonb("order_snapshot").notNull(),
    scanSnapshot: jsonb("scan_snapshot").notNull(),
    status: text("status").notNull().default("pending"),
    statusNote: text("status_note"),
    createdBy: text("created_by").notNull(),
    fetchedDate: timestamp("fetched_date", { mode: "date" }),
    completedDate: timestamp("completed_date", { mode: "date" }),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("idx_auto_labeling_jobs_order").on(t.pickingOrderId),
    fetchIdx: index("idx_auto_labeling_jobs_fetch").on(t.status, t.machineId, t.createdDate),
    statusCheck: check(
      "chk_auto_labeling_jobs_status",
      sql`status IN ('pending', 'printing', 'completed', 'failed')`
    ),
  })
);
