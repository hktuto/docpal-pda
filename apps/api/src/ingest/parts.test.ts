import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema/index.js";
import { createDb } from "../db/client.js";
import { createTables } from "../db/tables.js";
import { resolveOrCreatePart } from "./parts.js";
import { resolveSupplierId } from "./suppliers.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

test("resolveOrCreatePart creates a part with computed part_no_norm (O->0, I/L->1, Z->2, S->5)", () => {
  const { sqlite, db } = makeDb();
  const id = db.transaction((tx) => resolveOrCreatePart(tx, "ABO-ILZ S", "Widget"));
  const row = sqlite.prepare("SELECT part_no, part_no_norm, description FROM parts WHERE id=?").get(id) as any;
  assert.equal(row.part_no, "ABO-ILZ S");
  assert.equal(row.part_no_norm, "AB0-112 5");
  assert.equal(row.description, "Widget");
  sqlite.close();
});

test("resolveOrCreatePart is idempotent on part_no_norm and backfills description", () => {
  const { sqlite, db } = makeDb();
  const a = db.transaction((tx) => resolveOrCreatePart(tx, "X1", null));
  const b = db.transaction((tx) => resolveOrCreatePart(tx, "XI", "Desc"));
  assert.equal(a, b);
  const count = (sqlite.prepare("SELECT COUNT(*) c FROM parts").get() as any).c;
  assert.equal(count, 1);
  const desc = (sqlite.prepare("SELECT description FROM parts WHERE id=?").get(a) as any).description;
  assert.equal(desc, "Desc");
  sqlite.close();
});

test("resolveSupplierId returns id for known code, null for omitted, 400 for unknown code", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('s','SUP','S','0','0')`);
  assert.equal(db.transaction((tx) => resolveSupplierId(tx, "SUP")), "s");
  assert.equal(db.transaction((tx) => resolveSupplierId(tx, null)), null);
  assert.throws(() => db.transaction((tx) => resolveSupplierId(tx, "NOPE")), (e: any) => e.status === 400);
  sqlite.close();
});
