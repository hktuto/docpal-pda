import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { scanAllocation, removeScannedPackage, finishPickingOrder } from "./pickScan.js";
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

test("undo a lot-scan restores lot + allocation + removes package", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot','p','S1',10,10,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot','0','0');
  `);
  const { packageIds } = db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 4 }));
  db.transaction((tx) => removeScannedPackage(tx, { packageId: packageIds[0], actorId: "u1" }));
  assert.deepEqual(sqlite.prepare("SELECT total_qty, allocated_qty FROM inventory_lots WHERE id='lot'").get() as any, { total_qty: 10, allocated_qty: 10 });
  assert.equal((sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any).qty, 10);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM picking_packages").get() as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("undo a receiving-portion scan restores picked_qty, link qty and allocation", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e','R','in_hand','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, allocated_qty, available_qty, created_at, updated_at)
      VALUES ('rii','ri','p',10,10,10,0,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at) VALUES ('a','pi',10,'ro','0','0');
    INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at) VALUES ('l','a','rii',10,'0','0');
  `);
  const { packageIds } = db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 4 }));
  db.transaction((tx) => removeScannedPackage(tx, { packageId: packageIds[0] }));
  assert.deepEqual(
    sqlite.prepare("SELECT picked_qty, allocated_qty, available_qty FROM receiving_invoice_items WHERE id='rii'").get() as any,
    { picked_qty: 0, allocated_qty: 10, available_qty: 0 }
  );
  assert.equal((sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any).qty, 10);
  assert.equal((sqlite.prepare("SELECT qty FROM allocation_receiving_items WHERE id='l'").get() as any).qty, 10);
  assertInvariantsHold(db);
  sqlite.close();
});

test("undo guards: 404 missing package, 409 boxed package", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0')`);
  sqlite.exec(`INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
               VALUES ('pp','pi','inventory_lot','lot',1,'box','0','0')`);
  assert.throws(() => db.transaction((tx) => removeScannedPackage(tx, { packageId: "nope" })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => removeScannedPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  sqlite.close();
});

test("finishPickingOrder: finishes a fully-picked order; 409 when not fully picked; 404 missing", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => finishPickingOrder(tx, { pickingOrderId: "nope" })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => finishPickingOrder(tx, { pickingOrderId: "po" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_items SET picked_qty=10").run();
  db.transaction((tx) => finishPickingOrder(tx, { pickingOrderId: "po" }));
  assert.equal((sqlite.prepare("SELECT status FROM picking_orders").get() as any).status, "finished");
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM measuring_tasks WHERE picking_order_id='po'").get() as any).c, 1);
  sqlite.close();
});
