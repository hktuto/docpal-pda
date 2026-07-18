import postgres from "postgres";
import { sql } from "drizzle-orm";
import { allocateAll } from "./allocate.js";
import { assertInvariantsHold } from "./invariants.guard.js";
import { seedSql } from "./seedSql.js";
import type { AppDb } from "../db.js";

// every table created by Drizzle migrations
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

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/gm)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function seedAll(execRaw: (statement: string) => Promise<unknown>, db: AppDb): Promise<void> {
  for (const statement of splitStatements(seedSql)) {
    await execRaw(statement);
  }
  await allocateAll(db);
  await assertInvariantsHold(db);
}

/** Seed demo data when the users table is empty. Returns true when it seeded. */
export async function seedIfEmpty(sql: postgres.Sql, db: AppDb): Promise<boolean> {
  const rows = await sql`SELECT COUNT(*)::int AS c FROM users`;
  const c = Number((rows[0] as { c: string | number }).c);
  if (c > 0) return false;
  await seedAll((stmt) => sql.unsafe(stmt), db);
  return true;
}

/** Dev-only: wipe everything and re-seed inside a transaction. */
export async function resetAndReseed(_sql: postgres.Sql, db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE ${sql.raw(ALL_TABLES.join(", "))} CASCADE`);
    await seedAll(
      (stmt) => tx.execute(sql`${sql.raw(stmt)}`),
      tx as unknown as AppDb
    );
  });
}
