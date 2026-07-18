import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../db/test-helper.js";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://warehouse:warehouse@localhost:5432/warehouse_test";
process.env.WAREHOUSE_SEED = "off";
const { app } = await import("../index.js");
const { sql, db } = await createTestDb();

await db.execute(`
  INSERT INTO suppliers (id, code, name, qr_template, qrcode_qty_encoding, created_at, updated_at)
    VALUES ('sup4','S4','Sup Four','tpl-{qty}','plain','0','0');
  INSERT INTO parts (id, part_no, part_no_norm, description, created_at, updated_at)
    VALUES ('p4','P4','P4','Part four','0','0'), ('p4b','P4B','P4B','Part four B','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, delivery_date, status, supplier_id, created_at, updated_at)
    VALUES ('ro4','e4','RO-4','2026-01-15','in_hand','sup4','0','0');
  INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
    VALUES ('inv4','e4','ro4','INV-4','sup4','0','0');
  INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
    VALUES ('rii4a','inv4','p4',10,10,10,'0','0'), ('rii4b','inv4','p4b',5,5,0,'0','0');
  INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, verified, created_at, updated_at)
    VALUES ('pas4','rii4a',3,NULL,false,'0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at)
    VALUES ('po4','e4','PO-4','pending','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at)
    VALUES ('pi4','po4','p4',2,'0','0');
  INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at)
    VALUES ('al4','pi4',2,'ro4','0','0');
  INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at)
    VALUES ('ari4','al4','rii4a',2,'0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at)
    VALUES ('po4b','e4b','PO-4B','pending','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at)
    VALUES ('pi4b','po4b','p4',3,'0','0');
  INSERT INTO inventory_lots (id, part_id, total_qty, allocated_qty, created_at, updated_at)
    VALUES ('lot4','p4',5,3,'0','0');
  INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at)
    VALUES ('al4b','pi4b',3,'lot4','0','0');
  INSERT INTO inventory_lot_sources (id, inventory_lot_id, receiving_invoice_item_id, qty, created_at, updated_at)
    VALUES ('ils4a','lot4','rii4a',3,'0','0'), ('ils4b','lot4','rii4a',2,'0','0');
  INSERT INTO receiving_item_mismatches (id, receiving_invoice_item_id, kind, note, status, created_at, updated_at)
    VALUES ('rim4old','rii4b','qty','old note','pending','2026-01-01T00:00:00.000Z','0'),
           ('rim4new','rii4b','qty','new note','pending','2026-01-02T00:00:00.000Z','0'),
           ('rim4cancelled','rii4b','qty','cancelled note','cancelled','2026-01-03T00:00:00.000Z','0');
`);

test("GET /receiving-orders lists orders with remaining items and pending picking counts", async () => {
  const res = await app.request("/receiving-orders");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as any[];
  const ro4 = rows.find((r) => r.id === "ro4");
  assert.ok(ro4, "ro4 should be listed");
  assert.equal(ro4.ref_no, "RO-4");
  assert.equal(ro4.status, "in_hand");
  assert.equal(ro4.delivery_date, "2026-01-15");
  assert.equal(ro4.supplier_name, "Sup Four");
  assert.equal(ro4.remaining_items, 1); // rii4a: 10-3 > 0; rii4b: available 0
  // po4 via direct ro allocation + ari link; po4b via lot sources (two rows -> COUNT DISTINCT dedups)
  assert.equal(ro4.pending_picking_orders, 2);
});

test("GET /receiving-orders?status=pending filters out in_hand orders", async () => {
  const res = await app.request("/receiving-orders?status=pending");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as any[];
  assert.deepEqual(Array.from(rows), []);
});

