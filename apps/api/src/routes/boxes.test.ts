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

sqlite.exec(`
  INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at)
    VALUES ('po','e','R','finished','HK','HK','0','0');
  INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0');
`);

test("PATCH /shipping-boxes/:id sets measurements; 404 missing; 400 bad json", async () => {
  const res = await app.request("/shipping-boxes/box", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ box_size: "S", net_weight_g: "500", gross_weight_g: 900 }),
  });
  assert.equal(res.status, 200);
  const row = sqlite.prepare("SELECT box_size, net_weight_g, gross_weight_g FROM shipping_boxes WHERE id='box'").get() as any;
  assert.deepEqual(row, { box_size: "S", net_weight_g: 500, gross_weight_g: 900 });

  const missing = await app.request("/shipping-boxes/nope", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ box_size: "S" }),
  });
  assert.equal(missing.status, 404);
  const bad = await app.request("/shipping-boxes/box", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400);
});

test("POST /shipping-boxes/:id/verify-package verifies; wrong box 404; missing package_id 400", async () => {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('pi','po','p',4,4,'0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
      VALUES ('pp','pi','inventory_lot','lot',4,'box','0','0');
    INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES ('mt','po','pending','0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box2','po','open','0','0');
  `);
  const ok = await app.request("/shipping-boxes/box/verify-package", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ package_id: "pp" }),
  });
  assert.equal(ok.status, 200);
  assert.equal((sqlite.prepare("SELECT verified FROM picking_packages WHERE id='pp'").get() as any).verified, 1);

  const wrong = await app.request("/shipping-boxes/box2/verify-package", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ package_id: "pp" }),
  });
  assert.equal(wrong.status, 404);
  const bad = await app.request("/shipping-boxes/box/verify-package", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
});

test("POST /shipping-boxes/:id/close closes a ready box; 409 when unverified", async () => {
  // seed a second self-contained box for this test.
  sqlite.exec(`
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('piC','po','p',2,2,'0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, box_size, net_weight_g, gross_weight_g, destination_country, created_at, updated_at)
      VALUES ('boxC','po','open','M',100,200,'HK','0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, verified, created_at, updated_at)
      VALUES ('ppC','piC','inventory_lot','lot',2,'boxC',1,'0','0');
  `);
  const ok = await app.request("/shipping-boxes/boxC/close", { method: "POST" });
  assert.equal(ok.status, 200);
  assert.equal((sqlite.prepare("SELECT status FROM shipping_boxes WHERE id='boxC'").get() as any).status, "closed");

  sqlite.exec(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('boxU','po','open','0','0');
               INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, verified, created_at, updated_at)
                 VALUES ('ppU','piC','inventory_lot','lot',1,'boxU',0,'0','0');`);
  const bad = await app.request("/shipping-boxes/boxU/close", { method: "POST" });
  assert.equal(bad.status, 409);
});

test("GET /shipping-boxes/:id/for-measuring returns box, order, task, packages", async () => {
  const res = await app.request("/shipping-boxes/box/for-measuring");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;
  assert.equal(d.box.picking_order_id, "po");
  assert.equal(d.order.ref_no, "R");
  assert.ok(Array.isArray(d.packages));
  const missing = await app.request("/shipping-boxes/nope/for-measuring");
  assert.equal(missing.status, 404);
});

test("cleanup", () => { sqlite.close(); });
