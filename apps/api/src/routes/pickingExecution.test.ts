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

test("cleanup", () => { sqlite.close(); });