test("GET /receiving-orders orders by delivery_date, not ref_no (pglite parity)", async () => {
  await db.execute(`
    INSERT INTO receiving_orders (id, external_id, ref_no, delivery_date, status, created_at, updated_at) VALUES
      ('ordx1','ordxe1','RO-AAA','2026-06-01','pending','0','0'),
      ('ordx2','ordxe2','RO-ZZZ','2025-01-01','pending','0','0'),
      ('ordx3','ordxe3','RO-MMM',NULL,'pending','0','0');
  `);
  const res = await app.request("/receiving-orders");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as any[];
  const idx = (id: string) => rows.findIndex((r) => r.id === id);
  // delivery_date ASC (NULLs first, as in SQLite/PGlite); ref_no order would be AAA < MMM < ZZZ
  assert.ok(idx("ordx3") < idx("ordx2"), "NULL delivery_date sorts first");
  assert.ok(idx("ordx2") < idx("ordx1"), "earlier delivery_date sorts before later");
});

test("GET /receiving-orders/:id returns detail with supplier, items, allocations, mismatches", async () => {
  const res = await app.request("/receiving-orders/ro4");
  assert.equal(res.status, 200);
  const detail = (await res.json()) as any;
  assert.equal(detail.id, "ro4");
  assert.equal(detail.ref_no, "RO-4");
  assert.equal(detail.status, "in_hand");
  assert.equal(detail.delivery_date, "2026-01-15");
  assert.equal(detail.remaining_items, 1);
  assert.deepEqual(detail.allocated_by_item, { rii4a: 2 });

  assert.deepEqual(detail.supplier, {
    id: "sup4", code: "S4", name: "Sup Four",
    qr_template: "tpl-{qty}", qrcode_qty_encoding: "plain",
  });

  assert.equal(detail.invoices.length, 1);
  const inv = detail.invoices[0];
  assert.equal(inv.id, "inv4");
  assert.equal(inv.receiving_order_id, "ro4");
  assert.equal(inv.invoice_no, "INV-4");
  assert.equal(inv.supplier_id, "sup4");
  assert.equal(inv.items.length, 2);

  const itemA = inv.items.find((i: any) => i.id === "rii4a");
  const itemB = inv.items.find((i: any) => i.id === "rii4b");
  assert.ok(itemA && itemB, "both items present");
  assert.equal(itemA.receiving_invoice_id, "inv4");
  assert.equal(itemA.part_id, "p4");
  assert.equal(itemA.qty, 10);
  assert.equal(itemA.received_qty, 10);
  assert.deepEqual(itemA.part, { id: "p4", part_no: "P4", description: "Part four" });
  assert.equal(itemA.mismatch, null);

  assert.deepEqual(itemB.part, { id: "p4b", part_no: "P4B", description: "Part four B" });
  assert.ok(itemB.mismatch, "rii4b has a mismatch");
  assert.equal(itemB.mismatch.id, "rim4new"); // latest non-cancelled by created_at wins (rim4cancelled is newer but cancelled)
  assert.equal(itemB.mismatch.receiving_invoice_item_id, "rii4b");
  assert.equal(itemB.mismatch.kind, "qty");
  assert.equal(itemB.mismatch.note, "new note");
});

test("GET /receiving-orders/:id returns 404 for unknown order", async () => {
  const res = await app.request("/receiving-orders/nope");
  assert.equal(res.status, 404);
});

