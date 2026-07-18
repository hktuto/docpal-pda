import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "./client.js";

test("createDb connects to Postgres and can run a query", async () => {
  const { sql, db } = createDb(process.env.TEST_DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse_test");
  const rows = await db.execute(`SELECT 1 AS one`);
  assert.deepEqual(rows[0], { one: 1 });
  await sql.end();
});

test("createDb uses DATABASE_URL when no connection string is provided", async () => {
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse_test";
  const { sql, db } = createDb();
  const rows = await db.execute(`SELECT 1 AS one`);
  assert.deepEqual(rows[0], { one: 1 });
  await sql.end();
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});
