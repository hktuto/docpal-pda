import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema/index.js";
import { createDb } from "../db/client.js";
import { createTables } from "../db/tables.js";
import { upsertPickingOrder } from "./picking.js";
import { assertInvariantsHold } from "../db/invariants.guard.js";
import type { PickingPutBody } from "@warehouse/shared";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

test("upsertPickingOrder creates order + items; remaining_qty generated = qty", () => {
  const { sqlite, db } = makeDb();
  const body: PickingPutBody = {
    order: { ref_no: "PO-1", ship_to: "Acme", destination_country: "US" },
    items: [
      { line_id: "L1", part_no: "ABO", qty: 50, required_date_code: "2024O1" },
      { line_id: "L2", part_no: "X1", qty: 10 },
    ],
  };
  const res = db.transaction((tx) => upsertPickingOrder(tx, "PE-1", body));
  assert.equal(res.created, true);
  const po = sqlite.prepare("SELECT status, ship_to FROM picking_orders WHERE external_id='PE-1'").get() as any;
  assert.equal(po.status, "pending");
  assert.equal(po.ship_to, "Acme");
  const items = sqlite.prepare("SELECT line_id, qty, remaining_qty FROM picking_items ORDER BY line_id").all() as any[];
  assert.deepEqual(items, [
    { line_id: "L1", qty: 50, remaining_qty: 50 },
    { line_id: "L2", qty: 10, remaining_qty: 10 },
  ]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("re-PUT identical picking payload is a no-op; update adds/changes/removes untouched lines", () => {
  const { sqlite, db } = makeDb();
  const v1: PickingPutBody = { order: { ref_no: "PO-1" }, items: [
    { line_id: "L1", part_no: "ABO", qty: 50 }, { line_id: "L2", part_no: "X1", qty: 10 }] };
  const r = db.transaction((tx) => upsertPickingOrder(tx, "PE-1", v1));
  const stamp = (sqlite.prepare("SELECT updated_at FROM picking_orders WHERE id=?").get(r.orderId) as any).updated_at;

  const noop = db.transaction((tx) => upsertPickingOrder(tx, "PE-1", v1));
  assert.equal(noop.changed, false);
  assert.equal((sqlite.prepare("SELECT updated_at FROM picking_orders WHERE id=?").get(r.orderId) as any).updated_at, stamp);

  const v2: PickingPutBody = { order: { ref_no: "PO-1" }, items: [
    { line_id: "L1", part_no: "ABO", qty: 80 },
    { line_id: "L3", part_no: "Z9", qty: 3 },
  ] };
  const r2 = db.transaction((tx) => upsertPickingOrder(tx, "PE-1", v2));
  assert.equal(r2.changed, true);
  const rows = sqlite.prepare("SELECT line_id, qty FROM picking_items ORDER BY line_id").all() as any[];
  assert.deepEqual(rows, [{ line_id: "L1", qty: 80 }, { line_id: "L3", qty: 3 }]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("picking: decreasing qty below picked+scanned is 409", () => {
  const { sqlite, db } = makeDb();
  const v1: PickingPutBody = { order: { ref_no: "PO" }, items: [{ line_id: "L1", part_no: "P", qty: 100 }] };
  const r = db.transaction((tx) => upsertPickingOrder(tx, "E", v1));
  sqlite.prepare("UPDATE picking_items SET picked_qty=40, scanned_not_boxed_qty=20 WHERE picking_order_id=?").run(r.orderId);
  const v2: PickingPutBody = { order: { ref_no: "PO" }, items: [{ line_id: "L1", part_no: "P", qty: 59 }] };
  assert.throws(() => db.transaction((tx) => upsertPickingOrder(tx, "E", v2)), (e: any) => e.status === 409);
  sqlite.close();
});

test("picking: removing a line that has allocations is 409", () => {
  const { sqlite, db } = makeDb();
  const v1: PickingPutBody = { order: { ref_no: "PO" }, items: [
    { line_id: "L1", part_no: "P", qty: 100 }, { line_id: "L2", part_no: "Q", qty: 5 }] };
  const r = db.transaction((tx) => upsertPickingOrder(tx, "E", v1));
  const l2 = (sqlite.prepare("SELECT id FROM picking_items WHERE line_id='L2'").get() as any).id;
  const pP = (sqlite.prepare("SELECT id FROM parts WHERE part_no_norm='P'").get() as any).id;
  // allocation must satisfy the target-XOR check -> point it at a real on-shelf lot
  sqlite.prepare(`INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, created_at, updated_at)
                  VALUES ('lot', ?, 'S1', 5, '0','0')`).run(pP);
  sqlite.prepare(`INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at)
                  VALUES ('a', ?, 5, 'lot', '0','0')`).run(l2);
  const v2: PickingPutBody = { order: { ref_no: "PO" }, items: [{ line_id: "L1", part_no: "P", qty: 100 }] };
  assert.throws(() => db.transaction((tx) => upsertPickingOrder(tx, "E", v2)), (e: any) => e.status === 409);
  sqlite.close();
});
