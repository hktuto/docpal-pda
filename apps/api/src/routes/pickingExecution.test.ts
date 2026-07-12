import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
const dbPath = path.join(dir, "t.sqlite");
process.env.DATABASE_URL = dbPath;
process.env.WAREHOUSE_SEED = "off";
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

test("box sub-routes enforce order/box ownership: wrong order or box is 404", async () => {
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot9','p','S1',10,10,'0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po9','pe9','R9','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi9','po9','p',10,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a9','pi9',10,'lot9','0','0');
  `);
  const created = await app.request("/picking-orders/po9/boxes", { method: "POST" });
  assert.equal(created.status, 201);
  const boxId = ((await created.json()) as { id: string }).id;

  const wrongOrderPack = await app.request(`/picking-orders/WRONG/boxes/${boxId}/packages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ package_id: "pp9" }),
  });
  assert.equal(wrongOrderPack.status, 404);

  const wrongOrderAddAll = await app.request(`/picking-orders/WRONG/boxes/${boxId}/add-all-unboxed`, { method: "POST" });
  assert.equal(wrongOrderAddAll.status, 404);

  sqlite.prepare(`INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
                  VALUES ('pp9','pi9','inventory_lot','lot9',4,?,'0','0')`).run(boxId);

  const wrongOrderDel = await app.request(`/picking-orders/WRONG/boxes/${boxId}/packages/pp9`, { method: "DELETE" });
  assert.equal(wrongOrderDel.status, 404);
  const wrongBoxDel = await app.request(`/picking-orders/po9/boxes/WRONGBOX/packages/pp9`, { method: "DELETE" });
  assert.equal(wrongBoxDel.status, 404);
  const okDel = await app.request(`/picking-orders/po9/boxes/${boxId}/packages/pp9`, { method: "DELETE" });
  assert.equal(okDel.status, 200);
});

// --- flat mutation routes (adapter doesn't know parent ids) ---

sqlite.exec(`
  INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('fp','FX','FX','0','0');
  INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('flot','fp','S1',10,10,'0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('fpo','fpe','FR','picking','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('fpi','fpo','fp',10,'0','0');
  INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('fa','fpi',10,'flot','0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('fpoF','fpeF','FRF','finished','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('fpiF','fpoF','fp',5,'0','0');
  INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('faF','fpiF',5,'flot','0','0');
`);

test("POST /allocations/:id/scan picks without an order id; 404 unknown; 409 finished order", async () => {
  const scan = await app.request("/allocations/fa/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: 3 }),
  });
  assert.equal(scan.status, 201);
  const body = (await scan.json()) as { package_ids: string[] };
  assert.equal(body.package_ids.length, 1);
  assert.equal((sqlite.prepare("SELECT total_qty FROM inventory_lots WHERE id='flot'").get() as any).total_qty, 7);

  const miss = await app.request("/allocations/nope/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: 1 }),
  });
  assert.equal(miss.status, 404);

  const finished = await app.request("/allocations/faF/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: 1 }),
  });
  assert.equal(finished.status, 409);
});

test("POST /packages/:id/add-to-box boxes a scanned package; 404 unknown package; 400 missing box_id", async () => {
  const scan = await app.request("/allocations/fa/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: 2 }),
  });
  const packageId = ((await scan.json()) as { package_ids: string[] }).package_ids[0];
  const created = await app.request("/picking-orders/fpo/boxes", { method: "POST" });
  const boxId = ((await created.json()) as { id: string }).id;

  const noBox = await app.request(`/packages/${packageId}/add-to-box`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(noBox.status, 400);

  const add = await app.request(`/packages/${packageId}/add-to-box`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ box_id: boxId }),
  });
  assert.equal(add.status, 200);
  assert.equal((sqlite.prepare("SELECT shipping_box_id FROM picking_packages WHERE id=?").get(packageId) as any).shipping_box_id, boxId);

  const miss = await app.request("/packages/nope/add-to-box", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ box_id: boxId }),
  });
  assert.equal(miss.status, 404);
});

