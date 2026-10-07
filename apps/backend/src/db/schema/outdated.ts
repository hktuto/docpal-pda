import { pgTable, index, text, integer, timestamp } from "drizzle-orm/pg-core";
import { now } from "../now.js";

// Outdated date-code scan warnings (spec
// docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md):
// one row per picking/put-away scan whose label date code was older than the
// supplier's outdated_limit_months. The scan still succeeds; the row blocks
// order completion until an admin resolves the whole order (resolved_at NULL =
// unresolved). order_id has no FK — the target differs per order_kind
// (picking_orders / receiving_orders).
export const outdatedScanWarnings = pgTable(
  "outdated_scan_warnings",
  {
    id: text("id").primaryKey(),
    orderKind: text("order_kind").notNull(), // 'picking' | 'putaway'
    orderId: text("order_id").notNull(),
    orderItemId: text("order_item_id"), // picking item / receiving invoice item
    packageId: text("package_id"), // the created picking_packages / shelf_box_items row
    supplierCode: text("supplier_code").notNull(),
    wclItemNo: text("wcl_item_no"),
    partNo: text("part_no"),
    dateCode: text("date_code").notNull(), // scanned WWYY (post decode)
    limitMonths: integer("limit_months").notNull(), // supplier limit snapshot
    qty: integer("qty"),
    scannedBy: text("scanned_by").notNull(),
    scannedAt: timestamp("scanned_at", { mode: "date" }).notNull(),
    resolvedAt: timestamp("resolved_at", { mode: "date" }),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
    createdDate: timestamp("created_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
    lastUpdateDate: timestamp("last_update_date", { mode: "date" }).notNull().defaultNow().$defaultFn(now),
  },
  (t) => [index("idx_outdated_scan_warnings_order").on(t.orderKind, t.orderId)]
);
