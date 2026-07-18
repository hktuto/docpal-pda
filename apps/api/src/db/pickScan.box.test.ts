import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestDb } from "./test-helper.js";
import {
  createShippingBox,
  cancelShippingBox,
  addPackageToBox,
  addAllUnboxedToBox,
  removePackageFromBox,
  maybeAutoFinishPickingOrder,
} from "./pickScan.js";
import { assertInvariantsHold } from "./invariants.guard.js";

let lastSql: any;

async function makeDb() {
  if (lastSql) await lastSql.end();
  const { sql, db } = await createTestDb();
  lastSql = sql;
  await db.execute(`
    INSERT INTO parts (id, part_no) VALUES ('p','X');
    INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES ('u1','u1','h','U1',now());
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po','R','picking',now(),now());
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,now(),now());
  `);
  return { sql, db };
}

async function seedScanned(db: any, qty = 10) {
  // one unboxed scanned package of qty on item 'pi'
  await db.execute(`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
    VALUES ('pp','pi','po','inventory_lot','lot',${qty},NULL,now(),now());
  `);
}

// scanned-not-boxed is computed, not stored: Σ packages with shipping_box_id IS NULL.
async function unboxedQty(db: any, itemId = "pi") {
  return (await db.execute<{ s: number }>(
    `SELECT COALESCE(SUM(qty)::int, 0) AS s FROM picking_packages WHERE picking_item_id='${itemId}' AND shipping_box_id IS NULL`
  ))[0].s;
}

test("createShippingBox creates an open box + transaction log; cancel removes an empty open box", async () => {
  const { db } = await makeDb();
  const boxId = await db.transaction(async (tx) => createShippingBox(tx, { pickingOrderId: "po", actorId: "u1" }));
  const box = (await db.execute<{ status: string; picking_order_id: string }>(
    sql`SELECT status, picking_order_id FROM shipping_boxes WHERE id = ${boxId}`
  ))[0];
  assert.deepEqual(box, { status: "open", picking_order_id: "po" });
  assert.equal(
    (await db.execute<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM transaction_logs WHERE entity_type='shipping_box' AND to_state='open'"
    ))[0].c,
    1
  );

  await db.transaction(async (tx) => cancelShippingBox(tx, { shippingBoxId: boxId, actorId: "u1" }));
  assert.equal((await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM shipping_boxes"))[0].c, 0);
  assert.equal(
    (await db.execute<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM transaction_logs WHERE entity_type='shipping_box' AND to_state='cancelled'"
    ))[0].c,
    1
  );
  await assertInvariantsHold(db);
});

