import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./test-helper.js";
import { scanAllocation, removeScannedPackage } from "./pickScan.js";
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

// rii availability is computed on the fly: received − picked − put_away − Σ allocations.
const RII_AVAIL_SQL = `
  SELECT id, picked_qty,
    received_qty - picked_qty - put_away_qty
      - COALESCE((SELECT SUM(a.qty)::int FROM allocations a WHERE a.receiving_invoice_item_id = rii.id), 0) AS available_qty
  FROM receiving_invoice_items rii ORDER BY id`;

test("scan against a shelf-lot allocation: lot total drops, allocation reduced, one package, invariants hold", async () => {
  const { db } = await makeDb();
  await db.execute(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, date_code) VALUES ('lot','p','S1',10,10,'202401');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot',now(),now());
  `);
  const res = await db.transaction(async (tx) => scanAllocation(tx, { allocationId: "a", qty: 4 }));
  assert.equal(res.packageIds.length, 1);
  const lot = (await db.execute<{
    total_qty: number;
    allocated_qty: number;
    available_qty: number;
  }>("SELECT total_qty, allocated_qty, available_qty FROM inventory_lots WHERE id='lot'"))[0];
  assert.deepEqual(lot, { total_qty: 6, allocated_qty: 6, available_qty: 0 });
  const a = (await db.execute<{ qty: number }>("SELECT qty FROM allocations WHERE id='a'"))[0];
  assert.equal(a.qty, 6);
  const pkg = (await db.execute<{
    qty: number;
    source_type: string;
    source_id: string;
    date_code: string | null;
    shipping_box_id: string | null;
  }>("SELECT qty, source_type, source_id, date_code, shipping_box_id FROM picking_packages"))[0];
  assert.deepEqual(pkg, { qty: 4, source_type: "inventory_lot", source_id: "lot", date_code: "202401", shipping_box_id: null });
  // picked_qty counts boxed packages only; the 4 scanned sit unboxed (computed).
  const pi = (await db.execute<{ picked_qty: number; allocated_qty: number }>(
    "SELECT picked_qty, allocated_qty FROM picking_items WHERE id='pi'"
  ))[0];
  assert.deepEqual(pi, { picked_qty: 0, allocated_qty: 6 });
  const unboxed = (await db.execute<{ s: number }>(
    "SELECT COALESCE(SUM(qty)::int, 0) AS s FROM picking_packages WHERE picking_item_id='pi' AND shipping_box_id IS NULL"
  ))[0];
  assert.equal(unboxed.s, 4);
  await assertInvariantsHold(db);
});

test("scan against receiving-source allocations consumes the rii directly (one package per allocation)", async () => {
  const { db } = await makeDb();
  await db.execute(`
    INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('ro','R','in_hand',now(),now());
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I',now(),now());
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, date_code) VALUES
      ('riiA','ri','p',25,25,'202401'),
      ('riiB','ri','p',25,25,'202402');
    INSERT INTO allocations (id, picking_item_id, qty, receiving_invoice_item_id, created_at, updated_at) VALUES
      ('aA','pi',25,'riiA',now(),now()), ('aB','pi',15,'riiB',now(),now());
    UPDATE picking_items SET qty=40, allocated_qty=40; -- item must require >= the 30 scanned
  `);
  const resA = await db.transaction(async (tx) => scanAllocation(tx, { allocationId: "aA", qty: 25 }));
  const resB = await db.transaction(async (tx) => scanAllocation(tx, { allocationId: "aB", qty: 5 }));
  assert.equal(resA.packageIds.length, 1);
  assert.equal(resB.packageIds.length, 1);
  const riis = await db.execute<{ id: string; picked_qty: number; available_qty: number }>(RII_AVAIL_SQL);
  assert.deepEqual(Array.from(riis), [
    { id: "riiA", picked_qty: 25, available_qty: 0 },
    { id: "riiB", picked_qty: 5, available_qty: 10 },
  ]);
  assert.equal((await db.execute<{ qty: number }>("SELECT qty FROM allocations WHERE id='aA'"))[0].qty, 0);
  assert.equal((await db.execute<{ qty: number }>("SELECT qty FROM allocations WHERE id='aB'"))[0].qty, 10);
  const pkgs = await db.execute<{ source_id: string; qty: number }>(
    "SELECT source_id, qty FROM picking_packages ORDER BY source_id"
  );
  assert.deepEqual(Array.from(pkgs), [
    { source_id: "riiA", qty: 25 },
    { source_id: "riiB", qty: 5 },
  ]);
  await assertInvariantsHold(db);
});

test("undo of a receiving-source scan restores picked_qty, allocation, and logs removal", async () => {
  const { db } = await makeDb();
  await db.execute(`
    INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('ro','R','in_hand',now(),now());
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I',now(),now());
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, date_code) VALUES
      ('riiA','ri','p',25,25,'202401'),
      ('riiB','ri','p',25,25,'202402');
    INSERT INTO allocations (id, picking_item_id, qty, receiving_invoice_item_id, created_at, updated_at) VALUES
      ('aA','pi',25,'riiA',now(),now()), ('aB','pi',15,'riiB',now(),now());
    UPDATE picking_items SET qty=40, allocated_qty=40;
  `);
  const resA = await db.transaction(async (tx) => scanAllocation(tx, { allocationId: "aA", qty: 25 }));
  const resB = await db.transaction(async (tx) => scanAllocation(tx, { allocationId: "aB", qty: 5 }));

  await db.transaction(async (tx) => removeScannedPackage(tx, { packageId: resA.packageIds[0], actorId: "u1" }));
  // undo is blocked on a finished order, mirroring scanAllocation
  await db.execute("UPDATE picking_orders SET status='finished'");
  await assert.rejects(
    async () => db.transaction(async (tx) => removeScannedPackage(tx, { packageId: resB.packageIds[0], actorId: "u1" })),
    (e: any) => e.status === 409
  );
  await db.execute("UPDATE picking_orders SET status='picking'");
  await db.transaction(async (tx) => removeScannedPackage(tx, { packageId: resB.packageIds[0], actorId: "u1" }));

  const riis = await db.execute<{ id: string; picked_qty: number; available_qty: number }>(RII_AVAIL_SQL);
  assert.deepEqual(Array.from(riis), [
    { id: "riiA", picked_qty: 0, available_qty: 0 },
    { id: "riiB", picked_qty: 0, available_qty: 10 },
  ]);
  assert.equal((await db.execute<{ qty: number }>("SELECT qty FROM allocations WHERE id='aA'"))[0].qty, 25);
  assert.equal((await db.execute<{ qty: number }>("SELECT qty FROM allocations WHERE id='aB'"))[0].qty, 15);
  assert.equal((await db.execute<{ c: number }>("SELECT COUNT(*)::int AS c FROM picking_packages"))[0].c, 0);
  const pi = (await db.execute<{ picked_qty: number; allocated_qty: number }>(
    "SELECT picked_qty, allocated_qty FROM picking_items WHERE id='pi'"
  ))[0];
  assert.deepEqual(pi, { picked_qty: 0, allocated_qty: 40 });
  const removed = await db.execute<{ from_state: string | null; to_state: string; actor_id: string | null }>(
    "SELECT from_state, to_state, actor_id FROM transaction_logs WHERE entity_type='picking_item' AND to_state='removed'"
  );
  assert.deepEqual(Array.from(removed), [
    { from_state: "scanned", to_state: "removed", actor_id: "u1" },
    { from_state: "scanned", to_state: "removed", actor_id: "u1" },
  ]);
  await assertInvariantsHold(db);
});

test("scan flips a pending order to picking and logs a transition", async () => {
  const { db } = await makeDb();
  await db.execute("UPDATE picking_orders SET status='pending'");
  await db.execute(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty) VALUES ('lot','p','S1',10,10);
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot',now(),now());
  `);
  await db.transaction(async (tx) => scanAllocation(tx, { allocationId: "a", qty: 2, actorId: "u1" }));
  assert.equal((await db.execute<{ status: string }>("SELECT status FROM picking_orders"))[0].status, "picking");
  // sorted in JS: created_at can tie (same-transaction timestamps)
  const logs = (
    await db.execute<{
      entity_type: string;
      from_state: string | null;
      to_state: string;
      actor_id: string | null;
    }>("SELECT entity_type, from_state, to_state, actor_id FROM transaction_logs")
  ).sort((a, b) => a.entity_type.localeCompare(b.entity_type));
  assert.deepEqual(Array.from(logs), [
    { entity_type: "picking_item", from_state: "picking", to_state: "scanned", actor_id: "u1" },
    { entity_type: "picking_order", from_state: "pending", to_state: "picking", actor_id: "u1" },
  ]);
});

