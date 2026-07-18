import type { AppDb } from "../db.js";

// every table created by Drizzle migrations; order matters for TRUNCATE without CASCADE
const ALL_TABLES = [
  "inventory_transactions",
  "transaction_logs",
  "measuring_tasks",
  "picking_packages",
  "shipping_box_items",
  "shipping_boxes",
  "picking_items",
  "picking_orders",
  "allocations",
  "inventory_lot_sources",
  "inventory_lots",
  "shelf_box_items",
  "shelf_boxes",
  "receiving_invoice_items",
  "receiving_invoices",
  "receiving_orders",
  "shelves",
  "parts",
  "suppliers",
  "users",
];

/** Wipe all data. Used by tests and the dev reset endpoint. */
export async function resetTables(db: AppDb): Promise<void> {
  await db.execute(`TRUNCATE TABLE ${ALL_TABLES.join(", ")} CASCADE`);
}
