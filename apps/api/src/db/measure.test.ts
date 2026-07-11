import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { updateShippingBoxMeasurements, verifyPackage, closeShippingBox } from "./measure.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at)
      VALUES ('po','e','R','finished','HK','HK','0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0');
  `);
  return { sqlite, db };
}

function box(sqlite: any) {
  return sqlite.prepare("SELECT box_size, net_weight_g, gross_weight_g, destination_country FROM shipping_boxes WHERE id='box'").get() as any;
}

test("updateShippingBoxMeasurements sets, parses and clears fields", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { boxSize: " 40x30x20 ", netWeightG: "500", grossWeightG: 800 } }));
  assert.deepEqual(box(sqlite), { box_size: "40x30x20", net_weight_g: 500, gross_weight_g: 800, destination_country: null });
  // explicit null clears; omitted fields stay
  db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { netWeightG: null, destinationCountry: " US " } }));
  assert.deepEqual(box(sqlite), { box_size: "40x30x20", net_weight_g: null, gross_weight_g: 800, destination_country: "US" });
  assertInvariantsHold(db);
  sqlite.close();
});

test("measurement guards: 404 missing, 400 bad weight, 409 closed box", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "nope", fields: { netWeightG: 1 } })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { netWeightG: "abc" } })), (e: any) => e.status === 400);
  assert.throws(() => db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { grossWeightG: 1.5 } })), (e: any) => e.status === 400);
  assert.throws(() => db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { grossWeightG: -1 } })), (e: any) => e.status === 400);
  sqlite.prepare("UPDATE shipping_boxes SET status='closed'").run();
  assert.throws(() => db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { boxSize: "x" } })), (e: any) => e.status === 409);
  sqlite.close();
});

// extra seed helper for package-verify tests (call inside each test after makeDb)
function seedPackableBox(sqlite: any) {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('pi','po','p',4,4,'0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
      VALUES ('pp','pi','inventory_lot','lot',4,'box','0','0');
    INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES ('mt','po','pending','0','0');
  `);
}

test("verifyPackage marks the package verified + logs transition", () => {
  const { sqlite, db } = makeDb();
  seedPackableBox(sqlite);
  db.transaction((tx) => verifyPackage(tx, { packageId: "pp", actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT verified FROM picking_packages WHERE id='pp'").get() as any).verified, 1);
  const logs = sqlite.prepare("SELECT entity_type, from_status, to_status, actor_id FROM transition_logs WHERE entity_type='picking_package'").all() as any[];
  assert.deepEqual(logs, [{ entity_type: "picking_package", from_status: "unverified", to_status: "verified", actor_id: "u1" }]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("verifyPackage guards: 404 missing, 409 not in box, 409 box closed, 409 task not pending, 409 already verified", () => {
  const { sqlite, db } = makeDb();
  seedPackableBox(sqlite);
  assert.throws(() => db.transaction((tx) => verifyPackage(tx, { packageId: "nope" })), (e: any) => e.status === 404);
  sqlite.prepare("UPDATE picking_packages SET shipping_box_id=NULL").run();
  assert.throws(() => db.transaction((tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_packages SET shipping_box_id='box'").run();
  sqlite.prepare("UPDATE shipping_boxes SET status='closed'").run();
  assert.throws(() => db.transaction((tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE shipping_boxes SET status='open'").run();
  sqlite.prepare("UPDATE measuring_tasks SET status='completed'").run();
  assert.throws(() => db.transaction((tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE measuring_tasks SET status='pending'").run();
  sqlite.prepare("UPDATE picking_packages SET verified=1").run();
  assert.throws(() => db.transaction((tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  sqlite.close();
});

function seedClosableBox(sqlite: any) {
  seedPackableBox(sqlite); // part, item (qty4/picked4), package pp (verified 0) in 'box', measuring task pending
  sqlite.exec(`UPDATE picking_packages SET verified=1;
               UPDATE shipping_boxes SET box_size='S', net_weight_g=500, gross_weight_g=800, destination_country=NULL;`);
}

test("closeShippingBox closes a fully-verified measured box and persists the destination fallback", () => {
  const { sqlite, db } = makeDb();
  seedClosableBox(sqlite);
  db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box", actorId: "u1" }));
  const b = sqlite.prepare("SELECT status, destination_country FROM shipping_boxes WHERE id='box'").get() as any;
  assert.deepEqual(b, { status: "closed", destination_country: "HK" }); // fell back to picking_orders.destination_country
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shipping_box' AND to_status='closed'").get() as any).c, 1);
  assertInvariantsHold(db);
  sqlite.close();
});

test("close guards: 404 missing, 409 not open, 409 empty, 409 unverified package, 409 missing measurements, 409 bad weights, 409 no destination", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "nope" })), (e: any) => e.status === 404);

  seedClosableBox(sqlite);
  sqlite.prepare("UPDATE picking_orders SET destination_country=NULL, ship_to=NULL").run();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // no destination anywhere
  sqlite.prepare("UPDATE picking_orders SET destination_country='HK'").run();

  sqlite.prepare("UPDATE shipping_boxes SET net_weight_g=NULL").run();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // weights required
  sqlite.prepare("UPDATE shipping_boxes SET net_weight_g=900").run(); // net 900 > gross 800
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE shipping_boxes SET net_weight_g=0").run();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // must be > 0
  sqlite.prepare("UPDATE shipping_boxes SET net_weight_g=500").run();

  sqlite.prepare("UPDATE picking_packages SET verified=0").run();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // unverified package
  sqlite.prepare("UPDATE picking_packages SET verified=1").run();

  // empty box
  sqlite.exec(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('boxE','po','open','0','0')`);
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "boxE" })), (e: any) => e.status === 409);

  // not open
  sqlite.prepare("UPDATE shipping_boxes SET status='closed' WHERE id='box'").run();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  sqlite.close();
});
