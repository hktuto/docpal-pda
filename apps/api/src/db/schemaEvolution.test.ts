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

test("createTables upgrades the cycle-coalesce index to its partial form", () => {
  const sqlite = freshDb();
  createTables(sqlite);
  // simulate a stale DB carrying the OLD non-partial index definition
  sqlite.exec(`DROP INDEX verification_tasks_cycle_coalesce_uq;
               CREATE UNIQUE INDEX verification_tasks_cycle_coalesce_uq ON verification_tasks(kind, shelf_box_id, date(due_at));`);
  createTables(sqlite);
  const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='verification_tasks_cycle_coalesce_uq'").get() as any;
  assert.match(row.sql, /WHERE/i);
  // partial index: a completed task and a new pending task for the same box/day coexist
  sqlite.exec(`INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
               INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
               INSERT INTO shelf_boxes (id, shelf_code, status, created_at, updated_at) VALUES ('box','A1','closed','0','0');
               INSERT INTO verification_tasks (id, kind, status, shelf_box_id, due_at, created_at, updated_at)
                 VALUES ('vt1','cycle_count','completed','box','2099-01-01T09:00:00.000Z','0','0'),
                        ('vt2','cycle_count','pending','box','2099-01-01T09:00:00.000Z','0','0');`);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS c FROM verification_tasks").get() as any).c, 2);
  sqlite.close();
});
