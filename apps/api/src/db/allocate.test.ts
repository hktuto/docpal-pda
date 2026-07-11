import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { allocatePickingItem } from "./allocate.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'0','0');
  `);
  return { sqlite, db };
}

test("Phase 1 consumes on-shelf lots in created_at then date_code_norm order", () => {
  const { sqlite, db } = makeDb();
  // shelf_code IS NOT NULL = on-shelf. available generated = total - allocated (allocated defaults 0).
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, date_code_norm, created_at, updated_at) VALUES
      ('lotNew','p','S1',4,'202401','2024-02-01T00:00:00Z','0'),
      ('lotOld','p','S1',3,'202312','2024-01-01T00:00:00Z','0'),
      ('lotRecv','p',NULL,99,'202001','2023-01-01T00:00:00Z','0');
  `);
  db.transaction((tx) => allocatePickingItem(tx, "pi"));

  const allocs = sqlite.prepare("SELECT inventory_lot_id AS lot, qty FROM allocations WHERE picking_item_id='pi' ORDER BY rowid").all() as any[];
  // need=10; Phase1 order: lotOld (created 2024-01-01) qty3, then lotNew (2024-02-01) qty4 → 7; lotRecv is shelf_code NULL → excluded.
  assert.deepEqual(allocs, [{ lot: "lotOld", qty: 3 }, { lot: "lotNew", qty: 4 }]);
  assertInvariantsHold(db);
  sqlite.close();
});
