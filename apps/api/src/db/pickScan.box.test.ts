import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { createShippingBox, cancelShippingBox } from "./pickScan.js";
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

test("createShippingBox creates an open box + transition log; cancel removes an empty open box", () => {
  const { sqlite, db } = makeDb();
  const boxId = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po", actorId: "u1" }));
  const box = sqlite.prepare("SELECT status, picking_order_id FROM shipping_boxes WHERE id=?").get(boxId) as any;
  assert.deepEqual(box, { status: "open", picking_order_id: "po" });
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shipping_box' AND to_status='open'").get() as any).c, 1);

  db.transaction((tx) => cancelShippingBox(tx, { shippingBoxId: boxId, actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM shipping_boxes").get() as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("box guards: create on finished/issue order is 409; cancel non-empty or non-open box is 409; missing is 404", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "nope" })), (e: any) => e.status === 404);
  sqlite.prepare("UPDATE picking_orders SET status='finished'").run();
  assert.throws(() => db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_orders SET status='issue'").run();
  assert.throws(() => db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_orders SET status='picking'").run();

  const boxId = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  // non-empty
  sqlite.prepare(`INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
                  VALUES ('pp','pi','inventory_lot','lot',1,?,'0','0')`).run(boxId);
  assert.throws(() => db.transaction((tx) => cancelShippingBox(tx, { shippingBoxId: boxId })), (e: any) => e.status === 409);
  sqlite.prepare("DELETE FROM picking_packages").run();
  // non-open
  sqlite.prepare("UPDATE shipping_boxes SET status='closed' WHERE id=?").run(boxId);
  assert.throws(() => db.transaction((tx) => cancelShippingBox(tx, { shippingBoxId: boxId })), (e: any) => e.status === 409);
  assert.throws(() => db.transaction((tx) => cancelShippingBox(tx, { shippingBoxId: "nope" })), (e: any) => e.status === 404);
  sqlite.close();
});
