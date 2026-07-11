import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { applyReceipt, createAllocation, linkAllocation, deleteAllocation } from "./invariants.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'0','0');
    INSERT INTO inventory_lots (id, part_id, total_qty, created_at, updated_at) VALUES ('lot','p',5,'0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e2','R2','in_hand','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','INV','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, created_at, updated_at) VALUES ('rii','ri','p',10,'0','0');
  `);
  return { sqlite, db };
}

test("lot + receiving allocations update picking item, lot, and receiving item", () => {
  const { sqlite, db } = makeDb();
  applyReceipt(db, "rii", 10); // receiving available = 10

  createAllocation(db, { id: "aLot", pickingItemId: "pi", qty: 4, inventoryLotId: "lot" });
  createAllocation(db, { id: "aRecv", pickingItemId: "pi", qty: 6, receivingOrderId: "ro" });
  linkAllocation(db, { id: "lnk", allocationId: "aRecv", receivingInvoiceItemId: "rii", qty: 6 });

  const pi = sqlite.prepare("SELECT allocated_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.equal(pi.allocated_qty, 10); // 4 (lot) + 6 (recv)
  const lot = sqlite.prepare("SELECT allocated_qty al, available_qty av FROM inventory_lots WHERE id='lot'").get() as any;
  assert.deepEqual(lot, { al: 4, av: 1 }); // available generated: 5 - 4
  const rii = sqlite.prepare("SELECT allocated_qty al, available_qty av FROM receiving_invoice_items WHERE id='rii'").get() as any;
  assert.deepEqual(rii, { al: 6, av: 4 }); // 10 received - 6 linked

  deleteAllocation(db, "aLot");
  const pi2 = sqlite.prepare("SELECT allocated_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.equal(pi2.allocated_qty, 6);
  const lot2 = sqlite.prepare("SELECT allocated_qty al, available_qty av FROM inventory_lots WHERE id='lot'").get() as any;
  assert.deepEqual(lot2, { al: 0, av: 5 });
  sqlite.close();
});
