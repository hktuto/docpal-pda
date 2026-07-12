import type { Database as DatabaseType } from "better-sqlite3";
import { sql } from "drizzle-orm";
import { seedSql } from "./seedSql.js";
import { allocateAll } from "./allocate.js";
import { assertInvariantsHold } from "./invariants.guard.js";
import { recomputeReceivingItem } from "./invariants.js";
import type { AppDb } from "../db.js";

// every table createTables makes; FK is disabled during the wipe so order doesn't matter
const ALL_TABLES = [
  "users", "suppliers", "parts", "shelves",
  "receiving_orders", "receiving_invoices", "receiving_invoice_items", "receiving_item_mismatches",
  "picking_orders", "picking_items", "picking_packages", "shipping_boxes",
  "inventory_lots", "inventory_lot_sources", "allocations", "allocation_receiving_items",
  "measuring_tasks", "verification_tasks",
  "shelf_boxes", "shelf_box_items", "put_away_scans", "transition_logs",
];

// The frozen seedSql leaves derived receiving columns (allocated_qty / available_qty)
// at 0; recompute them from received/picked/put_away before allocating.
function recomputeAllReceivingItems(db: AppDb): void {
  const ids = db.all<{ id: string }>(sql`SELECT id FROM receiving_invoice_items`);
  for (const r of ids) recomputeReceivingItem(db, r.id);
}

function seedAll(sqlite: DatabaseType, db: AppDb): void {
  sqlite.exec(seedSql);
  recomputeAllReceivingItems(db);
  allocateAll(db);
  assertInvariantsHold(db);
}

/** Seed demo data when the users table is empty. Returns true when it seeded. */
export function seedIfEmpty(sqlite: DatabaseType, db: AppDb): boolean {
  const c = (sqlite.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number }).c;
  if (c > 0) return false;
  seedAll(sqlite, db);
  return true;
}

/** Dev-only: wipe everything and re-seed. Atomic: a failure rolls back to the pre-reset state. */
export function resetAndReseed(sqlite: DatabaseType, db: AppDb): void {
  const run = sqlite.transaction(() => {
    for (const t of ALL_TABLES) sqlite.exec(`DELETE FROM ${t}`);
    seedAll(sqlite, db);
  });
  // PRAGMA foreign_keys is a no-op inside a transaction, so toggle it outside.
  sqlite.exec("PRAGMA foreign_keys = OFF");
  try {
    run();
  } finally {
    sqlite.exec("PRAGMA foreign_keys = ON");
  }
}
