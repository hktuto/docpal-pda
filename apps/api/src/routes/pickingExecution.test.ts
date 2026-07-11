import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
const dbPath = path.join(dir, "t.sqlite");
process.env.DATABASE_URL = dbPath;
const { app } = await import("../index.js");

const sqlite = new Database(dbPath);

function seedPickable() {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot','p','S1',10,10,'0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','pe','R','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot','0','0');
  `);
}

test("POST /picking-orders/:id/scan picks against the allocation; DELETE package undoes it", async () => {
  seedPickable();
  const scan = await app.request("/picking-orders/po/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allocation_id: "a", qty: 4 }),
  });
  assert.equal(scan.status, 201);
  const body = (await scan.json()) as { package_ids: string[] };
  assert.equal(body.package_ids.length, 1);
  assert.equal((sqlite.prepare("SELECT total_qty FROM inventory_lots WHERE id='lot'").get() as any).total_qty, 6);

  const del = await app.request(`/picking-orders/po/packages/${body.package_ids[0]}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  // lot restored, allocation restored, package gone
  assert.equal((sqlite.prepare("SELECT total_qty FROM inventory_lots WHERE id='lot'").get() as any).total_qty, 10);
  assert.equal((sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any).qty, 10);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM picking_packages").get() as any).c, 0);
});

test("scan of an allocation from another order is 404; bad qty is 400", async () => {
  sqlite.exec(`
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po2','pe2','R2','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi2','po2','p',10,'0','0');
  `);
  const cross = await app.request("/picking-orders/po2/scan", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ allocation_id: "a", qty: 1 }), // 'a' belongs to 'po'
  });
  assert.equal(cross.status, 404);
  assert.match(await cross.text(), /allocation not found in this order/);
  assert.equal((sqlite.prepare("SELECT total_qty FROM inventory_lots WHERE id='lot'").get() as any).total_qty, 10);
  const bad = await app.request("/picking-orders/po/scan", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ allocation_id: "a", qty: -1 }),
  });
  assert.equal(bad.status, 400);
});

test("GET /picking-orders/:id returns detail with items, allocations, packages, boxes", async () => {
  const res = await app.request("/picking-orders/po");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;
  assert.equal(d.order.ref_no, "R");
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].part_no, "X");
  assert.equal(d.items[0].qty, 10);
  assert.equal(d.items[0].remaining_qty, 10);
  assert.equal(d.items[0].allocated_qty, 10);
  assert.equal(d.allocations.length, 1);
  assert.equal(d.allocations[0].qty, 10);
  assert.equal(d.allocations[0].lot.shelf_code, "S1");
  assert.deepEqual(d.allocations[0].receiving_items, []);
  assert.deepEqual(d.packages, []);
  assert.deepEqual(d.boxes, []);
  const missing = await app.request("/picking-orders/nope");
  assert.equal(missing.status, 404);
});

test("GET /picking-orders filters by status and updated_since", async () => {
  const all = await app.request("/picking-orders");
  assert.equal(all.status, 200);
  assert.equal(((await all.json()) as any[]).length >= 1, true);
  const picking = await app.request("/picking-orders?status=picking");
  const pickingRows = (await picking.json()) as any[];
  assert.equal(pickingRows.length >= 1, true);
  assert.equal(pickingRows.every((o: any) => o.status === "picking"), true);
  const future = await app.request("/picking-orders?updated_since=2999-01-01T00:00:00.000Z");
  assert.deepEqual(await future.json(), []);
});

test("GET /picking-orders/:id resolves receiving-sourced allocations and excludes zero-qty residue", async () => {
  sqlite.exec(`
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro2','roe2','RO2','in_hand','0','0');
    INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri2','rie2','ro2','INV-2','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, allocated_qty, available_qty, date_code_norm, created_at, updated_at) VALUES ('rii2','ri2','p',5,5,5,0,'DC1','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po3','pe3','R3','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi3','po3','p',5,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at) VALUES ('a3','pi3',5,'ro2','0','0');
    INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at) VALUES ('ari3','a3','rii2',5,'0','0');
    -- audit residue: zero-qty allocation and link must be excluded from the detail response
    INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at) VALUES ('a4','pi3',0,'ro2','0','0');
    INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at) VALUES ('ari4','a4','rii2',0,'0','0');
  `);
  const res = await app.request("/picking-orders/po3");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;
  assert.equal(d.allocations.length, 1);
  assert.equal(d.allocations[0].id, "a3");
  assert.equal(d.allocations[0].lot, null);
  assert.equal(d.allocations[0].receiving_order_id, "ro2");
  assert.equal(d.allocations[0].receiving_items.length, 1);
  assert.equal(d.allocations[0].receiving_items[0].invoice_no, "INV-2");
  assert.equal(d.allocations[0].receiving_items[0].qty, 5);
  assert.equal(d.allocations[0].receiving_items[0].date_code_norm, "DC1");
});

test("cleanup", () => { sqlite.close(); });
