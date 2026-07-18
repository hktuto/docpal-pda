import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./test-helper.js";
import { scanAllocation, removeScannedPackage, finishPickingOrder } from "./pickScan.js";
import { assertInvariantsHold } from "./invariants.guard.js";

let lastSql: any;

async function makeDb() {
  if (lastSql) await lastSql.end();
  const { sql, db } = await createTestDb();
  lastSql = sql;
  await db.execute(`
    INSERT INTO parts (id, part_no) VALUES ('p','X');
    INSERT INTO users (id, username, password_hash, display_name, created_at) VALUES ('u1','u1','h','U1',now());
    INSERT INTO shelves (code, created_at, updated_at) VALUES ('S1', now(), now());
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po','R','picking',now(),now());
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,now(),now());
  `);
  return { sql, db };
}

test("undo a lot-scan restores lot + allocation + removes package", async () => {
  const { db } = await makeDb();
  await db.execute(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty) VALUES ('lot','p','S1',10,10);
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot',now(),now());
  `);
  const { packageIds } = await db.transaction(async (tx) => scanAllocation(tx, { allocationId: "a", qty: 4 }));
  await db.transaction(async (tx) => removeScannedPackage(tx, { packageId: packageIds[0], actorId: "u1" }));
  assert.deepEqual(
    (await db.execute<{ total_qty: number; allocated_qty: number }>(
      "SELECT total_qty, allocated_qty FROM inventory_lots WHERE id='lot'"
    ))[0],
    { total_qty: 10, allocated_qty: 10 }
  );
  assert.equal((await db.execute<{ qty: number }>("SELECT qty FROM allocations WHERE id='a'"))[0].qty, 10);
  assert.equal((await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM picking_packages"))[0].c, 0);
  await assertInvariantsHold(db);
});

test("undo a receiving-source scan restores picked_qty and the single-level allocation", async () => {
  const { db } = await makeDb();
  await db.execute(`
    INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('ro','R','in_hand',now(),now());
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I',now(),now());
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty)
      VALUES ('rii','ri','p',10,10);
    INSERT INTO allocations (id, picking_item_id, qty, receiving_invoice_item_id, created_at, updated_at) VALUES ('a','pi',10,'rii',now(),now());
    UPDATE picking_items SET allocated_qty=10;
  `);
  const { packageIds } = await db.transaction(async (tx) => scanAllocation(tx, { allocationId: "a", qty: 4 }));
  await db.transaction(async (tx) => removeScannedPackage(tx, { packageId: packageIds[0] }));
  // rii availability is computed: received − picked − put_away − Σ allocations = 10 − 0 − 0 − 10
  assert.deepEqual(
    (await db.execute<{ picked_qty: number; available_qty: number }>(
      `SELECT picked_qty,
         received_qty - picked_qty - put_away_qty
           - COALESCE((SELECT SUM(a.qty)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id), 0) AS available_qty
       FROM receiving_invoice_items rii WHERE id='rii'`
    ))[0],
    { picked_qty: 0, available_qty: 0 }
  );
  assert.equal((await db.execute<{ qty: number }>("SELECT qty FROM allocations WHERE id='a'"))[0].qty, 10);
  await assertInvariantsHold(db);
});

test("undo guards: 404 missing package, 409 boxed package", async () => {
  const { db } = await makeDb();
  await db.execute(
    `INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open',now(),now())`
  );
  await db.execute(
    `INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
     VALUES ('pp','pi','po','inventory_lot','lot',1,'box',now(),now())`
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => removeScannedPackage(tx, { packageId: "nope" })),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => removeScannedPackage(tx, { packageId: "pp" })),
    (e: any) => e.status === 409
  );
});

test("finishPickingOrder: finishes a fully-picked order; 409 when not fully picked, finished or in issue; 404 missing", async () => {
  const { db } = await makeDb();
  await assert.rejects(
    async () => db.transaction(async (tx) => finishPickingOrder(tx, { pickingOrderId: "nope" })),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => finishPickingOrder(tx, { pickingOrderId: "po" })),
    (e: any) => e.status === 409
  );
  await db.execute("UPDATE picking_orders SET status='finished'");
  await assert.rejects(
    async () => db.transaction(async (tx) => finishPickingOrder(tx, { pickingOrderId: "po" })),
    (e: any) => e.status === 409
  );
  await db.execute("UPDATE picking_orders SET status='issue'");
  await assert.rejects(
    async () => db.transaction(async (tx) => finishPickingOrder(tx, { pickingOrderId: "po" })),
    (e: any) => e.status === 409
  );
  await db.execute("UPDATE picking_orders SET status='picking'");
  await db.execute(`
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open',now(),now());
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
      VALUES ('pp','pi','po','inventory_lot','lot',10,'box',now(),now());
    UPDATE picking_items SET picked_qty=10;
  `);
  await db.transaction(async (tx) => finishPickingOrder(tx, { pickingOrderId: "po" }));
  assert.equal((await db.execute<{ status: string }>("SELECT status FROM picking_orders"))[0].status, "finished");
  assert.equal(
    (await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM measuring_tasks WHERE picking_order_id='po'"))[0].c,
    1
  );
  assert.equal(
    (await db.execute<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM transaction_logs WHERE entity_type='picking_order' AND to_state='finished'"
    ))[0].c,
    1
  );
  await assertInvariantsHold(db);
});

test.after(async () => {
  if (lastSql) await lastSql.end();
});
