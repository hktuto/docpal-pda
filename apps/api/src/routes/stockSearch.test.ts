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

// Fixture mirrors the web stockSearch.ts linkage:
// - supplier ↔ part via receiving_invoice_items → receiving_invoices → receiving_orders.supplier_id
//   (the API picking_orders table has no supplier_id, so the web's picking-side
//   UNION leg cannot exist here; p10b is linked through receiving instead).
// - parts_with_inventory counts distinct parts with an inventory_lots row total_qty > 0.
// - a "receiving-area" lot is just an inventory_lots row with NULL shelf_code/box_id.
sqlite.exec(`
  INSERT INTO suppliers (id, code, name, created_at, updated_at)
    VALUES ('sup10','SUP10','Supplier Ten','0','0');
  INSERT INTO parts (id, part_no, part_no_norm, description, created_at, updated_at) VALUES
    ('p10a','P10A','P10A','Part ten A','0','0'),
    ('p10b','P10B','P10B','Part ten B','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at)
    VALUES ('ro10','e10','RO-10','in_hand','sup10','0','0');
  INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
    VALUES ('inv10','ro10','INV-10','sup10','0','0');
  INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
    VALUES ('rii10','inv10','p10a',4,4,4,'0','0'),
           ('rii10b','inv10','p10b',10,10,0,'0','0');
  INSERT INTO inventory_lots (id, part_id, shelf_code, box_id, total_qty, allocated_qty, created_at, updated_at)
    VALUES ('lot10a','p10a',NULL,NULL,4,0,'0','0'),
           ('lot10','p10b','S1','B1',10,3,'0','0');
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at)
    VALUES ('po10','e10p','PO-10','picking','0','0');
  INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at)
    VALUES ('pi10','po10','p10b',3,'0','0');
  INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at)
    VALUES ('al10','pi10',3,'lot10','0','0');
`);

test("GET /stock-search/suppliers returns per-supplier part stats", async () => {
  const res = await app.request("/stock-search/suppliers");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as any[];
  const sup = rows.find((r) => r.id === "sup10");
  assert.ok(sup, "sup10 row present");
  assert.equal(sup.code, "SUP10");
  assert.equal(sup.name, "Supplier Ten");
  assert.equal(sup.total_parts, 2);
  assert.equal(sup.parts_with_inventory, 2);
});

test("GET /stock-search/suppliers/:id/parts returns parts ordered by part_no; 404 unknown supplier", async () => {
  const res = await app.request("/stock-search/suppliers/sup10/parts");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as any[];
  assert.deepEqual(
    rows.map((r) => r.id),
    ["p10a", "p10b"],
  );
  assert.equal(rows[0].part_no, "P10A");
  assert.equal(rows[0].description, "Part ten A");
  assert.equal(rows[1].part_no, "P10B");

  const missing = await app.request("/stock-search/suppliers/nope/parts");
  assert.equal(missing.status, 404);
});

test("GET /stock-search/parts/lots returns per-lot quantities and location labels", async () => {
  const res = await app.request("/stock-search/parts/lots?part_ids=p10a,p10b");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as any[];
  assert.equal(rows.length, 2);
  const byPart = Object.fromEntries(rows.map((r) => [r.part_id, r]));

  const recv = byPart["p10a"];
  assert.equal(recv.location_label, "receiving-area");
  assert.equal(recv.shelf_code, null);
  assert.equal(recv.box_id, null);
  assert.equal(recv.total_qty, 4);
  assert.equal(recv.allocated_qty, 0);
  assert.equal(recv.available_qty, 4);

  const shelf = byPart["p10b"];
  assert.equal(shelf.location_label, "S1 / B1");
  assert.equal(shelf.shelf_code, "S1");
  assert.equal(shelf.box_id, "B1");
  assert.equal(shelf.total_qty, 10);
  assert.equal(shelf.allocated_qty, 3);
  assert.equal(shelf.available_qty, 7);
});

test("GET /stock-search/parts/lots without part_ids is 400", async () => {
  const missing = await app.request("/stock-search/parts/lots");
  assert.equal(missing.status, 400);
  const empty = await app.request("/stock-search/parts/lots?part_ids=");
  assert.equal(empty.status, 400);
});

test("cleanup", () => {
  sqlite.close();
});
