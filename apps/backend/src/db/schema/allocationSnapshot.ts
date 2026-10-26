import { bigint, boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { now } from "../now.js";

export const allocationSnapshotBatches = pgTable(
  "allocation_snapshot_batches",
  {
    id: text("id").primaryKey(),
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    capturedAt: timestamp("captured_at", { mode: "date" }).notNull(),
    restoredAt: timestamp("restored_at", { mode: "date" }),
    report: jsonb("report"),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    dateUq: uniqueIndex("allocation_snapshot_batches_date_unique").on(t.snapshotDate),
  })
);

export const allocationSnapshotRows = pgTable(
  "allocation_snapshot_rows",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id").notNull().references(() => allocationSnapshotBatches.id, { onDelete: "cascade" }),
    allocationId: text("allocation_id").notNull(),
    pickingItemId: text("picking_item_id").notNull(),
    pickingOrderId: text("picking_order_id").notNull(),
    pickingOrderNo: text("picking_order_no").notNull(),
    pickingPartNo: text("picking_part_no").notNull(),
    pickingLineId: bigint("picking_line_id", { mode: "number" }),
    pickingLineNumber: integer("picking_line_number"),
    sourceType: text("source_type").notNull(),
    qty: integer("qty").notNull(),
    manual: boolean("manual").notNull(),
    inventoryLotId: text("inventory_lot_id"),
    sourcePartNo: text("source_part_no"),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    shelfCode: text("shelf_code"),
    boxId: text("box_id"),
    orgId: integer("org_id"),
    subInventoryCode: text("sub_inventory_code"),
    receivingInvoiceItemId: text("receiving_invoice_item_id"),
    receivingOrderId: text("receiving_order_id"),
    receivingBatchNo: text("receiving_batch_no"),
    invoiceNo: text("invoice_no"),
    poNo: text("po_no"),
    poLine: text("po_line"),
    ctnNo: text("ctn_no"),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => ({
    batchAllocationUq: uniqueIndex("allocation_snapshot_rows_batch_allocation_unique").on(t.batchId, t.allocationId),
    batchIdx: index("idx_allocation_snapshot_rows_batch").on(t.batchId),
  })
);
