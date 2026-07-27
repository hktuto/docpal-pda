import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb } from "./client.js";
import { resetAndReseed } from "./seed.js";
import type { AppDb } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://warehouse:warehouse@localhost:5432/warehouse_backend_test";

let migrated = false;

export interface TestDb {
  sql: ReturnType<typeof createDb>["sql"];
  db: AppDb;
}

/**
 * Wipe + re-seed the demo dataset, minus the new_seed real-data picking
 * orders: two of their items reference a demo part_no and (via the SZHK1 /
 * STORE1 pairs) could compete with the seeded demo demands for demo stock,
 * so the tests stay hermetic against the minimal demo world.
 */
async function reseedTestWorld(client: TestDb): Promise<void> {
  await resetAndReseed(client.sql, client.db, { stockBoxes: false, bulkParts: false });
  await client.db.execute(sql`DELETE FROM picking_orders WHERE order_no <> 'SO-2026-0001'`);
}

/** Migrate once, then wipe + re-seed the demo dataset. */
export async function setupTestDb(): Promise<TestDb> {
  const client = createDb(TEST_DATABASE_URL);
  if (!migrated) {
    await migrate(client.db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
    migrated = true;
  }
  await reseedTestWorld(client);
  return client;
}

/** Re-seed an existing test client between tests. */
export async function reseed(client: TestDb): Promise<void> {
  await reseedTestWorld(client);
}
