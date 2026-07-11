import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { applyReceipt, applyPick, applyPutAway } from "./invariants.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e','R','in_hand','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','INV','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, created_at, updated_at) VALUES ('rii','ri','p',20,0,'0','0');
  `);
  return { sqlite, db };
}

const avail = (sqlite: any) =>
  (sqlite.prepare("SELECT received_qty r, picked_qty p, put_away_qty pa, allocated_qty al, available_qty av FROM receiving_invoice_items WHERE id='rii'").get() as any);

test("receipt then pick then put-away keeps available_qty correct", () => {
  const { sqlite, db } = makeDb();
  applyReceipt(db, "rii", 10);
  assert.deepEqual(avail(sqlite), { r: 10, p: 0, pa: 0, al: 0, av: 10 });
  applyPick(db, "rii", 3);
  assert.deepEqual(avail(sqlite), { r: 10, p: 3, pa: 0, al: 0, av: 7 });
  applyPutAway(db, "rii", 4, null);
  assert.deepEqual(avail(sqlite), { r: 10, p: 3, pa: 4, al: 0, av: 3 });
  sqlite.close();
});
