import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { applyOcrPick } from "./ocrPick.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO users (id, username, password_hash, role, name, created_at, updated_at)
      VALUES ('op8','op8','h','operator','Op8','0','0');
    INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup8','SUP8','Sup 8','0','0');
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES
      ('p8','P8','P8','0','0'),
      ('p8other','P8OTHER','P8OTHER','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, delivery_date, status, supplier_id, created_at, updated_at) VALUES
      ('ro8','e8','R8','2026-07-01','in_hand','sup8','0','0'),
      ('ro8b','e8b','R8B','2026-07-02','pending','sup8','0','0'),
      ('ro8c','e8c','R8C','2026-07-03','in_hand','sup8','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES
      ('inv8a','ro8','INV8A','0','0'),
      ('inv8b','ro8','INV8B','0','0'),
      ('inv8p','ro8b','INV8P','0','0'),
      ('inv8c','ro8c','INV8C','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, date_code, created_at, updated_at) VALUES
      ('rii8a','inv8a','p8',6,6,6,'D1','0','0'),
      ('rii8b','inv8b','p8',6,6,6,'D2','0','0'),
      ('rii8p','inv8p','p8',6,6,6,'D1','0','0'),
      ('rii8c','inv8c','p8',5,5,5,'D1','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES
      ('po8','pe8','PR8','pending','0','0'),
      ('po8c','pe8c','PR8C','pending','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES
      ('pi8','po8','p8',10,'0','0'),
      ('pi8b','po8','p8other',10,'0','0'),
      ('pi8c','po8c','p8',20,'0','0');
  `);
  return { sqlite, db };
}

test("ocr pick allocates FIFO across invoice items, scans one package per link, flips order to picking", () => {
  const { sqlite, db } = makeDb();
  const res = db.transaction((tx) =>
    applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 8, actorId: "op8" })
  );
  assert.equal(res.packageIds.length, 2); // 6 from rii8a + 2 from rii8b

  const pkgs = sqlite
    .prepare("SELECT source_type, source_id, qty, date_code, shipping_box_id FROM picking_packages ORDER BY source_id")
    .all() as any[];
  assert.deepEqual(pkgs, [
    { source_type: "receiving_invoice_item", source_id: "rii8a", qty: 6, date_code: "D1", shipping_box_id: null },
    { source_type: "receiving_invoice_item", source_id: "rii8b", qty: 2, date_code: "D2", shipping_box_id: null },
  ]);

  // The order-level allocation was created for 8 and fully consumed by the scan.
  const allocs = sqlite
    .prepare("SELECT id, qty, inventory_lot_id, receiving_order_id FROM allocations WHERE picking_item_id='pi8'")
    .all() as any[];
  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].receiving_order_id, "ro8");
  assert.equal(allocs[0].inventory_lot_id, null);
  assert.equal(allocs[0].qty, 0);
  const links = sqlite
    .prepare("SELECT receiving_invoice_item_id AS r, qty FROM allocation_receiving_items ORDER BY receiving_invoice_item_id")
    .all() as any[];
  assert.deepEqual(links, [{ r: "rii8a", qty: 0 }, { r: "rii8b", qty: 0 }]);

  const riis = sqlite
    .prepare("SELECT id, picked_qty, allocated_qty, available_qty FROM receiving_invoice_items WHERE id IN ('rii8a','rii8b') ORDER BY id")
    .all() as any[];
  assert.deepEqual(riis, [
    { id: "rii8a", picked_qty: 6, allocated_qty: 0, available_qty: 0 },
    { id: "rii8b", picked_qty: 2, allocated_qty: 0, available_qty: 4 },
  ]);

  const pi = sqlite
    .prepare("SELECT scanned_not_boxed_qty, picked_qty, remaining_qty FROM picking_items WHERE id='pi8'")
    .get() as any;
  assert.deepEqual(pi, { scanned_not_boxed_qty: 8, picked_qty: 0, remaining_qty: 2 });

  assert.equal((sqlite.prepare("SELECT status FROM picking_orders WHERE id='po8'").get() as any).status, "picking");
  const logs = (sqlite
    .prepare("SELECT entity_type, from_status, to_status, actor_id FROM transition_logs")
    .all() as any[]).sort((a, b) => a.entity_type.localeCompare(b.entity_type));
  assert.deepEqual(logs, [
    { entity_type: "picking_item", from_status: "picking", to_status: "scanned", actor_id: "op8" },
    { entity_type: "picking_order", from_status: "pending", to_status: "picking", actor_id: "op8" },
  ]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("second ocr pick tops up the existing allocation row instead of creating a new one", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 8, actorId: "op8" }));
  const before = (sqlite.prepare("SELECT COUNT(*) c FROM allocations").get() as any).c;
  const res = db.transaction((tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 2, actorId: "op8" }));
  assert.equal(res.packageIds.length, 1); // 2 from rii8b
  const after = (sqlite.prepare("SELECT COUNT(*) c FROM allocations").get() as any).c;
  assert.equal(after, before);

  const pkg = sqlite.prepare("SELECT source_id, qty FROM picking_packages ORDER BY created_at DESC, id DESC LIMIT 1").get() as any;
  assert.deepEqual(pkg, { source_id: "rii8b", qty: 2 });
  const pi = sqlite
    .prepare("SELECT scanned_not_boxed_qty, picked_qty, remaining_qty FROM picking_items WHERE id='pi8'")
    .get() as any;
  assert.deepEqual(pi, { scanned_not_boxed_qty: 10, picked_qty: 0, remaining_qty: 0 });
  const rii = sqlite.prepare("SELECT picked_qty, available_qty FROM receiving_invoice_items WHERE id='rii8b'").get() as any;
  assert.deepEqual(rii, { picked_qty: 4, available_qty: 2 });
  assertInvariantsHold(db);
  sqlite.close();
});

test("ocr pick rejects qty beyond the remaining picking need with 409", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 10, actorId: "op8" }));
  assert.throws(
    () => db.transaction((tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 1, actorId: "op8" })),
    (e: any) => e.status === 409
  );
  sqlite.close();
});

test("ocr pick guards: part not on RO 409, qty 0 400, unknown picking item 404, RO not in_hand 409", () => {
  const { sqlite, db } = makeDb();
  assert.throws(
    () => db.transaction((tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8b", qty: 1, actorId: "op8" })),
    (e: any) => e.status === 409
  );
  assert.throws(
    () => db.transaction((tx) => applyOcrPick(tx, "ro8", { pickingItemId: "pi8", qty: 0, actorId: "op8" })),
    (e: any) => e.status === 400
  );
  assert.throws(
    () => db.transaction((tx) => applyOcrPick(tx, "ro8", { pickingItemId: "nope", qty: 1, actorId: "op8" })),
    (e: any) => e.status === 404
  );
  assert.throws(
    () => db.transaction((tx) => applyOcrPick(tx, "ro8b", { pickingItemId: "pi8", qty: 1, actorId: "op8" })),
    (e: any) => e.status === 409
  );
  assert.throws(
    () => db.transaction((tx) => applyOcrPick(tx, "nope", { pickingItemId: "pi8", qty: 1, actorId: "op8" })),
    (e: any) => e.status === 404
  );
  // Guards must not mutate state.
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM picking_packages").get() as any).c, 0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM allocations").get() as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("ocr pick rejects qty beyond the RO's part-level availability with 409", () => {
  const { sqlite, db } = makeDb();
  // ro8c has 5 available of p8; pi8c needs 20, so the remaining check passes but availability fails.
  assert.throws(
    () => db.transaction((tx) => applyOcrPick(tx, "ro8c", { pickingItemId: "pi8c", qty: 6, actorId: "op8" })),
    (e: any) => e.status === 409
  );
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM picking_packages").get() as any).c, 0);
  assert.equal((sqlite.prepare("SELECT status FROM picking_orders WHERE id='po8c'").get() as any).status, "pending");
  assertInvariantsHold(db);
  sqlite.close();
});
