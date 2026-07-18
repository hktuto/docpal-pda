import { test } from "node:test";
import assert from "node:assert/strict";
import { sql, db, setupTestDb } from "./test-helper.js";

const EXPECTED_TABLES = [
  "users","suppliers","parts","shelves",
  "receiving_orders","receiving_invoices","receiving_invoice_items",
  "picking_orders","picking_items","shipping_boxes","picking_packages","shipping_box_items",
  "inventory_lots","inventory_lot_sources","shelf_boxes","shelf_box_items",
  "allocations","measuring_tasks","transaction_logs","inventory_transactions",
];

async function tableNames(): Promise<Set<string>> {
  const rows = await db.execute<{ tablename: string }>(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `);
  return new Set(rows.map((r) => r.tablename));
}

test("migrations create every expected table", async () => {
  await setupTestDb();
  const names = await tableNames();
  for (const t of EXPECTED_TABLES) assert.ok(names.has(t), `missing table ${t}`);
});

test("inventory_lots.available_qty is generated (stored)", async () => {
  await setupTestDb();
  await db.execute(`
    INSERT INTO parts (id, part_no) VALUES ('p','X');
    INSERT INTO inventory_lots (id, part_id, total_qty, allocated_qty) VALUES ('l','p',10,4);
  `);
  const rows = await db.execute<{ available_qty: number }>(`SELECT available_qty FROM inventory_lots WHERE id='l'`);
  assert.equal(rows[0].available_qty, 6);
});

test("allocations source check rejects no target set, allows both (OR check)", async () => {
  await setupTestDb();
  await db.execute(`
    INSERT INTO parts (id, part_no) VALUES ('p','X');
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po','R1','pending','2024-01-01T00:00:00Z','2024-01-01T00:00:00Z');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',1,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z');
    INSERT INTO inventory_lots (id, part_id, total_qty) VALUES ('l','p',1);
    INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('ro','R2','pending','2024-01-01T00:00:00Z','2024-01-01T00:00:00Z');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','INV','2024-01-01T00:00:00Z','2024-01-01T00:00:00Z');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty) VALUES ('rii','ri','p',1);
  `);
  // CHECK is inventory_lot_id IS NOT NULL OR receiving_invoice_item_id IS NOT NULL → neither set violates it.
  await assert.rejects(
    () => sql.unsafe(`
      INSERT INTO allocations (id, picking_item_id, qty, created_at, updated_at)
      VALUES ('a0','pi',1,'2024-01-01T00:00:00Z','2024-01-01T00:00:00Z')
    `),
    /check constraint/
  );
  // Both set is accepted by the DB check; the single-source rule is enforced by the invariant guard.
  await sql.unsafe(`
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, receiving_invoice_item_id, created_at, updated_at)
    VALUES ('a1','pi',1,'l','rii','2024-01-01T00:00:00Z','2024-01-01T00:00:00Z')
  `);
  const rows = await db.execute<{ c: number }>(`SELECT count(*)::int c FROM allocations WHERE id='a1'`);
  assert.equal(rows[0].c, 1);
});

test.after(async () => {
  await sql.end();
});
