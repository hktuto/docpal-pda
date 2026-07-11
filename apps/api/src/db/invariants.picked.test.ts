import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { recomputePickingItem, scanToPackage, assignPackageToBox } from "./invariants.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'0','0');
  `);
  return { sqlite, db };
}

function row(sqlite: any) {
  return sqlite.prepare("SELECT picked_qty, scanned_not_boxed_qty, remaining_qty FROM picking_items WHERE id='pi'").get() as any;
}

test("recomputePickingItem maintains picked_qty = boxed sum (scanned -> boxed -> back)", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => scanToPackage(tx, { id: "pkg1", pickingItemId: "pi", qty: 4, sourceType: "inventory_lot", sourceId: "lotX" }));
  assert.deepEqual(row(sqlite), { picked_qty: 0, scanned_not_boxed_qty: 4, remaining_qty: 6 });

  sqlite.exec(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0')`);
  db.transaction((tx) => assignPackageToBox(tx, { packageId: "pkg1", shippingBoxId: "box" }));
  assert.deepEqual(row(sqlite), { picked_qty: 4, scanned_not_boxed_qty: 0, remaining_qty: 6 });

  // manual revert + recompute returns to scanned
  sqlite.exec(`UPDATE picking_packages SET shipping_box_id=NULL WHERE id='pkg1'`);
  db.transaction((tx) => recomputePickingItem(tx, "pi"));
  assert.deepEqual(row(sqlite), { picked_qty: 0, scanned_not_boxed_qty: 4, remaining_qty: 6 });
  assertInvariantsHold(db);
  sqlite.close();
});
