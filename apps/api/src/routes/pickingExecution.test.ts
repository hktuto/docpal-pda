import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../db/test-helper.js";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse_test";
process.env.WAREHOUSE_SEED = "off";
const { app } = await import("../index.js");

const { sql, db } = await createTestDb();

async function seedPickable() {
  await db.execute(`
    INSERT INTO parts (id, part_no) VALUES ('p','X');
    INSERT INTO shelves (code, created_at, updated_at) VALUES ('S1', now(), now()) ON CONFLICT (code) DO NOTHING;
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty) VALUES ('lot','p','S1',10,10);
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po','R','picking',now(),now());
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, allocated_qty, created_at, updated_at) VALUES ('pi','po','p',10,10,now(),now());
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot',now(),now());
  `);
}

test("POST /picking-orders/:id/scan picks against the allocation; DELETE package undoes it", async () => {
  await seedPickable();
  const scan = await app.request("/picking-orders/po/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allocation_id: "a", qty: 4 }),
  });
  assert.equal(scan.status, 201);
  const body = (await scan.json()) as { package_ids: string[] };
  assert.equal(body.package_ids.length, 1);
  assert.equal((await db.execute<{ total_qty: number }>("SELECT total_qty FROM inventory_lots WHERE id='lot'"))[0].total_qty, 6);

  const del = await app.request(`/picking-orders/po/packages/${body.package_ids[0]}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  // lot restored, allocation restored, package gone
  assert.equal((await db.execute<{ total_qty: number }>("SELECT total_qty FROM inventory_lots WHERE id='lot'"))[0].total_qty, 10);
  assert.equal((await db.execute<{ qty: number }>("SELECT qty FROM allocations WHERE id='a'"))[0].qty, 10);
  assert.equal((await db.execute<{ c: number }>("SELECT COUNT(*)::int c FROM picking_packages"))[0].c, 0);
});

test("scan of an allocation from another order is 404; bad qty is 400", async () => {
  await db.execute(`
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po2','R2','picking',now(),now());
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi2','po2','p',10,now(),now());
  `);
  const cross = await app.request("/picking-orders/po2/scan", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ allocation_id: "a", qty: 1 }), // 'a' belongs to 'po'
  });
  assert.equal(cross.status, 404);
  assert.match(await cross.text(), /allocation not found in this order/);
  assert.equal((await db.execute<{ total_qty: number }>("SELECT total_qty FROM inventory_lots WHERE id='lot'"))[0].total_qty, 10);
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

test("GET /picking-orders orders finished-last, then delivery_date ASC (pglite parity)", async () => {
  await db.execute(`
    INSERT INTO picking_orders (id, ref_no, status, delivery_date, created_at, updated_at) VALUES
      ('orda','ORD-A','finished','2025-01-01',now(),now()),
      ('ordb','ORD-B','picking','2026-06-01',now(),now()),
      ('ordc','ORD-C','picking','2025-06-01',now(),now());
  `);
  const rows = (await (await app.request("/picking-orders")).json()) as any[];
  const idx = (id: string) => rows.findIndex((r) => r.id === id);
  assert.ok(idx("ordc") < idx("ordb"), "earlier delivery_date first among non-finished");
  assert.ok(idx("ordb") < idx("orda"), "finished sorts last regardless of delivery_date");
});

test("GET /picking-orders rows carry delivery_date + supplier_name (pglite parity)", async () => {
  await db.execute(`
    INSERT INTO suppliers (id, code, name) VALUES ('sup-l','SUP-L','List Supplier');
    INSERT INTO picking_orders (id, ref_no, status, delivery_date, supplier_id, created_at, updated_at) VALUES
      ('ords','ORD-S','picking','2026-03-04','sup-l',now(),now());
  `);
  const rows = (await (await app.request("/picking-orders?status=picking")).json()) as any[];
  const row = rows.find((r) => r.id === "ords");
  assert.ok(row, "seeded order present in list");
  assert.equal(row.delivery_date, "2026-03-04T00:00:00.000Z");
  assert.equal(row.supplier_name, "List Supplier");
  const plain = rows.find((r) => r.id === "ordb"); // no supplier_id
  assert.equal(plain.delivery_date, "2026-06-01T00:00:00.000Z");
  assert.equal(plain.supplier_name, null);
});

test("GET /picking-orders/:id resolves receiving-sourced allocations and excludes zero-qty residue", async () => {
  await db.execute(`
    INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('ro2','RO2','in_hand',now(),now());
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri2','ro2','INV-2',now(),now());
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, date_code) VALUES ('rii2','ri2','p',5,5,'DC1');
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po3','R3','picking',now(),now());
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi3','po3','p',5,now(),now());
    INSERT INTO allocations (id, picking_item_id, qty, receiving_invoice_item_id, created_at, updated_at) VALUES ('a3','pi3',5,'rii2',now(),now());
    -- audit residue: zero-qty allocation must be excluded from the detail response
    INSERT INTO allocations (id, picking_item_id, qty, receiving_invoice_item_id, created_at, updated_at) VALUES ('a4','pi3',0,'rii2',now(),now());
  `);
  const res = await app.request("/picking-orders/po3");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;
  assert.equal(d.allocations.length, 1);
  assert.equal(d.allocations[0].id, "a3");
  assert.equal(d.allocations[0].lot, null);
  assert.equal(d.allocations[0].receiving_invoice_item_id, "rii2");
  assert.equal(d.allocations[0].receiving_order_id, "ro2");
  assert.equal(d.allocations[0].receiving_items.length, 1);
  assert.equal(d.allocations[0].receiving_items[0].receiving_invoice_item_id, "rii2");
  assert.equal(d.allocations[0].receiving_items[0].invoice_no, "INV-2");
  assert.equal(d.allocations[0].receiving_items[0].qty, 5);
  assert.equal(d.allocations[0].receiving_items[0].date_code, "DC1");
});

test("box sub-routes enforce order/box ownership: wrong order or box is 404", async () => {
  await db.execute(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty) VALUES ('lot9','p','S1',10,10);
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po9','R9','picking',now(),now());
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi9','po9','p',10,now(),now());
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a9','pi9',10,'lot9',now(),now());
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

  await db.execute(`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
                  VALUES ('pp9','pi9','po9','inventory_lot','lot9',4,'${boxId}',now(),now())`);

  const wrongOrderDel = await app.request(`/picking-orders/WRONG/boxes/${boxId}/packages/pp9`, { method: "DELETE" });
  assert.equal(wrongOrderDel.status, 404);
  const wrongBoxDel = await app.request(`/picking-orders/po9/boxes/WRONGBOX/packages/pp9`, { method: "DELETE" });
  assert.equal(wrongBoxDel.status, 404);
  const okDel = await app.request(`/picking-orders/po9/boxes/${boxId}/packages/pp9`, { method: "DELETE" });
  assert.equal(okDel.status, 200);
});

// --- flat mutation routes (adapter doesn't know parent ids) ---

await db.execute(`
  INSERT INTO shelves (code, created_at, updated_at) VALUES ('S1', now(), now()) ON CONFLICT (code) DO NOTHING;
  INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES ('op1','op1','h','Op1',now());
  INSERT INTO parts (id, part_no) VALUES ('fp','FX');
  INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty) VALUES ('flot','fp','S1',10,10);
  INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('fpo','FR','picking',now(),now());
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('fpi','fpo','fp',10,now(),now());
  INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('fa','fpi',10,'flot',now(),now());
  INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('fpoF','FRF','finished',now(),now());
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('fpiF','fpoF','fp',5,now(),now());
  INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('faF','fpiF',5,'flot',now(),now());
