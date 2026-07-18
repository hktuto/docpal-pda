import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./test-helper.js";
import { recomputePickingItem, scanToPackage, assignPackageToBox, unassignPackageFromBox } from "./invariants.js";
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
  return { sql, db };
}

// picked_qty is maintained; unboxed/remaining are computed on the fly.
async function row(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  return (await db.execute<{ picked_qty: number; unboxed: number; remaining: number }>(`
    SELECT picked_qty,
      COALESCE((SELECT SUM(qty)::int FROM picking_packages WHERE picking_item_id='pi' AND shipping_box_id IS NULL), 0) AS unboxed,
      qty - COALESCE((SELECT SUM(qty)::int FROM picking_packages WHERE picking_item_id='pi'), 0) AS remaining
    FROM picking_items WHERE id='pi'
  `))[0];
}

async function mirrorRows(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  return db.execute<{ id: string; shipping_box_id: string; picking_item_id: string; part_id: string; qty: number }>(
    `SELECT id, shipping_box_id, picking_item_id, part_id, qty FROM shipping_box_items`
  );
}

test("recomputePickingItem maintains picked_qty = boxed sum (scanned -> boxed -> back)", async () => {
  const { db } = await makeDb();
  await db.transaction(async (tx) => {
    await scanToPackage(tx, { id: "pkg1", pickingItemId: "pi", qty: 4, sourceType: "inventory_lot", sourceId: "lotX" });
  });
  assert.deepEqual(await row(db), { picked_qty: 0, unboxed: 4, remaining: 6 });

  await db.execute(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','${T0}','${T0}')`);
  await db.transaction(async (tx) => {
    await assignPackageToBox(tx, { packageId: "pkg1", shippingBoxId: "box" });
  });
  assert.deepEqual(await row(db), { picked_qty: 4, unboxed: 0, remaining: 6 });
  // Compat mirror: one shipping_box_items row per boxed package, keyed by package id.
  assert.deepEqual(Array.from(await mirrorRows(db)), [
    { id: "pkg1", shipping_box_id: "box", picking_item_id: "pi", part_id: "p", qty: 4 },
  ]);

  await db.transaction(async (tx) => {
    await unassignPackageFromBox(tx, { packageId: "pkg1" });
    await recomputePickingItem(tx, "pi");
  });
  assert.deepEqual(await row(db), { picked_qty: 0, unboxed: 4, remaining: 6 });
  assert.equal(Array.from(await mirrorRows(db)).length, 0);
  await assertInvariantsHold(db);
});

test.after(async () => {
  if (testSql) await testSql.end();
});
