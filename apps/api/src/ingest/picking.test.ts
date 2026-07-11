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