`);

test("POST /allocations/:id/scan picks without an order id; 404 unknown; 409 finished order", async () => {
  const scan = await app.request("/allocations/fa/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: 3 }),
  });
  assert.equal(scan.status, 201);
  const body = (await scan.json()) as { package_ids: string[] };
  assert.equal(body.package_ids.length, 1);
  assert.equal((await db.execute<{ total_qty: number }>("SELECT total_qty FROM inventory_lots WHERE id='flot'"))[0].total_qty, 7);

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
  assert.equal((await db.execute<{ shipping_box_id: string }>(`SELECT shipping_box_id FROM picking_packages WHERE id='${packageId}'`))[0].shipping_box_id, boxId);

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
  assert.equal((await db.execute<{ shipping_box_id: string | null }>(`SELECT shipping_box_id FROM picking_packages WHERE id='${boxedId}'`))[0].shipping_box_id, null);

  // unboxed package -> deleted, lot restored
  const scan2 = await app.request("/allocations/fa/scan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qty: 2 }),
  });
  const unboxedId = ((await scan2.json()) as { package_ids: string[] }).package_ids[0];
  const lotBefore = (await db.execute<{ total_qty: number }>("SELECT total_qty FROM inventory_lots WHERE id='flot'"))[0].total_qty;
  const del = await app.request(`/packages/${unboxedId}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true });
  assert.equal((await db.execute<{ c: number }>(`SELECT COUNT(*)::int c FROM picking_packages WHERE id='${unboxedId}'`))[0].c, 0);
  assert.equal((await db.execute<{ total_qty: number }>(`SELECT total_qty FROM inventory_lots WHERE id='flot'`))[0].total_qty, lotBefore + 2);

  const miss = await app.request("/packages/nope", { method: "DELETE" });
  assert.equal(miss.status, 404);
});

