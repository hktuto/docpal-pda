import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestDb } from "./test-helper.js";
import { resetTables } from "./tables.js";
import { updateShippingBoxMeasurements, verifyPackage, closeShippingBox } from "./measure.js";
import { assertInvariantsHold } from "./invariants.guard.js";

const { sql: testSql, db } = await createTestDb();

test.beforeEach(async () => {
  await resetTables(db);
});

async function seedBase() {
  await db.execute(sql`
    INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at)
      VALUES ('po','e','R','finished','HK','HK','0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0');
  `);
}

async function box() {
  return (await db.execute<{ box_size: string | null; net_weight_g: number | null; gross_weight_g: number | null; destination_country: string | null }>(
    `SELECT box_size, net_weight_g, gross_weight_g, destination_country FROM shipping_boxes WHERE id='box'`
  ))[0];
}

test("updateShippingBoxMeasurements sets, parses and clears fields", async () => {
  await seedBase();
  await db.transaction(async (tx) =>
    updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { boxSize: " 40x30x20 ", netWeightG: "500", grossWeightG: 800 } })
  );
  assert.deepEqual(await box(), { box_size: "40x30x20", net_weight_g: 500, gross_weight_g: 800, destination_country: null });
  // explicit null clears; omitted fields stay
  await db.transaction(async (tx) =>
    updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { netWeightG: null, destinationCountry: " US " } })
  );
  assert.deepEqual(await box(), { box_size: "40x30x20", net_weight_g: null, gross_weight_g: 800, destination_country: "US" });
  await assertInvariantsHold(db);
});

test("measurement guards: 404 missing, 400 bad weight, 409 closed box", async () => {
  await seedBase();
  await assert.rejects(
    () => db.transaction(async (tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "nope", fields: { netWeightG: 1 } })),
    (e: any) => e.status === 404
  );
  await assert.rejects(
    () => db.transaction(async (tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { netWeightG: "abc" } })),
    (e: any) => e.status === 400
  );
  await assert.rejects(
    () => db.transaction(async (tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { grossWeightG: 1.5 } })),
    (e: any) => e.status === 400
  );
  await assert.rejects(
    () => db.transaction(async (tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { grossWeightG: -1 } })),
    (e: any) => e.status === 400
  );
  await db.execute(sql`UPDATE shipping_boxes SET status='closed'`);
  await assert.rejects(
    () => db.transaction(async (tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { boxSize: "x" } })),
    (e: any) => e.status === 409
  );
});

// extra seed helper for package-verify tests (call inside each test after makeDb)
async function seedPackableBox() {
  await db.execute(sql`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('pi','po','p',4,4,'0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
      VALUES ('pp','pi','inventory_lot','lot',4,'box','0','0');
    INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES ('mt','po','pending','0','0');
  `);
}

test("verifyPackage marks the package verified + logs transition", async () => {
  await seedBase();
  await seedPackableBox();
  await db.transaction(async (tx) => verifyPackage(tx, { packageId: "pp", actorId: "u1" }));
  assert.equal((await db.execute<{ verified: boolean }>(`SELECT verified FROM picking_packages WHERE id='pp'`))[0].verified, true);
  const logs = await db.execute<{ entity_type: string; from_status: string | null; to_status: string; actor_id: string }>(
    `SELECT entity_type, from_status, to_status, actor_id FROM transition_logs WHERE entity_type='picking_package'`
  );
  assert.deepEqual(Array.from(logs), [{ entity_type: "picking_package", from_status: "unverified", to_status: "verified", actor_id: "u1" }]);
  await assertInvariantsHold(db);
});

