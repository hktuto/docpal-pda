import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  return createDb(path.join(dir, "t.sqlite")).sqlite;
}
function shelfBoxCols(sqlite: any): string[] {
  return (sqlite.prepare("PRAGMA table_info(shelf_boxes)").all() as any[]).map((c) => c.name);
}

test("createTables gives fresh + stale DBs the new shelf_boxes columns", () => {
  // fresh DB: columns come straight from the DDL
  const a = freshDb();
  createTables(a);
  const colsA = shelfBoxCols(a);
  assert.ok(colsA.includes("status") && colsA.includes("receiving_order_id"));
  a.close();

  // stale DB: pre-create the OLD shelf_boxes shape + a row, then createTables must upgrade it
  const b = freshDb();
  b.exec(`CREATE TABLE shelf_boxes (id TEXT PRIMARY KEY, shelf_code TEXT NOT NULL, box_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          INSERT INTO shelf_boxes (id, shelf_code, created_at, updated_at) VALUES ('b1','S1','0','0');`);
  createTables(b);
  const colsB = shelfBoxCols(b);
  assert.ok(colsB.includes("status") && colsB.includes("receiving_order_id"));
  // existing rows backfill status='open'
  assert.equal((b.prepare("SELECT status FROM shelf_boxes WHERE id='b1'").get() as any).status, "open");
  b.close();
});
