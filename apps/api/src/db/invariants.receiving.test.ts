import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./test-helper.js";
import { applyReceipt, applyPick, applyPutAway } from "./invariants.js";
import { assertInvariantsHold } from "./invariants.guard.js";

type TestSql = Awaited<ReturnType<typeof createTestDb>>["sql"];

let testSql: TestSql | undefined;

const T0 = "2024-01-01T00:00:00Z";

async function makeDb() {
  const { sql, db } = await createTestDb();
  testSql = sql;
  await db.execute(`INSERT INTO parts (id, part_no) VALUES ('p','X')`);
  await db.execute(`INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('ro','R','in_hand','${T0}','${T0}')`);
  await db.execute(`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','INV','${T0}','${T0}')`);
  await db.execute(`INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty) VALUES ('rii','ri','p',20,0)`);
  return { sql, db };
}

// availability is computed on the fly (no stored allocated_qty/available_qty on rii).
async function avail(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  return (await db.execute<{ r: number; p: number; pa: number; av: number }>(`
    SELECT received_qty r, picked_qty p, put_away_qty pa,
      received_qty - picked_qty - put_away_qty
        - COALESCE((SELECT SUM(a.qty)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id), 0) AS av
    FROM receiving_invoice_items rii WHERE id='rii'
  `))[0];
}

test("receipt then pick then put-away keeps computed availability correct", async () => {
  const { db } = await makeDb();
  await applyReceipt(db, "rii", 10);
  assert.deepEqual(await avail(db), { r: 10, p: 0, pa: 0, av: 10 });
  await applyPick(db, "rii", 3);
  assert.deepEqual(await avail(db), { r: 10, p: 3, pa: 0, av: 7 });
  await applyPutAway(db, "rii", 4);
  assert.deepEqual(await avail(db), { r: 10, p: 3, pa: 4, av: 3 });
  await assertInvariantsHold(db);
});

test.after(async () => {
  if (testSql) await testSql.end();
});