test("DELETE /packages/:id removes a boxed package from its box or deletes an unboxed one", async () => {
  // boxed package -> removed from box (package survives, shipping_box_id NULL)
  const scan = await app.request("/allocations/fa/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: 2 }),
  });
  const boxedId = ((await scan.json()) as { package_ids: string[] }).package_ids[0];
  const created = await app.request("/picking-orders/fpo/boxes", { method: "POST" });
  const boxId = ((await created.json()) as { id: string }).id;
  await app.request(`/packages/${boxedId}/add-to-box`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ box_id: boxId }),
  });
  const unbox = await app.request(`/packages/${boxedId}`, { method: "DELETE" });
  assert.equal(unbox.status, 200);
  assert.deepEqual(await unbox.json(), { ok: true });
  assert.equal((sqlite.prepare("SELECT shipping_box_id FROM picking_packages WHERE id=?").get(boxedId) as any).shipping_box_id, null);

  // unboxed package -> deleted, lot restored
  const scan2 = await app.request("/allocations/fa/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: 2 }),
  });
  const unboxedId = ((await scan2.json()) as { package_ids: string[] }).package_ids[0];
  const lotBefore = (sqlite.prepare("SELECT total_qty FROM inventory_lots WHERE id='flot'").get() as any).total_qty;
  const del = await app.request(`/packages/${unboxedId}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM picking_packages WHERE id=?").get(unboxedId) as any).c, 0);
  assert.equal((sqlite.prepare("SELECT total_qty FROM inventory_lots WHERE id='flot'").get() as any).total_qty, lotBefore + 2);

  const miss = await app.request("/packages/nope", { method: "DELETE" });
  assert.equal(miss.status, 404);
});

test("POST /packages/:id/verify marks a boxed package verified; 409 when not in a box", async () => {
  sqlite.exec(`
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('fvbox','fpo','open','0','0');
    INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES ('fvmt','fpo','pending','0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
      VALUES ('fvpp','fpi','inventory_lot','flot',1,'fvbox','0','0'),
             ('fvpp2','fpi','inventory_lot','flot',1,NULL,'0','0');
  `);
  const notInBox = await app.request("/packages/fvpp2/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(notInBox.status, 409);
  assert.match(await notInBox.text(), /package is not in a box/);

  const ok = await app.request("/packages/fvpp/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal((sqlite.prepare("SELECT verified FROM picking_packages WHERE id='fvpp'").get() as any).verified, 1);

  const miss = await app.request("/packages/nope/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(miss.status, 404);
});

test("POST /shipping-boxes/:id/cancel deletes an empty open box (actor_id via query); 404 unknown", async () => {
  sqlite.exec(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('fcbox','fpo','open','0','0')`);
  const cancel = await app.request("/shipping-boxes/fcbox/cancel?actor_id=op1", { method: "POST" });
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { ok: true });
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM shipping_boxes WHERE id='fcbox'").get() as any).c, 0);
  const log = sqlite.prepare("SELECT actor_id FROM transition_logs WHERE entity_type='shipping_box' AND entity_id='fcbox'").get() as any;
  assert.equal(log.actor_id, "op1");

  const miss = await app.request("/shipping-boxes/nope/cancel", { method: "POST" });
  assert.equal(miss.status, 404);
  assert.match(await miss.text(), /shipping box not found/);
});

// --- read extensions (adapter needs these fields) ---

