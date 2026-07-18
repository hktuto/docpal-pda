import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../db/test-helper.js";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse_test";
process.env.WAREHOUSE_SEED = "off";
const { app } = await import("../index.js");
const { sql, db } = await createTestDb();

await db.execute(`
  INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES ('u','op','pw','Op','2026-01-01T00:00:00.000Z');
  INSERT INTO suppliers (id, code, name) VALUES ('sup','S','Sup');
  INSERT INTO receiving_orders (id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','RO-1','in_hand','sup','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  INSERT INTO shelves (code, location_type, created_at, updated_at) VALUES ('A1','shelf','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
`);

test("POST /receiving-orders/:id/shelf-boxes creates; DELETE /shelf-boxes/:id cancels; 404 missing shelf", async () => {
  const created = await app.request("/receiving-orders/ro/shelf-boxes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_code: "A1" }),
  });
  assert.equal(created.status, 201);
  const box = (await created.json()) as any;
  assert.match(box.id, /^SBOX-\d{4}$/);
  assert.equal(box.receiving_order_id, "ro");
  assert.equal(box.shelf_code, "A1");
  assert.equal(box.status, "open");
  assert.ok(box.created_at);
  const { id } = box;
  const del = await app.request(`/shelf-boxes/${id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const bad = await app.request("/receiving-orders/ro/shelf-boxes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_code: "ZZ" }),
  });
  assert.equal(bad.status, 404);
});

test("POST /put-away/scans records; remove-piece deletes; over-scan 409", async () => {
  await db.execute(`
    INSERT INTO parts (id, part_no) VALUES ('p','X');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
      VALUES ('inv','ro','INV-1','sup','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty)
      VALUES ('rii','inv','p',10,10);
  `);
  const created = await app.request("/put-away/scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_invoice_item_id: "rii", qty: 4 }),
  });
  assert.equal(created.status, 201);
  const scan = (await created.json()) as any;
  assert.ok(scan.id);
  assert.equal(scan.receiving_invoice_item_id, "rii");
  assert.equal(scan.qty, 4);
  assert.equal(scan.shelf_box_id, null);
  assert.equal(scan.verified, false);
  const { id } = scan;
  const over = await app.request("/put-away/scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_invoice_item_id: "rii", qty: 7 }),
  });
  assert.equal(over.status, 409);
  const del = await app.request(`/put-away/scans/${id}/remove-piece`, { method: "POST" });
  assert.equal(del.status, 200);
});

test("POST assign-to-box materializes lot; add-all-unboxed boxes the rest", async () => {
  await db.execute(`
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty)
      VALUES ('rii2','inv','p',5,5);
  `);
  const boxRes = await app.request("/receiving-orders/ro/shelf-boxes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_code: "A1" }),
  });
  const boxId = ((await boxRes.json()) as any).id;
  const scanRes = await app.request("/put-away/scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_invoice_item_id: "rii2", qty: 5 }),
  });
  const scanId = ((await scanRes.json()) as any).id;
  const assign = await app.request(`/put-away/scans/${scanId}/assign-to-box`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_box_id: boxId }),
  });
  assert.equal(assign.status, 200);
  assert.equal((await db.execute<{ total_qty: number }>(`SELECT total_qty FROM inventory_lots WHERE box_id='${boxId}'`))[0].total_qty, 5);

  const addAll = await app.request(`/shelf-boxes/${boxId}/add-all-unboxed`, { method: "POST" });
  assert.equal(addAll.status, 200);
});

test("POST close closes a non-empty box", async () => {
  const boxRes = await app.request("/receiving-orders/ro/shelf-boxes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_code: "A1" }),
  });
  const boxId = ((await boxRes.json()) as any).id;
  const scanRes = await app.request("/put-away/scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_invoice_item_id: "rii", qty: 2 }),
  });
  const scanId = ((await scanRes.json()) as any).id;
  await app.request(`/put-away/scans/${scanId}/assign-to-box`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_box_id: boxId }),
  });
  const close = await app.request(`/shelf-boxes/${boxId}/close`, { method: "POST" });
  assert.equal(close.status, 200);
  assert.equal((await db.execute<{ status: string }>(`SELECT status FROM shelf_boxes WHERE id='${boxId}'`))[0].status, "closed");
});

test("GET put-away read endpoints for a fresh order ro8", async () => {
  await db.execute(`
    INSERT INTO receiving_orders (id, ref_no, status, supplier_id, created_at, updated_at)
      VALUES ('ro8','RO-8','in_hand','sup','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
             ('ro8b','RO-8B','in_hand','sup','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
      VALUES ('inv8','ro8','INV-8','sup','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
             ('inv8b','ro8b','INV-8B','sup','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty)
      VALUES ('rii8','inv8','p',10,10), ('rii8b','inv8b','p',4,0);
    -- staging box for ro8 holding 3 unboxed pieces
    INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at)
      VALUES ('stage8','ro8',NULL,'open','2026-01-01T00:00:00.000Z');
    INSERT INTO shelf_box_items (id, shelf_box_id, receiving_invoice_item_id, part_id, qty, verified)
      VALUES ('sbi8u','stage8','rii8','p',3,false);
    -- real open box with 4 boxed pieces
    INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at)
      VALUES ('box8o','ro8','A1','open','2026-01-02T00:00:00.000Z');
    INSERT INTO shelf_box_items (id, shelf_box_id, receiving_invoice_item_id, part_id, qty, verified)
      VALUES ('sbi9b','box8o','rii8','p',4,true);
    -- closed empty box
    INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at)
      VALUES ('box8c','ro8','A1','closed','2026-01-01T00:00:00.000Z');
  `);

  // candidates: ro8 appears (available 10 + 3 unboxed), ro8b excluded
  const candRes = await app.request("/put-away/candidates");
  assert.equal(candRes.status, 200);
  const candidates = (await candRes.json()) as any[];
  const ro8 = candidates.find((r) => r.id === "ro8");
  assert.ok(ro8, "ro8 should be a candidate");
  assert.equal(ro8.available_qty, 10);
  assert.equal(ro8.unboxed_qty, 3);
  assert.ok(!candidates.some((r) => r.id === "ro8b"), "ro8b must be excluded");

  // put-away-lots: one lot row with scanned/boxed sums
  const lotsRes = await app.request("/receiving-orders/ro8/put-away-lots");
  assert.equal(lotsRes.status, 200);
  const lots = (await lotsRes.json()) as any[];
  assert.equal(lots.length, 1);
  assert.equal(lots[0].receiving_invoice_item_id, "rii8");
  assert.equal(lots[0].part_no, "X");
  assert.equal(lots[0].total_qty, 10);
  assert.equal(lots[0].available_qty, 10);
  assert.equal(lots[0].scanned_qty, 7);
  assert.equal(lots[0].boxed_qty, 4);

  // put-away-scans: both scans, newest (boxed) first by id DESC
  const scansRes = await app.request("/receiving-orders/ro8/put-away-scans");
  assert.equal(scansRes.status, 200);
  const scans = (await scansRes.json()) as any[];
  assert.equal(scans.length, 2);
  assert.equal(scans[0].id, "sbi9b");
  assert.equal(scans[0].part_id, "p");
  assert.equal(scans[0].shelf_box_id, "box8o");
  assert.equal(scans[0].verified, true);
  assert.equal(scans[1].id, "sbi8u");
  assert.equal(scans[1].shelf_box_id, null);

  // shelf-boxes: open box first, items grouped per box, staging box excluded
  const boxesRes = await app.request("/receiving-orders/ro8/shelf-boxes");
  assert.equal(boxesRes.status, 200);
  const boxes = (await boxesRes.json()) as any[];
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].id, "box8o");
  assert.equal(boxes[0].items.length, 1);
  assert.equal(boxes[0].items[0].part_no, "X");
  assert.equal(boxes[0].items[0].qty, 4);
  assert.equal(boxes[0].items[0].verified, true);
  assert.equal(boxes[1].id, "box8c");
  assert.equal(boxes[1].items.length, 0);

  const emptyRes = await app.request("/receiving-orders/ro8b/shelf-boxes");
  assert.equal(emptyRes.status, 200);
  assert.deepEqual(await emptyRes.json(), []);
});

test.after(async () => { await sql.end(); });
