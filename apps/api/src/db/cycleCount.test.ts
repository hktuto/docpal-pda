import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { scanAllocation } from "./pickScan.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','e','RO-1','in_hand','sup','0','0');
    INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at) VALUES ('inv','e','ro','INV-1','sup','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, put_away_qty, created_at, updated_at) VALUES ('rii','inv','p',5,5,5,'0','0');
    INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at, updated_at) VALUES ('box','ro','A1','verified','0','0');
    INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, verified, created_at, updated_at) VALUES ('pas','rii',5,'box',1,'0','0');
    INSERT INTO inventory_lots (id, part_id, shelf_code, box_id, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot','p','A1','box',5,5,'0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','PO-1','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',5,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('alloc','pi',5,'lot','0','0');
  `);
  return { sqlite, db };
}

test("scanAllocation from a boxed lot schedules a cycle-count recount and resets the box", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => scanAllocation(tx, { allocationId: "alloc", qty: 2, actorId: "u1" }));
  const vt = sqlite.prepare("SELECT kind, status, shelf_box_id FROM verification_tasks WHERE shelf_box_id='box'").get() as any;
  assert.deepEqual(vt, { kind: "cycle_count", status: "pending", shelf_box_id: "box" });
  // stock changed => box back to closed, scans unverified
  assert.equal((sqlite.prepare("SELECT status FROM shelf_boxes WHERE id='box'").get() as any).status, "closed");
  assert.equal((sqlite.prepare("SELECT verified FROM put_away_scans WHERE id='pas'").get() as any).verified, 0);
  assertInvariantsHold(db);
  sqlite.close();
});