test("box guards: create on finished/issue order is 409; cancel non-empty or non-open box is 409; missing is 404", async () => {
  const { db } = await makeDb();
  await assert.rejects(
    async () => db.transaction(async (tx) => createShippingBox(tx, { pickingOrderId: "nope" })),
    (e: any) => e.status === 404
  );
  await db.execute("UPDATE picking_orders SET status='finished'");
  await assert.rejects(
    async () => db.transaction(async (tx) => createShippingBox(tx, { pickingOrderId: "po" })),
    (e: any) => e.status === 409
  );
  await db.execute("UPDATE picking_orders SET status='issue'");
  await assert.rejects(
    async () => db.transaction(async (tx) => createShippingBox(tx, { pickingOrderId: "po" })),
    (e: any) => e.status === 409
  );
  await db.execute("UPDATE picking_orders SET status='picking'");

  const boxId = await db.transaction(async (tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  // non-empty
  await db.execute(sql`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
    VALUES ('pp','pi','po','inventory_lot','lot',1,${boxId},now(),now())
  `);
  await assert.rejects(
    async () => db.transaction(async (tx) => cancelShippingBox(tx, { shippingBoxId: boxId })),
    (e: any) => e.status === 409
  );
  await db.execute("DELETE FROM picking_packages");
  // non-open
  await db.execute(sql`UPDATE shipping_boxes SET status='closed' WHERE id = ${boxId}`);
  await assert.rejects(
    async () => db.transaction(async (tx) => cancelShippingBox(tx, { shippingBoxId: boxId })),
    (e: any) => e.status === 409
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => cancelShippingBox(tx, { shippingBoxId: "nope" })),
    (e: any) => e.status === 404
  );
});

test("addPackageToBox moves package into the box: picked rises, unboxed drops; auto-finish creates measuring task", async () => {
  const { db } = await makeDb();
  await seedScanned(db, 10); // item qty is 10 -> fully boxed after this
  const boxId = await db.transaction(async (tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  await db.transaction(async (tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: boxId, actorId: "u1" }));

  const pi = (await db.execute<{ picked_qty: number }>(
    "SELECT picked_qty FROM picking_items WHERE id='pi'"
  ))[0];
  assert.equal(pi.picked_qty, 10);
  assert.equal(await unboxedQty(db), 0);
  const po = (await db.execute<{ status: string }>("SELECT status FROM picking_orders WHERE id='po'"))[0];
  assert.equal(po.status, "finished");
  const tasks = await db.execute<{ picking_order_id: string; status: string }>(
    "SELECT picking_order_id, status FROM measuring_tasks"
  );
  assert.deepEqual(Array.from(tasks), [{ picking_order_id: "po", status: "pending" }]);
  assert.equal(
    (await db.execute<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM transaction_logs WHERE entity_type='picking_order' AND to_state='finished'"
    ))[0].c,
    1
  );
  await assertInvariantsHold(db);

  // idempotent: a second maybeAutoFinish does not duplicate the task or the transition
  await db.transaction(async (tx) => {
    const done = await maybeAutoFinishPickingOrder(tx, { pickingOrderId: "po" });
    assert.equal(done, false);
  });
  assert.equal((await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM measuring_tasks"))[0].c, 1);
});

test("addPackageToBox guards: cross-order package 409, box not open 409, already-boxed 409", async () => {
  const { db } = await makeDb();
  await seedScanned(db, 4);
  await db.execute(
    `INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po2','R2','picking',now(),now())`
  );
  const otherBox = await db.transaction(async (tx) => createShippingBox(tx, { pickingOrderId: "po2" }));
  await assert.rejects(
    async () => db.transaction(async (tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: otherBox })),
    (e: any) => e.status === 409
  );

  const box = await db.transaction(async (tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  await db.execute(sql`UPDATE shipping_boxes SET status='closed' WHERE id = ${box}`);
  await assert.rejects(
    async () => db.transaction(async (tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: box })),
    (e: any) => e.status === 409
  );

  await db.execute(sql`UPDATE shipping_boxes SET status='open' WHERE id = ${box}`);
  await db.transaction(async (tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: box }));
  await assert.rejects(
    async () => db.transaction(async (tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: box })),
    (e: any) => e.status === 409
  );
});

test("addAllUnboxedToBox packs every unboxed package of the order; removePackageFromBox reverts picked/unboxed", async () => {
  const { db } = await makeDb();
  await seedScanned(db, 4);
  await db.execute(`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
    VALUES ('pp2','pi','po','inventory_lot','lot',2,NULL,now(),now());
  `);
  const box = await db.transaction(async (tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  const n = await db.transaction(async (tx) => addAllUnboxedToBox(tx, { shippingBoxId: box, actorId: "u1" }));
  assert.equal(n, 2);
  let pi = (await db.execute<{ picked_qty: number }>(
    "SELECT picked_qty FROM picking_items WHERE id='pi'"
  ))[0];
  assert.equal(pi.picked_qty, 6);
  assert.equal(await unboxedQty(db), 0);
  assert.equal((await db.execute<{ status: string }>("SELECT status FROM picking_orders WHERE id='po'"))[0].status, "picking");
  assert.equal(
    (await db.execute<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM transaction_logs WHERE entity_type='picking_item' AND to_state='boxed'"
    ))[0].c,
    2
  );

  await db.transaction(async (tx) => removePackageFromBox(tx, { packageId: "pp2", actorId: "u1" }));
  pi = (await db.execute<{ picked_qty: number }>(
    "SELECT picked_qty FROM picking_items WHERE id='pi'"
  ))[0];
  assert.equal(pi.picked_qty, 4);
  assert.equal(await unboxedQty(db), 2);
  const pkg = (await db.execute<{ shipping_box_id: string | null; verified: boolean }>(
    "SELECT shipping_box_id, verified FROM picking_packages WHERE id='pp2'"
  ))[0];
  assert.deepEqual(pkg, { shipping_box_id: null, verified: false });
  await assertInvariantsHold(db);
});

test.after(async () => {
  if (lastSql) await lastSql.end();
});
