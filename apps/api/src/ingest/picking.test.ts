import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../db/test-helper.js";
import { upsertPickingOrder } from "./picking.js";
import { assertInvariantsHold } from "../db/invariants.guard.js";
import type { PickingPutBody } from "@warehouse/shared";

const { sql, db } = await createTestDb();

test.beforeEach(async () => {
  await db.execute(
    `TRUNCATE TABLE picking_orders, picking_items, parts, inventory_lots, allocations CASCADE`
  );
});

test("upsertPickingOrder creates order + items; remaining_qty generated = qty", async () => {
  const body: PickingPutBody = {
    order: { ref_no: "PO-1", ship_to: "Acme", destination_country: "US" },
    items: [
      { line_id: "L1", part_no: "ABO", qty: 50, required_date_code: "2024O1" },
      { line_id: "L2", part_no: "X1", qty: 10 },
    ],
  };
  const res = await db.transaction(async (tx) => upsertPickingOrder(tx, "PE-1", body));
  assert.equal(res.created, true);
  const po = (
    await db.execute<{ status: string; ship_to: string | null }>(
      `SELECT status, ship_to FROM picking_orders WHERE external_id='PE-1'`
    )
  )[0];
  assert.equal(po.status, "pending");
  assert.equal(po.ship_to, "Acme");
  const items = await db.execute<{ line_id: string; qty: number; remaining_qty: number }>(
    `SELECT line_id, qty, remaining_qty FROM picking_items ORDER BY line_id`
  );
  assert.deepEqual(Array.from(items), [
    { line_id: "L1", qty: 50, remaining_qty: 50 },
    { line_id: "L2", qty: 10, remaining_qty: 10 },
  ]);
  await assertInvariantsHold(db);
});

test("re-PUT identical picking payload is a no-op; update adds/changes/removes untouched lines", async () => {
  const v1: PickingPutBody = {
    order: { ref_no: "PO-1" },
    items: [
      { line_id: "L1", part_no: "ABO", qty: 50 },
      { line_id: "L2", part_no: "X1", qty: 10 },
    ],
  };
  const r = await db.transaction(async (tx) => upsertPickingOrder(tx, "PE-1", v1));
  const stamp = (
    await db.execute<{ updated_at: string }>(
      `SELECT updated_at FROM picking_orders WHERE id='${r.orderId}'`
    )
  )[0].updated_at;

  const noop = await db.transaction(async (tx) => upsertPickingOrder(tx, "PE-1", v1));
  assert.equal(noop.changed, false);
  assert.equal(
    (
      await db.execute<{ updated_at: string }>(
        `SELECT updated_at FROM picking_orders WHERE id='${r.orderId}'`
      )
    )[0].updated_at,
    stamp
  );

  const v2: PickingPutBody = {
    order: { ref_no: "PO-1" },
    items: [
      { line_id: "L1", part_no: "ABO", qty: 80 },
      { line_id: "L3", part_no: "Z9", qty: 3 },
    ],
  };
  const r2 = await db.transaction(async (tx) => upsertPickingOrder(tx, "PE-1", v2));
  assert.equal(r2.changed, true);
  const rows = await db.execute<{ line_id: string; qty: number }>(
    `SELECT line_id, qty FROM picking_items ORDER BY line_id`
  );
  assert.deepEqual(Array.from(rows), [{ line_id: "L1", qty: 80 }, { line_id: "L3", qty: 3 }]);
  await assertInvariantsHold(db);
});

test("picking: decreasing qty below picked+scanned is 409", async () => {
  const v1: PickingPutBody = {
    order: { ref_no: "PO" },
    items: [{ line_id: "L1", part_no: "P", qty: 100 }],
  };
  const r = await db.transaction(async (tx) => upsertPickingOrder(tx, "E", v1));
  await db.execute(
    `UPDATE picking_items SET picked_qty=40, scanned_not_boxed_qty=20 WHERE picking_order_id='${r.orderId}'`
  );
  const v2: PickingPutBody = {
    order: { ref_no: "PO" },
    items: [{ line_id: "L1", part_no: "P", qty: 59 }],
  };
  await assert.rejects(
    async () => {
      await db.transaction(async (tx) => upsertPickingOrder(tx, "E", v2));
    },
    (e: any) => e.status === 409
  );
});

test("picking: removing a line that has allocations is 409", async () => {
  const v1: PickingPutBody = {
    order: { ref_no: "PO" },
    items: [
      { line_id: "L1", part_no: "P", qty: 100 },
      { line_id: "L2", part_no: "Q", qty: 5 },
    ],
  };
  const r = await db.transaction(async (tx) => upsertPickingOrder(tx, "E", v1));
  const l2 = (
    await db.execute<{ id: string }>(`SELECT id FROM picking_items WHERE line_id='L2'`)
  )[0].id;
  const pP = (
    await db.execute<{ id: string }>(`SELECT id FROM parts WHERE part_no_norm='P'`)
  )[0].id;
  // allocation must satisfy the target-XOR check -> point it at a real on-shelf lot
  await db.execute(
    `INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, created_at, updated_at)
     VALUES ('lot', '${pP}', 'S1', 5, '0','0')`
  );
  await db.execute(
    `INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at)
     VALUES ('a', '${l2}', 5, 'lot', '0','0')`
  );
  const v2: PickingPutBody = {
    order: { ref_no: "PO" },
    items: [{ line_id: "L1", part_no: "P", qty: 100 }],
  };
  await assert.rejects(
    async () => {
      await db.transaction(async (tx) => upsertPickingOrder(tx, "E", v2));
    },
    (e: any) => e.status === 409
  );
});

test.after(async () => {
  await sql.end();
});
