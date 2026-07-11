import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import {
  createShippingBox,
  cancelShippingBox,
  addPackageToBox,
  addAllUnboxedToBox,
  removePackageFromBox,
  maybeAutoFinishPickingOrder,
} from "./pickScan.js";
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
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shipping_box' AND to_status='cancelled'").get() as any).c, 1);
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

function seedScanned(sqlite: any, qty = 10) {
  // one unboxed scanned package of qty on item 'pi'
  sqlite.exec(`
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
    VALUES ('pp','pi','inventory_lot','lot',${qty},NULL,'0','0');
    UPDATE picking_items SET scanned_not_boxed_qty=${qty};
  `);
}

test("addPackageToBox moves package into the box: scanned drops, picked rises; auto-finish creates measuring task", () => {
  const { sqlite, db } = makeDb();
  seedScanned(sqlite, 10); // item qty is 10 -> fully boxed after this
  const boxId = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  db.transaction((tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: boxId, actorId: "u1" }));

  const pi = sqlite.prepare("SELECT picked_qty, scanned_not_boxed_qty, remaining_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { picked_qty: 10, scanned_not_boxed_qty: 0, remaining_qty: 0 });
  const po = sqlite.prepare("SELECT status FROM picking_orders WHERE id='po'").get() as any;
  assert.equal(po.status, "finished");
  const tasks = sqlite.prepare("SELECT picking_order_id, status FROM measuring_tasks").all() as any[];
  assert.deepEqual(tasks, [{ picking_order_id: "po", status: "pending" }]);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='picking_order' AND to_status='finished'").get() as any).c, 1);
  assertInvariantsHold(db);

  // idempotent: a second maybeAutoFinish does not duplicate the task or the transition
  db.transaction((tx) => { const done = maybeAutoFinishPickingOrder(tx, { pickingOrderId: "po" }); assert.equal(done, false); });
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM measuring_tasks").get() as any).c, 1);
  sqlite.close();
});

test("addPackageToBox guards: cross-order package 409, box not open 409, already-boxed 409", () => {
  const { sqlite, db } = makeDb();
  seedScanned(sqlite, 4);
  sqlite.exec(`INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po2','e2','R2','picking','0','0')`);
  const otherBox = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po2" }));
  assert.throws(() => db.transaction((tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: otherBox })), (e: any) => e.status === 409);

  const box = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  sqlite.prepare("UPDATE shipping_boxes SET status='closed' WHERE id=?").run(box);
  assert.throws(() => db.transaction((tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: box })), (e: any) => e.status === 409);

  sqlite.prepare("UPDATE shipping_boxes SET status='open' WHERE id=?").run(box);
  db.transaction((tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: box }));
  assert.throws(() => db.transaction((tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: box })), (e: any) => e.status === 409);
  sqlite.close();
});

test("addAllUnboxedToBox packs every unboxed package of the order; removePackageFromBox reverts picked/scanned", () => {
  const { sqlite, db } = makeDb();
  seedScanned(sqlite, 4);
  sqlite.exec(`INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
               VALUES ('pp2','pi','inventory_lot','lot',2,NULL,'0','0');
               UPDATE picking_items SET scanned_not_boxed_qty=6;`);
  const box = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  const n = db.transaction((tx) => addAllUnboxedToBox(tx, { shippingBoxId: box, actorId: "u1" }));
  assert.equal(n, 2);
  let pi = sqlite.prepare("SELECT picked_qty, scanned_not_boxed_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { picked_qty: 6, scanned_not_boxed_qty: 0 });

  db.transaction((tx) => removePackageFromBox(tx, { packageId: "pp2", actorId: "u1" }));
  pi = sqlite.prepare("SELECT picked_qty, scanned_not_boxed_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { picked_qty: 4, scanned_not_boxed_qty: 2 });
  const pkg = sqlite.prepare("SELECT shipping_box_id, verified FROM picking_packages WHERE id='pp2'").get() as any;
  assert.deepEqual(pkg, { shipping_box_id: null, verified: 0 });
  assertInvariantsHold(db);
  sqlite.close();
});
