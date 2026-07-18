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

/** Migrate once, then wipe + re-seed the demo dataset. */
export async function setupTestDb(): Promise<TestDb> {
  const client = createDb(TEST_DATABASE_URL);
  if (!migrated) {
    await migrate(client.db, { migrationsFolder: path.join(__dirname, "../../drizzle") });
    migrated = true;
  }
  await resetAndReseed(client.sql, client.db);
  return client;
}

/** Re-seed an existing test client between tests. */
export async function reseed(client: TestDb): Promise<void> {
  await resetAndReseed(client.sql, client.db);
}
