import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./test-helper.js";
import { applyReceipt, createAllocation, deleteAllocation } from "./invariants.js";
import { assertInvariantsHold } from "./invariants.guard.js";

type TestSql = Awaited<ReturnType<typeof createTestDb>>["sql"];

let testSql: TestSql | undefined;

const T0 = "2024-01-01T00:00:00Z";

async function makeDb() {
  const { sql, db } = await createTestDb();
  testSql = sql;
  await db.execute(`INSERT INTO parts (id, part_no) VALUES ('p','X')`);
  await db.execute(`INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po','R','picking','${T0}','${T0}')`);
  await db.execute(`INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'${T0}','${T0}')`);
  await db.execute(`INSERT INTO inventory_lots (id, part_id, total_qty) VALUES ('lot','p',5)`);
  await db.execute(`INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('ro','R2','in_hand','${T0}','${T0}')`);
  await db.execute(`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','INV','${T0}','${T0}')`);
  await db.execute(`INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty) VALUES ('rii','ri','p',10)`);
  return { sql, db };
}

// rii availability is computed on the fly: received - picked - put_away - Σ allocations.
async function riiAvail(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  return (await db.execute<{ av: number }>(`
    SELECT received_qty - picked_qty - put_away_qty
      - COALESCE((SELECT SUM(a.qty)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id), 0) AS av
    FROM receiving_invoice_items rii WHERE id='rii'
  `))[0].av;
}

test("lot + receiving allocations update picking item, lot, and receiving availability", async () => {
  const { db } = await makeDb();
  await applyReceipt(db, "rii", 10);

  await createAllocation(db, { id: "aLot", pickingItemId: "pi", qty: 4, inventoryLotId: "lot" });
  await createAllocation(db, { id: "aRecv", pickingItemId: "pi", qty: 6, receivingInvoiceItemId: "rii" });

  const pi = (await db.execute<{ allocated_qty: number }>("SELECT allocated_qty FROM picking_items WHERE id='pi'"))[0];
  assert.equal(pi.allocated_qty, 10);
  const lot = (await db.execute<{ al: number; av: number }>("SELECT allocated_qty al, available_qty av FROM inventory_lots WHERE id='lot'"))[0];
  assert.deepEqual(lot, { al: 4, av: 1 });
  assert.equal(await riiAvail(db), 4);

  await deleteAllocation(db, "aLot");
  const pi2 = (await db.execute<{ allocated_qty: number }>("SELECT allocated_qty FROM picking_items WHERE id='pi'"))[0];
  assert.equal(pi2.allocated_qty, 6);
  const lot2 = (await db.execute<{ al: number; av: number }>("SELECT allocated_qty al, available_qty av FROM inventory_lots WHERE id='lot'"))[0];
  assert.deepEqual(lot2, { al: 0, av: 5 });

  await deleteAllocation(db, "aRecv");
  assert.equal(await riiAvail(db), 10);
  await assertInvariantsHold(db);
});

test.after(async () => {
  if (testSql) await testSql.end();
});
