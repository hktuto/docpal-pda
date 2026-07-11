import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  return path.join(dir, "t.sqlite");
}

const EXPECTED_TABLES = [
  "users","suppliers","parts","shelves",
  "receiving_orders","receiving_invoices","receiving_invoice_items","receiving_item_mismatches",
  "picking_orders","picking_items","shipping_boxes","picking_packages",
  "inventory_lots","inventory_lot_sources","shelf_boxes","shelf_box_items","put_away_scans",
  "allocations","allocation_receiving_items","measuring_tasks","verification_tasks","transition_logs",
];

function tableNames(sqlite: ReturnType<typeof createDb>["sqlite"]): Set<string> {
  const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

test("createTables creates every table", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  const names = tableNames(sqlite);
  for (const t of EXPECTED_TABLES) assert.ok(names.has(t), `missing table ${t}`);
  sqlite.close();
});

test("createTables is idempotent", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  assert.doesNotThrow(() => createTables(sqlite));
  sqlite.close();
});

test("picking_items.remaining_qty is generated (stored)", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  sqlite.prepare("INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X',0,0)").run();
  sqlite.prepare("INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e1','R1','pending',0,0)").run();
  sqlite.prepare("INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, scanned_not_boxed_qty, created_at, updated_at) VALUES ('pi','po','p',10,3,2,0,0)").run();
  const row = sqlite.prepare("SELECT remaining_qty FROM picking_items WHERE id='pi'").get() as { remaining_qty: number };
  assert.equal(row.remaining_qty, 5); // 10 - 3 - 2
  sqlite.close();
});

test("inventory_lots.available_qty is generated (stored)", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  sqlite.prepare("INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X',0,0)").run();
  sqlite.prepare("INSERT INTO inventory_lots (id, part_id, total_qty, allocated_qty, created_at, updated_at) VALUES ('l','p',10,4,0,0)").run();
  const row = sqlite.prepare("SELECT available_qty FROM inventory_lots WHERE id='l'").get() as { available_qty: number };
  assert.equal(row.available_qty, 6);
  sqlite.close();
});

test("allocations XOR check rejects both targets set", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  sqlite.prepare("INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X',0,0)").run();
  sqlite.prepare("INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e1','R1','pending',0,0)").run();
  sqlite.prepare("INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',1,0,0)").run();
  sqlite.prepare("INSERT INTO inventory_lots (id, part_id, total_qty, created_at, updated_at) VALUES ('l','p',1,0,0)").run();
  sqlite.prepare("INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e2','R2','pending',0,0)").run();
  assert.throws(() =>
    sqlite.prepare("INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, receiving_order_id, created_at, updated_at) VALUES ('a','pi',1,'l','ro',0,0)").run()
  );
  sqlite.close();
});

test("verification_tasks kind check rejects pre_shipment without picking_order_id", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  assert.throws(() =>
    sqlite.prepare("INSERT INTO verification_tasks (id, kind, status, created_at, updated_at) VALUES ('v','pre_shipment','pending',0,0)").run()
  );
  sqlite.close();
});