test("POST /packages/:id/verify marks a boxed package verified; 409 when not in a box", async () => {
  await db.execute(`
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('fvbox','fpo','open',now(),now());
    INSERT INTO measuring_tasks (id, picking_order_id, status, created_at) VALUES ('fvmt','fpo','pending',now());
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
      VALUES ('fvpp','fpi','fpo','inventory_lot','flot',1,'fvbox',now(),now()),
             ('fvpp2','fpi','fpo','inventory_lot','flot',1,NULL,now(),now());
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
  assert.equal((await db.execute<{ verified: boolean }>("SELECT verified FROM picking_packages WHERE id='fvpp'"))[0].verified, true);

  const miss = await app.request("/packages/nope/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(miss.status, 404);
});

test("POST /shipping-boxes/:id/cancel deletes an empty open box (actor_id via query); 404 unknown", async () => {
  await db.execute(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('fcbox','fpo','open',now(),now())`);
  const cancel = await app.request("/shipping-boxes/fcbox/cancel?actor_id=op1", { method: "POST" });
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { ok: true });
  assert.equal((await db.execute<{ c: number }>("SELECT COUNT(*)::int c FROM shipping_boxes WHERE id='fcbox'"))[0].c, 0);
  const log = (await db.execute<{ actor_id: string }>("SELECT actor_id FROM transaction_logs WHERE entity_type='shipping_box' AND entity_id='fcbox'"))[0];
  assert.equal(log.actor_id, "op1");

  const miss = await app.request("/shipping-boxes/nope/cancel", { method: "POST" });
  assert.equal(miss.status, 404);
  assert.match(await miss.text(), /shipping box not found/);
});

// --- read extensions (adapter needs these fields) ---

await db.execute(`
  INSERT INTO users (id, username, password_hash, role, display_name, created_at) VALUES ('rxu1','rxreporter','h','operator','Reporter One',now());
  INSERT INTO parts (id, part_no) VALUES ('rxp1','RX-P1');
  INSERT INTO shelves (code, created_at, updated_at) VALUES ('RXS1', now(), now()) ON CONFLICT (code) DO NOTHING;
  INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('rxro1','RX-RO-1','in_hand',now(),now());
  INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('rxri1','rxro1','RX-INV-1',now(),now());
  INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty) VALUES ('rxrii1','rxri1','rxp1',3,3);
  INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty) VALUES ('rxlot1','rxp1','RXS1',10,2);
  INSERT INTO picking_orders (id, ref_no, status, issue_reason, issue_note, issue_qty, issue_pack_size, issue_remark, issue_reported_at, issue_reported_by, created_at, updated_at)
    VALUES ('rxpo1','RX-R1','issue','shortage','missing parts',3,10,'recount shelf','2026-01-01T00:00:00Z','rxu1',now(),now());
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, required_date_code, source_shelf_code, created_at, updated_at)
    VALUES ('rxpi1','rxpo1','rxp1',4,'DC-REQ','S-REQ',now(),now()),
           ('rxpi2','rxpo1','rxp1',6,NULL,NULL,now(),now());
  INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('rxa1','rxpi1',2,'rxlot1',now(),now());
  INSERT INTO allocations (id, picking_item_id, qty, receiving_invoice_item_id, created_at, updated_at) VALUES ('rxa2','rxpi2',3,'rxrii1',now(),now());
  INSERT INTO measuring_tasks (id, picking_order_id, status, created_at) VALUES ('rxmt1','rxpo1','pending',now());
  INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('rxpo2','RX-R2','picking',now(),now());
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('rxpi3','rxpo2','rxp1',7,now(),now());
`);

