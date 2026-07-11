import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { completeMeasuringTask, verifyShippingBox, completeVerificationTask } from "./measure.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','finished','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('pi','po','p',4,4,'0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','closed','0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, verified, created_at, updated_at)
      VALUES ('pp','pi','inventory_lot','lot',4,'box',1,'0','0');
    INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES ('mt','po','pending','0','0');
  `);
  return { sqlite, db };
}

test("completeMeasuringTask completes the task and creates a pre_shipment verification task", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: "mt", actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT status FROM measuring_tasks WHERE id='mt'").get() as any).status, "completed");
  const vts = sqlite.prepare("SELECT kind, status, picking_order_id FROM verification_tasks").all() as any[];
  assert.deepEqual(vts, [{ kind: "pre_shipment", status: "pending", picking_order_id: "po" }]);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='measuring_task' AND to_status='completed'").get() as any).c, 1);
  assertInvariantsHold(db);

  // a second completion attempt is 409 (no longer pending) and still only one verification task
  assert.throws(() => db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: "mt" })), (e: any) => e.status === 409);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM verification_tasks").get() as any).c, 1);
  sqlite.close();
});

test("completeMeasuringTask guards: 404 missing, 409 open box, 409 under-packed item", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: "nope" })), (e: any) => e.status === 404);
  sqlite.prepare("UPDATE shipping_boxes SET status='open'").run();
  assert.throws(() => db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: "mt" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE shipping_boxes SET status='closed'").run();
  sqlite.prepare("UPDATE picking_packages SET qty=3").run(); // packed 3 != picked 4
  assert.throws(() => db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: "mt" })), (e: any) => e.status === 409);
  sqlite.close();
});

function seedPreShipment(sqlite: any) {
  // measuring already completed; one closed box with a verified package; pending pre_shipment task
  sqlite.exec(`
    UPDATE measuring_tasks SET status='completed';
    INSERT INTO verification_tasks (id, kind, status, picking_order_id, created_at, updated_at) VALUES ('vt','pre_shipment','pending','po','0','0');
  `);
}

test("verifyShippingBox marks a closed box verified; completeVerificationTask completes when all boxes verified", () => {
  const { sqlite, db } = makeDb();
  seedPreShipment(sqlite);
  db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: "box", actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT status FROM shipping_boxes WHERE id='box'").get() as any).status, "verified");
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shipping_box' AND to_status='verified'").get() as any).c, 1);

  db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: "vt", actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT status FROM verification_tasks WHERE id='vt'").get() as any).status, "completed");
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='verification_task' AND to_status='completed'").get() as any).c, 1);
  assertInvariantsHold(db);
  sqlite.close();
});

test("verify/complete guards: box must be closed, task must be pending, all boxes verified before completion", () => {
  const { sqlite, db } = makeDb();
  seedPreShipment(sqlite);
  // box still open -> 409
  sqlite.prepare("UPDATE shipping_boxes SET status='open'").run();
  assert.throws(() => db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE shipping_boxes SET status='closed'").run();
  // unverified package -> 409
  sqlite.prepare("UPDATE picking_packages SET verified=0").run();
  assert.throws(() => db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_packages SET verified=1").run();
  // complete before box verified -> 409
  assert.throws(() => db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: "vt" })), (e: any) => e.status === 409);
  // missing task -> 404; missing box -> 404
  assert.throws(() => db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: "nope" })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: "nope" })), (e: any) => e.status === 404);
  // no pending pre_shipment task for the order -> 409
  sqlite.prepare("UPDATE verification_tasks SET status='completed'").run();
  assert.throws(() => db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  sqlite.close();
});