// Task 6 fixtures: ro6 with both allocation shapes (lot-sourced al6 and
// order-level al6b), one unboxed + one boxed package on pi6, a shipping box,
// and transition logs for both the picking order and the picking item.
// lot6 is sourced from TWO invoice items (rii6 + rii6b) of ro6, so the bundle
// query's GROUP BY a.id dedup is exercised: without it the lot row doubles.
// Note: API inventory_lots carries shelf_code/box_id directly (no shelf_box_id
// FK), so the lot row's location fields come from the lot itself.
await db.execute(`
  INSERT INTO parts (id, part_no, part_no_norm, description, created_at, updated_at)
    VALUES ('p6','P6','P6','Part six','0','0');
  INSERT INTO users (id, username, password_hash, role, name, created_at, updated_at)
    VALUES ('u6','user6','hash6','operator','User Six','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, delivery_date, status, supplier_id, created_at, updated_at)
    VALUES ('ro6','e6','RO-6',NULL,'in_hand',NULL,'0','0');
  INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
    VALUES ('inv6','e6','ro6','INV-6',NULL,'0','0');
  INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
    VALUES ('rii6','inv6','p6',10,10,10,'0','0'),
           ('rii6b','inv6','p6',4,4,4,'0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, created_at, updated_at)
    VALUES ('po6','e6','PO-6','picking','Ship To Six','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at)
    VALUES ('pi6','po6','p6',6,2,'0','0');
  INSERT INTO inventory_lots (id, part_id, date_code, lot_code, coo, cow, shelf_code, box_id, total_qty, allocated_qty, created_at, updated_at)
    VALUES ('lot6','p6','DC6','LOT6','CN','2026-W01','SH-6','BX-6',10,4,'0','0');
  INSERT INTO inventory_lot_sources (id, inventory_lot_id, receiving_invoice_item_id, qty, created_at, updated_at)
    VALUES ('ils6','lot6','rii6',10,'0','0'),
           ('ils6b','lot6','rii6b',4,'0','0');
  INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at)
    VALUES ('al6','pi6',4,'lot6','0','0');
  INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at)
    VALUES ('al6b','pi6',2,'ro6','0','0');
  INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at)
    VALUES ('ari6','al6b','rii6',2,'0','0');
  INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
    VALUES ('pkg6a','pi6','inventory_lot','lot6',2,NULL,'0','0');
  INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at)
    VALUES ('box6','po6','open','0','0');
  INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
    VALUES ('pkg6b','pi6','inventory_lot','lot6',2,'box6','0','0');
  INSERT INTO transition_logs (id, entity_type, entity_id, from_status, to_status, actor_id, note, created_at, updated_at)
    VALUES ('tl6po','picking_order','po6','pending','picking','u6','po note','2026-01-05T00:00:00.000Z','0'),
           ('tl6pi','picking_item','pi6','pending','picking','u6','pi note','2026-01-06T00:00:00.000Z','0');
`);

test("GET /receiving-orders/:id/picking returns bundle rows for both allocation shapes", async () => {
  const res = await app.request("/receiving-orders/ro6/picking");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;

  assert.equal(body.rows.length, 2);
  const lotRow = body.rows.find((r: any) => r.allocation_id === "al6");
  const orderRow = body.rows.find((r: any) => r.allocation_id === "al6b");
  assert.ok(lotRow && orderRow, "both allocation rows present");

  for (const row of [lotRow, orderRow]) {
    assert.equal(row.picking_order_id, "po6");
    assert.equal(row.picking_order_ref, "PO-6");
    assert.equal(row.picking_order_status, "picking");
    assert.equal(row.picking_order_ship_to, "Ship To Six");
    assert.equal(row.picking_item_id, "pi6");
    assert.equal(row.required_qty, 6);
    assert.equal(row.picked_qty, 2);
    assert.equal(row.part_id, "p6");
    assert.equal(row.part_no, "P6");
    assert.equal(row.scanned_qty, 2); // pkg6a (unboxed)
    assert.equal(row.boxed_qty, 2); // pkg6b (in box6)
  }

  assert.equal(lotRow.allocated_qty, 4);
  assert.equal(lotRow.shelf_code, "SH-6");
  assert.equal(lotRow.box_id, "BX-6");
  assert.equal(lotRow.date_code, "DC6");
  assert.equal(lotRow.lot_code, "LOT6");
  assert.equal(lotRow.coo, "CN");
  assert.equal(lotRow.cow, "2026-W01");

  assert.equal(orderRow.allocated_qty, 2);
  for (const field of ["shelf_code", "box_id", "date_code", "lot_code", "coo", "cow"]) {
    assert.equal(orderRow[field], null, `order-level row ${field} should be null`);
  }
});