test("verifyPackage guards: 404 missing, 409 not in box, 409 box closed, 409 task not pending, 409 already verified", async () => {
  await seedBase();
  await seedPackableBox();
  await assert.rejects(() => db.transaction(async (tx) => verifyPackage(tx, { packageId: "nope" })), (e: any) => e.status === 404);
  await db.execute(sql`UPDATE picking_packages SET shipping_box_id=NULL`);
  await assert.rejects(() => db.transaction(async (tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  await db.execute(sql`UPDATE picking_packages SET shipping_box_id='box'`);
  await db.execute(sql`UPDATE shipping_boxes SET status='closed'`);
  await assert.rejects(() => db.transaction(async (tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  await db.execute(sql`UPDATE shipping_boxes SET status='open'`);
  await db.execute(sql`UPDATE measuring_tasks SET status='completed'`);
  await assert.rejects(() => db.transaction(async (tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  await db.execute(sql`UPDATE measuring_tasks SET status='pending'`);
  await db.execute(sql`UPDATE picking_packages SET verified=true`);
  await assert.rejects(() => db.transaction(async (tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
});

async function seedClosableBox() {
  await seedPackableBox(); // part, item (qty4/picked4), package pp (verified false) in 'box', measuring task pending
  await db.execute(sql`UPDATE picking_packages SET verified=true`);
  await db.execute(sql`UPDATE shipping_boxes SET box_size='S', net_weight_g=500, gross_weight_g=800, destination_country=NULL`);
}

test("closeShippingBox closes a fully-verified measured box and persists the destination fallback", async () => {
  await seedBase();
  await seedClosableBox();
  await db.transaction(async (tx) => closeShippingBox(tx, { shippingBoxId: "box", actorId: "u1" }));
  const b = (await db.execute<{ status: string; destination_country: string | null }>(
    `SELECT status, destination_country FROM shipping_boxes WHERE id='box'`
  ))[0];
  assert.deepEqual(b, { status: "closed", destination_country: "HK" }); // fell back to picking_orders.destination_country
  assert.equal((await db.execute<{ c: number }>(`SELECT COUNT(*)::int AS c FROM transition_logs WHERE entity_type='shipping_box' AND to_status='closed'`))[0].c, 1);
  await assertInvariantsHold(db);
});

test("close guards: 404 missing, 409 not open, 409 empty, 409 unverified package, 409 missing measurements, 409 bad weights, 409 no destination", async () => {
  await seedBase();
  await assert.rejects(() => db.transaction(async (tx) => closeShippingBox(tx, { shippingBoxId: "nope" })), (e: any) => e.status === 404);

  await seedClosableBox();
  await db.execute(sql`UPDATE picking_orders SET destination_country=NULL, ship_to=NULL`);
  await assert.rejects(() => db.transaction(async (tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // no destination anywhere
  await db.execute(sql`UPDATE picking_orders SET destination_country='HK'`);

  await db.execute(sql`UPDATE shipping_boxes SET net_weight_g=NULL`);
  await assert.rejects(() => db.transaction(async (tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // weights required
  await db.execute(sql`UPDATE shipping_boxes SET net_weight_g=900`); // net 900 > gross 800
  await assert.rejects(() => db.transaction(async (tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  await db.execute(sql`UPDATE shipping_boxes SET net_weight_g=0`);
  await assert.rejects(() => db.transaction(async (tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // must be > 0
  await db.execute(sql`UPDATE shipping_boxes SET net_weight_g=500`);

  await db.execute(sql`UPDATE picking_packages SET verified=false`);
  await assert.rejects(() => db.transaction(async (tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // unverified package
  await db.execute(sql`UPDATE picking_packages SET verified=true`);

  // empty box
  await db.execute(sql`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('boxE','po','open','0','0')`);
  await assert.rejects(() => db.transaction(async (tx) => closeShippingBox(tx, { shippingBoxId: "boxE" })), (e: any) => e.status === 409);

  // not open
  await db.execute(sql`UPDATE shipping_boxes SET status='closed' WHERE id='box'`);
  await assert.rejects(() => db.transaction(async (tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
});

test.after(async () => {
  await testSql.end();
});
