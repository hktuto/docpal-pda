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

test("Phase 2 consumes receiving orders by delivery_date FIFO, invoice_no, date_code", () => {
  const { sqlite, db } = makeDb();
  // Two in_hand receiving orders for part 'p', no shelf stock. roLate delivered later, roEarly earlier.
  sqlite.exec(`
    INSERT INTO receiving_orders (id, external_id, ref_no, status, delivery_date, created_at, updated_at) VALUES
      ('roLate','el','RL','in_hand','2024-06-01','0','0'),
      ('roEarly','ee','RE','in_hand','2024-01-01','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES
      ('riLate','roLate','INV-L','0','0'),
      ('riEarly','roEarly','INV-E','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, date_code, created_at, updated_at) VALUES
      ('riiLate','riLate','p',100,100,100,'202402','0','0'),
      ('riiEarly','riEarly','p',4,4,4,'202401','0','0');
  `);
  db.transaction((tx) => allocatePickingItem(tx, "pi"));

  // need=10; no shelf; Phase2 order: roEarly (delivery 2024-01-01) fills 4 from riiEarly, then roLate fills 6 from riiLate.
  const a = sqlite.prepare("SELECT receiving_order_id AS ro, qty FROM allocations WHERE picking_item_id='pi' ORDER BY rowid").all() as any[];
  assert.deepEqual(a, [{ ro: "roEarly", qty: 4 }, { ro: "roLate", qty: 6 }]);
  const links = sqlite.prepare("SELECT receiving_invoice_item_id AS rii, qty FROM allocation_receiving_items ORDER BY rowid").all() as any[];
  assert.deepEqual(links, [{ rii: "riiEarly", qty: 4 }, { rii: "riiLate", qty: 6 }]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("within one receiving order: boxed items allocate box-by-box, unboxed group into one pool", () => {
  const { sqlite, db } = makeDb();
  // One in_hand order with part 'p' spread across two invoices: one boxed item (box 'B1' qty 3) and two unboxed items (qty 2 + 2).
  sqlite.exec(`
    INSERT INTO receiving_orders (id, external_id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro','e','R','in_hand','2024-01-01','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES
      ('riA','ro','A','0','0'),('riB','ro','B','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, box_id, date_code, created_at, updated_at) VALUES
      ('riiBox','riA','p',3,3,3,'B1','202401','0','0'),
      ('riiU1','riA','p',2,2,2,NULL,'202401','0','0'),
      ('riiU2','riB','p',2,2,2,NULL,'202401','0','0');
  `);
  db.transaction((tx) => allocatePickingItem(tx, "pi"));

  // need=10. Boxed riiBox (invoice A, date 202401) → its own allocation qty3. Unboxed riiU1+riiU2 (A then B) grouped → one allocation qty4 with two link rows.
  const allocs = sqlite.prepare("SELECT id, receiving_order_id AS ro, qty FROM allocations WHERE picking_item_id='pi' ORDER BY rowid").all() as any[];
  assert.equal(allocs.length, 2);
  assert.deepEqual(allocs.map((x) => x.qty).sort(), [3, 4]);

  const boxAlloc = allocs.find((x) => x.qty === 3)!;
  const poolAlloc = allocs.find((x) => x.qty === 4)!;
  const boxLinks = sqlite.prepare("SELECT receiving_invoice_item_id AS rii, qty FROM allocation_receiving_items WHERE allocation_id=?").all(boxAlloc.id) as any[];
  assert.deepEqual(boxLinks, [{ rii: "riiBox", qty: 3 }]);
  const poolLinks = sqlite.prepare("SELECT receiving_invoice_item_id AS rii, qty FROM allocation_receiving_items WHERE allocation_id=? ORDER BY rowid").all(poolAlloc.id) as any[];
  assert.deepEqual(poolLinks, [{ rii: "riiU1", qty: 2 }, { rii: "riiU2", qty: 2 }]);
  assertInvariantsHold(db);
  sqlite.close();
});
