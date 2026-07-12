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

sqlite.exec(`
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
    VALUES ('pas4','rii4a',3,NULL,0,'0','0');
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
  INSERT INTO receiving_item_mismatches (id, receiving_invoice_item_id, kind, note, created_at, updated_at)
    VALUES ('rim4old','rii4b','qty','old note','2026-01-01T00:00:00.000Z','0'),
           ('rim4new','rii4b','qty','new note','2026-01-02T00:00:00.000Z','0');
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
  assert.deepEqual(rows, []);
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
  assert.equal(itemB.mismatch.id, "rim4new"); // latest by created_at wins
  assert.equal(itemB.mismatch.receiving_invoice_item_id, "rii4b");
  assert.equal(itemB.mismatch.kind, "qty");
  assert.equal(itemB.mismatch.note, "new note");
});

test("GET /receiving-orders/:id returns 404 for unknown order", async () => {
  const res = await app.request("/receiving-orders/nope");
  assert.equal(res.status, 404);
});

test("cleanup", () => { sqlite.close(); });
