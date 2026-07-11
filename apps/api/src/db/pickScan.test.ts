import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { scanAllocation, removeScannedPackage } from "./pickScan.js";
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

test("scan against a shelf-lot allocation: lot total drops, allocation reduced, one package, invariants hold", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, date_code, created_at, updated_at) VALUES ('lot','p','S1',10,10,'202401','0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot','0','0');
  `);
  const res = db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 4 }));
  assert.equal(res.packageIds.length, 1);
  const lot = sqlite.prepare("SELECT total_qty, allocated_qty, available_qty FROM inventory_lots WHERE id='lot'").get() as any;
  assert.deepEqual(lot, { total_qty: 6, allocated_qty: 6, available_qty: 0 });
  const a = sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any;
  assert.equal(a.qty, 6);
  const pkg = sqlite.prepare("SELECT qty, source_type, source_id, date_code, shipping_box_id FROM picking_packages").get() as any;
  assert.deepEqual(pkg, { qty: 4, source_type: "inventory_lot", source_id: "lot", date_code: "202401", shipping_box_id: null });
  const pi = sqlite.prepare("SELECT scanned_not_boxed_qty, picked_qty, remaining_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { scanned_not_boxed_qty: 4, picked_qty: 0, remaining_qty: 6 });
  assertInvariantsHold(db);
  sqlite.close();
});

test("scan against a receiving allocation consumes link portions FIFO (one package per portion)", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e','R','in_hand','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, allocated_qty, available_qty, date_code, created_at, updated_at) VALUES
      ('riiA','ri','p',25,25,25,0,'202401','0','0'),
      ('riiB','ri','p',25,25,15,10,'202402','0','0');
    INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at) VALUES ('a','pi',40,'ro','0','0');
    INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at) VALUES
      ('lA','a','riiA',25,'0','0'), ('lB','a','riiB',15,'1','0');
  `);
  sqlite.prepare("UPDATE picking_items SET qty=40").run(); // item must require >= the 30 scanned
  const res = db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 30 }));
  assert.equal(res.packageIds.length, 2); // 25 from riiA + 5 from riiB
  const riis = sqlite.prepare("SELECT id, picked_qty, allocated_qty, available_qty FROM receiving_invoice_items ORDER BY id").all() as any[];
  assert.deepEqual(riis, [
    { id: "riiA", picked_qty: 25, allocated_qty: 0, available_qty: 0 },
    { id: "riiB", picked_qty: 5, allocated_qty: 10, available_qty: 10 },
  ]);
  assert.equal((sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any).qty, 10);
  const links = sqlite.prepare("SELECT receiving_invoice_item_id AS r, qty FROM allocation_receiving_items ORDER BY id").all() as any[];
  assert.deepEqual(links, [{ r: "riiA", qty: 0 }, { r: "riiB", qty: 10 }]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("undo of a receiving-source scan restores picked_qty, allocation, links, and logs removal", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e','R','in_hand','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, allocated_qty, available_qty, date_code, created_at, updated_at) VALUES
      ('riiA','ri','p',25,25,25,0,'202401','0','0'),
      ('riiB','ri','p',25,25,15,10,'202402','0','0');
    INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at) VALUES ('a','pi',40,'ro','0','0');
    INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at) VALUES
      ('lA','a','riiA',25,'0','0'), ('lB','a','riiB',15,'1','0');
  `);
  sqlite.prepare("UPDATE picking_items SET qty=40").run();
  const res = db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 30 }));
  assert.equal(res.packageIds.length, 2); // 25 from riiA + 5 from riiB

  db.transaction((tx) => removeScannedPackage(tx, { packageId: res.packageIds[0], actorId: "u1" }));
  // undo is blocked on a finished order, mirroring scanAllocation
  sqlite.prepare("UPDATE picking_orders SET status='finished'").run();
  assert.throws(
    () => db.transaction((tx) => removeScannedPackage(tx, { packageId: res.packageIds[1], actorId: "u1" })),
    (e: any) => e.status === 409
  );
  sqlite.prepare("UPDATE picking_orders SET status='picking'").run();
  db.transaction((tx) => removeScannedPackage(tx, { packageId: res.packageIds[1], actorId: "u1" }));

  const riis = sqlite.prepare("SELECT id, picked_qty, allocated_qty, available_qty FROM receiving_invoice_items ORDER BY id").all() as any[];
  assert.deepEqual(riis, [
    { id: "riiA", picked_qty: 0, allocated_qty: 25, available_qty: 0 },
    { id: "riiB", picked_qty: 0, allocated_qty: 15, available_qty: 10 },
  ]);
  assert.equal((sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any).qty, 40);
  const links = sqlite.prepare("SELECT receiving_invoice_item_id AS r, qty FROM allocation_receiving_items ORDER BY id").all() as any[];
  assert.deepEqual(links, [{ r: "riiA", qty: 25 }, { r: "riiB", qty: 15 }]);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM picking_packages").get() as any).c, 0);
  const pi = sqlite.prepare("SELECT scanned_not_boxed_qty, picked_qty, remaining_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { scanned_not_boxed_qty: 0, picked_qty: 0, remaining_qty: 40 });
  const removed = sqlite.prepare("SELECT from_status, to_status, actor_id FROM transition_logs WHERE entity_type='picking_item' AND to_status='removed'").all() as any[];
  assert.deepEqual(removed, [
    { from_status: "scanned", to_status: "removed", actor_id: "u1" },
    { from_status: "scanned", to_status: "removed", actor_id: "u1" },
  ]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("scan flips a pending order to picking and logs a transition", () => {
  const { sqlite, db } = makeDb();
  sqlite.prepare("UPDATE picking_orders SET status='pending'").run();
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot','p','S1',10,10,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot','0','0');
  `);
  db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 2, actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT status FROM picking_orders").get() as any).status, "picking");
  const logs = sqlite.prepare("SELECT entity_type, from_status, to_status, actor_id FROM transition_logs ORDER BY created_at").all() as any[];
  assert.deepEqual(logs, [
    { entity_type: "picking_order", from_status: "pending", to_status: "picking", actor_id: "u1" },
    { entity_type: "picking_item", from_status: "picking", to_status: "scanned", actor_id: "u1" },
  ]);
  sqlite.close();
});

test("scan guards: 404 missing allocation, 400 bad qty, 409 qty>allocation, 409 over-pick, 409 issue order", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot','p','S1',10,10,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',6,'lot','0','0');
  `);
  assert.throws(() => db.transaction((tx) => scanAllocation(tx, { allocationId: "nope", qty: 1 })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 0 })), (e: any) => e.status === 400);
  assert.throws(() => db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 7 })), (e: any) => e.status === 409); // > allocation 6
  // over-pick: item picked 5 + scanned 0 + 6 > qty 10
  sqlite.prepare("UPDATE picking_items SET picked_qty=5").run();
  assert.throws(() => db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 6 })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_items SET picked_qty=0").run();
  sqlite.prepare("UPDATE picking_orders SET status='issue'").run();
  assert.throws(() => db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 1 })), (e: any) => e.status === 409);
  sqlite.close();
});