test("GET /receiving-orders/:id/picking returns packages, boxes and order logs keyed by id", async () => {
  const res = await app.request("/receiving-orders/ro6/picking");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;

  // The web adapter includes ALL packages for the item (boxed and unboxed).
  const pkgs = body.packages_by_item.pi6;
  assert.equal(pkgs.length, 2);
  const unboxed = pkgs.find((p: any) => p.id === "pkg6a");
  const boxed = pkgs.find((p: any) => p.id === "pkg6b");
  assert.ok(unboxed && boxed, "both packages present");
  assert.equal(unboxed.shipping_box_id, null);
  assert.equal(unboxed.qty, 2);
  assert.equal(boxed.shipping_box_id, "box6");

  assert.equal(body.boxes_by_order.po6.length, 1);
  assert.equal(body.boxes_by_order.po6[0].id, "box6");
  assert.equal(body.boxes_by_order.po6[0].status, "open");

  assert.equal(body.transition_logs.po6.length, 1);
  assert.equal(body.transition_logs.po6[0].id, "tl6po");
  assert.equal(body.transition_logs.po6[0].actor_name, "User Six");
  assert.equal(body.transition_logs.po6[0].from_status, "pending");
  assert.equal(body.transition_logs.po6[0].to_status, "picking");
});

test("GET /receiving-orders/:id/picking returns 404 for unknown order", async () => {
  const res = await app.request("/receiving-orders/nope/picking");
  assert.equal(res.status, 404);
});

// Regression: the bundle's IN-clause queries (packages_by_item, boxes_by_order,
// transition_logs) use sql.join and previously concatenated placeholders when
// multiple ids were involved — invisible with single-id fixtures (a lone
// placeholder needs no separator). ro7 has two items across two orders.
await db.execute(`
  INSERT INTO parts (id, part_no, part_no_norm, description, created_at, updated_at)
    VALUES ('p7','P7','P7','Part seven','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, delivery_date, status, supplier_id, created_at, updated_at)
    VALUES ('ro7','e7','RO-7',NULL,'in_hand',NULL,'0','0');
  INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
    VALUES ('inv7','e7','ro7','INV-7',NULL,'0','0');
  INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
    VALUES ('rii7a','inv7','p7',5,5,5,'0','0'),
           ('rii7b','inv7','p7',3,3,3,'0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, created_at, updated_at)
    VALUES ('po7a','e7a','PO-7A','picking','Ship A','0','0'),
           ('po7b','e7b','PO-7B','picking','Ship B','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at)
    VALUES ('pi7a','po7a','p7',5,0,'0','0'),
           ('pi7b','po7b','p7',3,0,'0','0');
  INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at)
    VALUES ('al7a','pi7a',5,'ro7','0','0'),
           ('al7b','pi7b',3,'ro7','0','0');
  INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at)
    VALUES ('box7a','po7a','open','0','0'),
           ('box7b','po7b','open','0','0');
  INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
    VALUES ('pkg7a','pi7a','receiving_invoice_item','rii7a',2,NULL,'0','0'),
           ('pkg7b','pi7b','receiving_invoice_item','rii7b',1,'box7b','0','0');
`);

test("GET /receiving-orders/:id/picking handles multiple items and orders (sql.join regression)", async () => {
  const res = await app.request("/receiving-orders/ro7/picking");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;

  assert.equal(body.rows.length, 2);
  assert.equal(body.packages_by_item.pi7a.length, 1);
  assert.equal(body.packages_by_item.pi7a[0].id, "pkg7a");
  assert.equal(body.packages_by_item.pi7b.length, 1);
  assert.equal(body.packages_by_item.pi7b[0].id, "pkg7b");
  assert.equal(body.boxes_by_order.po7a.length, 1);
  assert.equal(body.boxes_by_order.po7b.length, 1);
  assert.deepEqual(body.transition_logs, {});
});