test("scan guards: 404 missing allocation, 400 bad qty, 409 qty>allocation, 409 over-pick, 409 issue order", async () => {
  const { db } = await makeDb();
  await db.execute(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty) VALUES ('lot','p','S1',10,6);
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',6,'lot',now(),now());
  `);
  await assert.rejects(
    async () => db.transaction(async (tx) => scanAllocation(tx, { allocationId: "nope", qty: 1 })),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => scanAllocation(tx, { allocationId: "a", qty: 0 })),
    (e: any) => e.status === 400
  );
  await assert.rejects(
    async () => db.transaction(async (tx) => scanAllocation(tx, { allocationId: "a", qty: 7 })),
    (e: any) => e.status === 409
  ); // > allocation 6
  // over-pick: 5 already packaged + 6 > qty 10 (packaged qty is computed, not stored)
  await db.execute(`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
    VALUES ('pp','pi','po','inventory_lot','lot',5,NULL,now(),now())
  `);
  await assert.rejects(
    async () => db.transaction(async (tx) => scanAllocation(tx, { allocationId: "a", qty: 6 })),
    (e: any) => e.status === 409
  );
  await db.execute("DELETE FROM picking_packages");
  await db.execute("UPDATE picking_orders SET status='issue'");
  await assert.rejects(
    async () => db.transaction(async (tx) => scanAllocation(tx, { allocationId: "a", qty: 1 })),
    (e: any) => e.status === 409
  );
});

test.after(async () => {
  if (lastSql) await lastSql.end();
});
