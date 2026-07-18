import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse_test";

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

type TestClient = ReturnType<typeof createDb>;

let migrated = false;
let singletonSql: TestClient["sql"] | undefined;
let singletonDb: TestClient["db"] | undefined;

export interface TestDb {
  sql: TestClient["sql"];
  db: TestClient["db"];
}

async function ensureMigrations(db: TestClient["db"]): Promise<void> {
  if (!migrated) {
    await migrate(db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
    migrated = true;
  }
}

export async function createTestDb(): Promise<TestDb> {
  const client = createDb(TEST_DATABASE_URL);
  await ensureMigrations(client.db);
  await client.db.execute(`TRUNCATE TABLE ${ALL_TABLES.join(", ")} CASCADE`);
  return client;
}

export async function setupTestDb(): Promise<TestDb> {
  if (!singletonSql || !singletonDb) {
    const client = createDb(TEST_DATABASE_URL);
    singletonSql = client.sql;
    singletonDb = client.db;
  }
  await ensureMigrations(singletonDb);
  await singletonDb.execute(`TRUNCATE TABLE ${ALL_TABLES.join(", ")} CASCADE`);
  return { sql: singletonSql, db: singletonDb };
}

export { singletonSql as sql, singletonDb as db };
