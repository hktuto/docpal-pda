import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * Wipe + re-seed the demo scenario world (Excel-driven demo dataset:
 * 2 pending receiving orders, 2 picking orders — SO-DEMO-0001 fully
 * allocated (181G×300 line scanned item-by-item, then the rest is a
 * whole-box match), SO-DEMO-0002 partially allocated —
 * and 2 stocked shelf boxes). Bulk Oracle parts are skipped to keep the
 * reseed fast; the seeded shelf boxes stay because many flows assert on
 * them.
 */
async function reseedTestWorld(client: TestDb): Promise<void> {
  await resetAndReseed(client.sql, client.db, { bulkParts: false });
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
