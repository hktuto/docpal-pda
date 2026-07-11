import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { scanToPackage, assignPackageToBox } from "./invariants.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'0','0');
    INSERT INTO inventory_lots (id, part_id, total_qty, created_at, updated_at) VALUES ('lot','p',10,'0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0');
  `);
  return { sqlite, db };
}

test("scan unboxed then assign to box keeps scanned_not_boxed and remaining correct", () => {
  const { sqlite, db } = makeDb();
  scanToPackage(db, { id: "pp1", pickingItemId: "pi", qty: 3, sourceType: "inventory_lot", sourceId: "lot" });
  scanToPackage(db, { id: "pp2", pickingItemId: "pi", qty: 2, sourceType: "inventory_lot", sourceId: "lot" });
  let pi = sqlite.prepare("SELECT scanned_not_boxed_qty s, remaining_qty r FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { s: 5, r: 5 }); // remaining generated: 10 - 0 - 5

  assignPackageToBox(db, { packageId: "pp1", shippingBoxId: "box" });
  pi = sqlite.prepare("SELECT scanned_not_boxed_qty s, remaining_qty r FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { s: 2, r: 8 }); // 10 - 0 - 2
  sqlite.close();
});