test("GET /picking-orders/:id returns issue fields, measuring task, and extended item/package/allocation keys", async () => {
  await db.execute(`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, created_at, updated_at)
      VALUES ('rxpp1','rxpi1','rxpo1','inventory_lot','rxlot1',1,'2026-02-01T00:00:00Z',now());
  `);
  const res = await app.request("/picking-orders/rxpo1");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;

  assert.equal(d.order.issue_reason, "shortage");
  assert.equal(d.order.issue_note, "missing parts");
  assert.equal(d.order.issue_qty, 3);
  assert.equal(d.order.issue_pack_size, 10);
  assert.equal(d.order.issue_remark, "recount shelf");
  assert.equal(d.order.issue_reported_at, "2026-01-01T00:00:00.000Z");
  assert.equal(d.order.issue_reported_by, "rxu1");
  assert.equal(d.order.issue_reported_by_name, "Reporter One");

  assert.deepEqual(d.measuring_task, { id: "rxmt1", status: "pending" });

  assert.equal(d.items.length, 2);
  const item1 = d.items.find((i: any) => i.id === "rxpi1");
  assert.equal(item1.required_date_code, "DC-REQ");
  assert.equal(item1.source_shelf_code, "S-REQ");

  assert.equal(d.packages.length, 1);
  assert.equal(d.packages[0].created_at, "2026-02-01T00:00:00.000Z");

  const a1 = d.allocations.find((a: any) => a.id === "rxa1");
  assert.equal(a1.inventory_lot_id, "rxlot1");
  assert.equal(a1.lot.id, "rxlot1");
  assert.equal(a1.lot.part_id, "rxp1");
  assert.equal(a1.lot.shelf_code, "RXS1");

  const a2 = d.allocations.find((a: any) => a.id === "rxa2");
  assert.equal(a2.receiving_invoice_item_id, "rxrii1");
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
  assert.equal(d.order.po_no, null);
  assert.equal(d.order.required_date_code_notice, null);
  assert.equal(d.items[0].required_date_code, null);
  assert.equal(d.items[0].source_shelf_code, null);
});

test("GET /picking-orders/:id returns supplier and delivery_date via the suppliers join", async () => {
  await db.execute(`
    INSERT INTO suppliers (id, code, name) VALUES ('supx','SUPX','Sup X');
    INSERT INTO picking_orders (id, ref_no, status, delivery_date, supplier_id, po_no, required_date_code_notice, created_at, updated_at)
      VALUES ('pox','POX','picking','2026-07-13T00:00:00.000Z','supx','1180200993STD','notice-x',now(),now());
  `);
  const res = await app.request("/picking-orders/pox");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;
  assert.equal(d.order.delivery_date, "2026-07-13T00:00:00.000Z");
  assert.equal(d.order.po_no, "1180200993STD");
  assert.equal(d.order.required_date_code_notice, "notice-x");
  assert.equal(d.order.supplier_id, "supx");
  assert.equal(d.order.supplier_code, "SUPX");
  assert.equal(d.order.supplier_name, "Sup X");
  // an order without a supplier gets nulls, not a 500
  const plain = (await (await app.request("/picking-orders/rxpo2")).json()) as any;
  assert.equal(plain.order.supplier_id, null);
  assert.equal(plain.order.supplier_name, null);
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

test.after(async () => { await sql.end(); });