sqlite.exec(`
  INSERT INTO users (id, username, password_hash, role, name, created_at, updated_at) VALUES ('rxu1','rxreporter','h','operator','Reporter One','0','0');
  INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('rxp1','RX-P1','RX-P1','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('rxro1','rxroe1','RX-RO-1','in_hand','0','0');
  INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('rxlot1','rxp1','RXS1',10,2,'0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, issue_reason, issue_note, issue_qty, issue_pack_size, issue_remark, issue_reported_at, issue_reported_by, created_at, updated_at)
    VALUES ('rxpo1','rxpe1','RX-R1','issue','shortage','missing parts',3,10,'recount shelf','2026-01-01T00:00:00Z','rxu1','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, required_date_code, source_shelf_code, created_at, updated_at)
    VALUES ('rxpi1','rxpo1','rxp1',4,'DC-REQ','S-REQ','0','0'),
           ('rxpi2','rxpo1','rxp1',6,NULL,NULL,'0','0');
  INSERT INTO allocations (id, picking_item_id, qty, remark, inventory_lot_id, created_at, updated_at) VALUES ('rxa1','rxpi1',2,'alloc remark','rxlot1','0','0');
  INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at) VALUES ('rxa2','rxpi2',3,'rxro1','0','0');
  INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES ('rxmt1','rxpo1','pending','0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('rxpo2','rxpe2','RX-R2','picking','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('rxpi3','rxpo2','rxp1',7,'0','0');
`);

test("GET /picking-orders/:id returns issue fields, measuring task, and extended item/package/allocation keys", async () => {
  sqlite.exec(`
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, created_at, updated_at)
      VALUES ('rxpp1','rxpi1','inventory_lot','rxlot1',1,'2026-02-01T00:00:00Z','0');
  `);
  const res = await app.request("/picking-orders/rxpo1");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;

  assert.equal(d.order.issue_reason, "shortage");
  assert.equal(d.order.issue_note, "missing parts");
  assert.equal(d.order.issue_qty, 3);
  assert.equal(d.order.issue_pack_size, 10);
  assert.equal(d.order.issue_remark, "recount shelf");
  assert.equal(d.order.issue_reported_at, "2026-01-01T00:00:00Z");
  assert.equal(d.order.issue_reported_by, "rxu1");
  assert.equal(d.order.issue_reported_by_name, "Reporter One");

  assert.deepEqual(d.measuring_task, { id: "rxmt1", status: "pending" });

  assert.equal(d.items.length, 2);
  const item1 = d.items.find((i: any) => i.id === "rxpi1");
  assert.equal(item1.required_date_code, "DC-REQ");
  assert.equal(item1.source_shelf_code, "S-REQ");

  assert.equal(d.packages.length, 1);
  assert.equal(d.packages[0].created_at, "2026-02-01T00:00:00Z");

  const a1 = d.allocations.find((a: any) => a.id === "rxa1");
  assert.equal(a1.remark, "alloc remark");
  assert.equal(a1.lot.id, "rxlot1");
  assert.equal(a1.lot.part_id, "rxp1");
  assert.equal(a1.lot.shelf_code, "RXS1");

  const a2 = d.allocations.find((a: any) => a.id === "rxa2");
  assert.equal(a2.remark, null);
  assert.equal(a2.lot, null);
  assert.equal(a2.receiving_order_ref_no, "RX-RO-1");
});

test("GET /picking-orders/:id returns null issue fields and null measuring_task for a plain order", async () => {
  const res = await app.request("/picking-orders/rxpo2");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;
  assert.equal(d.order.issue_reason, null);
  assert.equal(d.order.issue_note, null);
  assert.equal(d.order.issue_qty, null);
  assert.equal(d.order.issue_pack_size, null);
  assert.equal(d.order.issue_remark, null);
  assert.equal(d.order.issue_reported_at, null);
  assert.equal(d.order.issue_reported_by, null);
  assert.equal(d.order.issue_reported_by_name, null);
  assert.equal(d.measuring_task, null);
  assert.equal(d.items[0].required_date_code, null);
  assert.equal(d.items[0].source_shelf_code, null);
});

test("GET /picking-orders includes total_qty summed over each order's items", async () => {
  const res = await app.request("/picking-orders?status=issue");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as any[];
  const o1 = rows.find((o: any) => o.id === "rxpo1");
  assert.equal(o1.total_qty, 10); // 4 + 6 across two items
  const all = (await (await app.request("/picking-orders?status=picking")).json()) as any[];
  const o2 = all.find((o: any) => o.id === "rxpo2");
  assert.equal(o2.total_qty, 7);
});

test("cleanup", () => { sqlite.close(); });
