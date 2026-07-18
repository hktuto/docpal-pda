import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./test-helper.js";
import { scanToPackage, assignPackageToBox } from "./invariants.js";

type TestSql = Awaited<ReturnType<typeof createTestDb>>["sql"];

let testSql: TestSql | undefined;

const T0 = "2024-01-01T00:00:00Z";

async function makeDb() {
  const { sql, db } = await createTestDb();
  testSql = sql;
  await db.execute(`INSERT INTO parts (id, part_no) VALUES ('p','X')`);
  await db.execute(`INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po','R','picking','${T0}','${T0}')`);
  await db.execute(`INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'${T0}','${T0}')`);
  await db.execute(`INSERT INTO inventory_lots (id, part_id, total_qty) VALUES ('lot','p',10)`);
  await db.execute(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','${T0}','${T0}')`);
  return { sql, db };
}

// scanned-not-boxed and remaining are computed on the fly from picking_packages.
async function computed(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  return (await db.execute<{ s: number; r: number }>(`
    SELECT
      COALESCE((SELECT SUM(qty)::int FROM picking_packages WHERE picking_item_id='pi' AND shipping_box_id IS NULL), 0) AS s,
      qty - COALESCE((SELECT SUM(qty)::int FROM picking_packages WHERE picking_item_id='pi'), 0) AS r
    FROM picking_items WHERE id='pi'
  `))[0];
}

test("scan unboxed then assign to box keeps computed unboxed and remaining correct", async () => {
  const { db } = await makeDb();
  await scanToPackage(db, { id: "pp1", pickingItemId: "pi", qty: 3, sourceType: "inventory_lot", sourceId: "lot" });
  await scanToPackage(db, { id: "pp2", pickingItemId: "pi", qty: 2, sourceType: "inventory_lot", sourceId: "lot" });
  assert.deepEqual(await computed(db), { s: 5, r: 5 });
  // Unboxed packages do not count as picked.
  assert.equal((await db.execute<{ p: number }>("SELECT picked_qty p FROM picking_items WHERE id='pi'"))[0].p, 0);

  await assignPackageToBox(db, { packageId: "pp1", shippingBoxId: "box" });
  assert.deepEqual(await computed(db), { s: 2, r: 5 });
  assert.equal((await db.execute<{ p: number }>("SELECT picked_qty p FROM picking_items WHERE id='pi'"))[0].p, 3);

  // Compat mirror: only the boxed package has a shipping_box_items row.
  const mirror = await db.execute<{ id: string; shipping_box_id: string; part_id: string; qty: number }>(
    `SELECT id, shipping_box_id, part_id, qty FROM shipping_box_items`
  );
  assert.deepEqual(Array.from(mirror), [{ id: "pp1", shipping_box_id: "box", part_id: "p", qty: 3 }]);
});

test.after(async () => {
  if (testSql) await testSql.end();
});
