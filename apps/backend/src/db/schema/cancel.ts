import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, bigint, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { now } from "../now.js";
import { pickingOrders, pickingItems, pickingPackages } from "./picking.js";

// ---------------------------------------------------------------------------
// Cancel-invoice ingest + put-back queue (spec
// docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md).
// The upstream publishes `public.cancel_invoice` / `public.cancel_invoice_tn`
// (externally-managed, no schema/migration — same precedent as
// wcl_part_drawno). cancel_records is OUR ingest log: it keys the idempotency
// dedupe, stores the outcome the admin reads, and holds the sync watermark
// (source_ts), so nothing is ever re-applied. No FKs to the cancel tables —
// an external writer owns them (allocationSnapshot precedent).
// ---------------------------------------------------------------------------

export const cancelRecords = pgTable(
  "cancel_records",
  {
    id: text("id").primaryKey(),
    /** Upstream source table + row id — the dedupe key. */
    source: varchar("source", { length: 24 }).notNull(), // cancel_invoice | cancel_invoice_tn
    sourceId: text("source_id").notNull(),
    /** Copied lookup keys (audit — what the upstream row said). */
    piInvoiceNum: text("pi_invoice_num"),
    tnNumber: text("tn_number"),
    tnLineId: bigint("tn_line_id", { mode: "number" }),
    orgId: integer("org_id"),
    /** What we matched; both NULL for outcome no_match. */
    pickingOrderId: text("picking_order_id").references(() => pickingOrders.id, { onDelete: "set null" }),
    pickingItemId: text("picking_item_id").references(() => pickingItems.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull(), // cancelled | cancelled_with_putback | ignored | no_match | error
    message: text("message"),
    /** greatest(created_date, last_update_date) of the source row at processing time — also the watermark. */
    sourceTs: timestamp("source_ts", { mode: "date" }).notNull(),
    /** done = final; error = retried on the next cron pass. */
    status: text("status").notNull().default("done"), // done | error
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    sourceUq: uniqueIndex("idx_cancel_records_source").on(t.source, t.sourceId),
    outcomeIdx: index("idx_cancel_records_outcome").on(t.outcome),
  })
);

// Put-back tasks: stock already picked for a cancelled order/item has to go
// physically back onto a shelf. The picked packages are kept (they are the
// record of what was picked); this queue is the move instruction. assignee
// follows the queue convention (NULL = visible to everyone).
export const putBackTasks = pgTable(
  "put_back_tasks",
  {
    id: text("id").primaryKey(),
    cancelSource: varchar("cancel_source", { length: 24 }).notNull(),
    cancelSourceId: text("cancel_source_id").notNull(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    // TN line cancels set this; "" = whole-order (invoice) cancel. Text with
    // no FK ("" can never match a row) and NOT NULL so the unique index below
    // never treats two whole-order tasks as distinct.
    pickingItemId: text("picking_item_id").notNull().default(""),
    status: text("status").notNull().default("pending"), // pending | completed
    assignee: text("assignee"),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    /** Idempotent task creation — one task per cancel row + order (+ item). */
    cancelUq: uniqueIndex("idx_put_back_tasks_cancel").on(t.cancelSource, t.cancelSourceId, t.pickingOrderId, t.pickingItemId),
    statusIdx: index("idx_put_back_tasks_status").on(t.status),
  })
);

export const putBackTaskItems = pgTable(
  "put_back_task_items",
  {
    id: text("id").primaryKey(),
    putBackTaskId: text("put_back_task_id").notNull().references(() => putBackTasks.id, { onDelete: "cascade" }),
    /** The physical picked unit this row returns — unique: a package is never put back twice. */
    pickingPackageId: text("picking_package_id").notNull().references(() => pickingPackages.id, { onDelete: "cascade" }),
    partNo: text("part_no").notNull(),
    wclItemNo: text("wcl_item_no"),
    qty: integer("qty").notNull(),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    /** Where the stock came from (NULL for dock-sourced picks — the operator picks the shelf). */
    shelfCode: text("shelf_code"),
    orgId: integer("org_id"),
    subInventoryCode: text("sub_inventory_code"),
    status: text("status").notNull().default("pending"), // pending | put_back
    /** Actual shelf the stock landed on (set on completion). */
    doneShelfCode: text("done_shelf_code"),
    doneAt: timestamp("done_at", { mode: "date" }),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    taskIdx: index("idx_put_back_task_items_task").on(t.putBackTaskId),
    packageUq: uniqueIndex("idx_put_back_task_items_package").on(t.pickingPackageId),
    qtyCheck: check("chk_put_back_task_items_qty", sql`qty > 0`),
  })
);