test("POST /picking-items/transition-logs accepts multiple ids (sql.join regression)", async () => {
  const res = await app.request("/picking-items/transition-logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["pi6", "pi7a", "pi7b"] }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.logs.length, 1);
  assert.equal(body.logs[0].entity_id, "pi6");
});

test("POST /picking-items/transition-logs returns logs with actor_name for known ids", async () => {
  const res = await app.request("/picking-items/transition-logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["pi6"] }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.logs.length, 1);
  assert.equal(body.logs[0].id, "tl6pi");
  assert.equal(body.logs[0].entity_id, "pi6");
  assert.equal(body.logs[0].from_status, "pending");
  assert.equal(body.logs[0].to_status, "picking");
  assert.equal(body.logs[0].actor_name, "User Six");
});

test("POST /picking-items/transition-logs returns empty logs for unknown ids", async () => {
  const res = await app.request("/picking-items/transition-logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["nope"] }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.deepEqual(body, { logs: [] });
});

test("POST /picking-items/transition-logs returns 400 for missing or empty ids", async () => {
  const empty = await app.request("/picking-items/transition-logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(empty.status, 400);

  const missing = await app.request("/picking-items/transition-logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 400);
});

// Task 9 fixtures: scan-candidates for ro9c (in_hand).
// p9c part_no 'ABC123' normalizes to 'ABC123' under the API's normalizePartNo
// (whitespace is collapsed but kept, no confusable chars present).
// rii9ca has one unboxed put-away scan (qty 2) -> available 5-2=3; rii9cb is
// fully consumed (available 0) and must be excluded. rii9cd (date_code_norm
// 'DC9A') exercises the ORDER BY: it must sort before rii9ca ('DC9C').
// ro9cb is pending, so its item must never surface and its own scan-candidates
// return empty maps.
// po9c (picking) has pi9c (qty 5, picked 1, one unboxed package qty 1 ->
// remaining 3) with an order-level allocation on ro9c; po9cx is finished and
// must be excluded despite its allocation on ro9c. po9cd (ref 'PO-9B') also
// allocates on ro9c and exercises the ref_no ordering: it must come first.
// Inserted inside the first test (not at module top) because the pending ro9cb
// would otherwise break the earlier ?status=pending filter test, which expects
// an empty list.
async function seedScanCandidatesFixtures(): Promise<void> {
  await db.execute(`
  INSERT INTO parts (id, part_no, part_no_norm, description, created_at, updated_at)
    VALUES ('p9c','ABC123','ABC123','Part nine C','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, delivery_date, status, supplier_id, created_at, updated_at)
    VALUES ('ro9c','e9c','RO-9C',NULL,'in_hand',NULL,'0','0'),
           ('ro9cb','e9cb','RO-9CB',NULL,'pending',NULL,'0','0');
  INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
    VALUES ('inv9c','e9c','ro9c','INV-9C',NULL,'0','0'),
           ('inv9cb','e9cb','ro9cb','INV-9CB',NULL,'0','0');
  INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty,
                                       date_code, lot_code, coo, cow,
                                       date_code_norm, lot_code_norm, coo_norm, cow_norm,
                                       created_at, updated_at)
    VALUES ('rii9ca','inv9c','p9c',5,5,5,'dc9c','lot9c','cn','2026 w01','DC9C','LOT9C','CN','2026 W01','0','0'),
           ('rii9cb','inv9c','p9c',5,5,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'0','0'),
           ('rii9cc','inv9cb','p9c',3,3,3,'dc9c','lot9c','cn','2026 w01','DC9C','LOT9C','CN','2026 W01','0','0'),
           ('rii9cd','inv9c','p9c',2,2,2,'dc9a','lot9a','cn','2026 w01','DC9A','LOT9A','CN','2026 W01','0','0');
  INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, verified, created_at, updated_at)
    VALUES ('pas9c','rii9ca',2,NULL,false,'0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, created_at, updated_at)
    VALUES ('po9c','e9c','PO-9C','picking','Ship Nine','0','0'),
           ('po9cx','e9cx','PO-9CX','finished','Ship Nine X','0','0'),
           ('po9cd','e9cd','PO-9B','picking','Ship Nine B','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at)
    VALUES ('pi9c','po9c','p9c',5,1,'0','0'),
           ('pi9cx','po9cx','p9c',5,0,'0','0'),
           ('pi9cd','po9cd','p9c',4,0,'0','0');
  INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at)
    VALUES ('al9c','pi9c',3,'ro9c','0','0'),
           ('al9cx','pi9cx',2,'ro9c','0','0'),
           ('al9cd','pi9cd',4,'ro9c','0','0');
  INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
    VALUES ('pkg9c','pi9c','receiving_invoice_item','rii9ca',1,NULL,'0','0');
`);
}

test("GET /receiving-orders/:id/scan-candidates returns receiving and picking candidates", async () => {
  await seedScanCandidatesFixtures();
  const res = await app.request("/receiving-orders/ro9c/scan-candidates");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;

  const recv = body.receiving_by_part_no;
  assert.deepEqual(Object.keys(recv), ["ABC123"]);
  // rii9cb (available 0) and ro9cb's rii9cc excluded; ORDER BY
  // (part_no_norm, date_code_norm, lot_code_norm) puts rii9cd ('DC9A') first.
  assert.equal(recv.ABC123.length, 2);
  assert.deepEqual(recv.ABC123.map((r: any) => r.receiving_invoice_item_id), ["rii9cd", "rii9ca"]);
  const cand = recv.ABC123[1];
  assert.equal(cand.part_id, "p9c");
  assert.equal(cand.part_no, "ABC123");
  assert.equal(cand.available_qty, 3); // 5 - 2 unboxed put-away scan
  assert.equal(cand.date_code, "DC9C"); // normalized values
  assert.equal(cand.lot_code, "LOT9C");
  assert.equal(cand.coo, "CN");
  assert.equal(cand.cow, "2026 W01");
  assert.equal(recv.ABC123[0].available_qty, 2);
  assert.equal(recv.ABC123[0].date_code, "DC9A");

  const pick = body.picking_by_part_id;
  assert.deepEqual(Object.keys(pick), ["p9c"]);
  // finished po9cx excluded; ORDER BY po.ref_no puts po9cd ('PO-9B') first.
  assert.equal(pick.p9c.length, 2);
  assert.deepEqual(pick.p9c.map((r: any) => r.picking_order_id), ["po9cd", "po9c"]);
  const pc = pick.p9c[1];
  assert.equal(pc.picking_order_ref_no, "PO-9C");
  assert.equal(pc.picking_item_id, "pi9c");
  assert.equal(pc.part_id, "p9c");
  assert.equal(pc.ship_to, "Ship Nine");
  assert.equal(pc.required_qty, 5);
  assert.equal(pc.picked_qty, 1);
  assert.equal(pc.remaining_qty, 3); // 5 - 1 picked - 1 unboxed package
  const pcFirst = pick.p9c[0];
  assert.equal(pcFirst.picking_order_ref_no, "PO-9B");
  assert.equal(pcFirst.picking_item_id, "pi9cd");
  assert.equal(pcFirst.remaining_qty, 4); // 4 - 0 picked - 0 unboxed packages
});

test("GET /receiving-orders/:id/scan-candidates returns empty maps for non-in_hand order", async () => {
  const res = await app.request("/receiving-orders/ro9cb/scan-candidates");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.deepEqual(body, { receiving_by_part_no: {}, picking_by_part_id: {} });
});

test("GET /receiving-orders/:id/scan-candidates returns 404 for unknown order", async () => {
  const res = await app.request("/receiving-orders/nope/scan-candidates");
  assert.equal(res.status, 404);
});

test("GET /receiving-orders/:id/scan-candidates keys receiving map by web normalize, not part_no_norm", async () => {
  // The web keys its candidate map with normalize() (no confusable mapping),
  // while the stored part_no_norm maps O->0. p9d's stored norm is 'K0A-103';
  // the map key must be 'KOA-103' so the client's lookups hit.
  await db.execute(`
    INSERT INTO parts (id, part_no, part_no_norm, description, created_at, updated_at)
      VALUES ('p9d','KOA-103','K0A-103','Part nine D','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, delivery_date, status, supplier_id, created_at, updated_at)
      VALUES ('ro9d','e9d','RO-9D',NULL,'in_hand',NULL,'0','0');
    INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
      VALUES ('inv9d','e9d','ro9d','INV-9D',NULL,'0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
      VALUES ('rii9d','inv9d','p9d',4,4,4,'0','0');
  `);
  const res = await app.request("/receiving-orders/ro9d/scan-candidates");
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.deepEqual(Object.keys(body.receiving_by_part_no), ["KOA-103"]);
  assert.equal(body.receiving_by_part_no["KOA-103"][0].receiving_invoice_item_id, "rii9d");
  assert.equal(body.receiving_by_part_no["KOA-103"][0].part_no, "KOA-103");
});

test.after(async () => { await sql.end(); });
