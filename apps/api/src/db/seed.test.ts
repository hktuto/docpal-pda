import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { seedIfEmpty, resetAndReseed } from "./seed.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

test("seedIfEmpty seeds demo data; allocations derived; invariants hold; idempotent", () => {
  const { sqlite, db } = freshDb();
  assert.equal(seedIfEmpty(sqlite, db), true);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM users").get() as any).c, 2);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM receiving_invoice_items").get() as any).c, 264);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM picking_orders").get() as any).c, 23);
  const allocs = (sqlite.prepare("SELECT COUNT(*) c FROM allocations").get() as any).c;
  assert.ok(allocs >= 73, `expected >= 73 allocations, got ${allocs}`);
  assert.ok((sqlite.prepare("SELECT COUNT(*) c FROM allocation_receiving_items").get() as any).c > 0);
  assertInvariantsHold(db);
  assert.equal(seedIfEmpty(sqlite, db), false);
  sqlite.close();
});

test("resetAndReseed wipes and re-seeds", () => {
  const { sqlite, db } = freshDb();
  seedIfEmpty(sqlite, db);
  sqlite.exec("DELETE FROM transition_logs");
  resetAndReseed(sqlite, db);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM receiving_orders").get() as any).c, 1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM users").get() as any).c, 2);
  assertInvariantsHold(db);
  sqlite.close();
});
