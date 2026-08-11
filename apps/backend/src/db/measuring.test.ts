import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import { allocateAll } from "./allocate.js";
import {
  addAllUnboxedToShippingBox,
  closeShippingBox,
  createShippingBox,
  scanPickingItem,
  updateShippingBox,
  verifyPackage,
} from "./picking.js";
import { getMeasuringBoxDetail, listMeasuringBoxes } from "./measuring.js";
import { _setFlowStepsDisabledForTests, type FlowStep } from "../config.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

/** Reseed + reset the flow-step override to the default (all enabled). */
async function reset(disabled: FlowStep[] = []): Promise<void> {
  await reseed(client);
  _setFlowStepsDisabledForTests(disabled);
}

// --- business-key lookups (never hardcode seed UUIDs) ------------------------

async function actorIdOf(username = "operator"): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

async function pickingOrderIdOf(orderNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM picking_orders WHERE order_no = ${orderNo}`);
  return row!.id;
}

async function pickingItemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT pi.id FROM picking_items pi
        WHERE pi.picking_order_id = ${orderId} AND pi.part_no = ${partNo}`
  );
  return row!.id;
}

async function allocationIdOf(pickingItemId: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  return row!.id;
}

async function catchHttp(p: Promise<unknown>): Promise<HTTPException> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${err}`);
    return err;
  }
  assert.fail("expected HTTPException");
}

interface FinishedFixture {
  orderId: string;
  actorId: string;
  boxId: string;
  packageIds: string[];
}

/**
 * The seeded pending order (SO-DEMO-0001) driven to auto-finish through the
 * domain functions: allocate → scan all three items in full → box all. The
 * box is left OPEN (open boxes with packages are the measuring work list).
 */
async function finishedOrder(): Promise<FinishedFixture> {
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 1000
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F"); // qty 500
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G"); // qty 300, from the A-01-02 / BOX-H-20260701-0002 lot
  const p1 = (await scanPickingItem(client.db, item1, { actorId, allocationId: await allocationIdOf(item1), qty: 1000 })).packageIds[0];
  const p2 = (await scanPickingItem(client.db, item2, { actorId, allocationId: await allocationIdOf(item2), qty: 500 })).packageIds[0];
  const p3 = (await scanPickingItem(client.db, item3, { actorId, allocationId: await allocationIdOf(item3), qty: 300 })).packageIds[0];
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId }); // auto-finishes
  return { orderId, actorId, boxId: box.id, packageIds: [p1, p2, p3] };
}

/** Verify the given packages, stamp measurements (kg), close the box. */
async function closeTheBox(boxId: string, actorId: string, packageIds: string[]): Promise<void> {
  for (const packageId of packageIds) {
    await verifyPackage(client.db, { packageId, actorId });
  }
  await updateShippingBox(client.db, boxId, { actorId, boxSize: "26 X 20 X 20", netWeightKg: 0.5, grossWeightKg: 0.8 });
  await closeShippingBox(client.db, { shippingBoxId: boxId, actorId });
}

// --- list ----------------------------------------------------------------------

test("list: open boxes with packages only; orderNos/packageCount/verifiedCount; close removes the row", async () => {
  await reset();
  const { actorId, boxId, packageIds } = await finishedOrder();

  // an empty open box is not measuring work
  const emptyOrderId = await pickingOrderIdOf("SO-DEMO-0002");
  await createShippingBox(client.db, { pickingOrderId: emptyOrderId, actorId });

  const rows = await listMeasuringBoxes(client.db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.boxId, boxId);
  assert.equal(row.status, "open");
  assert.deepEqual(row.orderNos, ["SO-DEMO-0001"]);
  assert.equal(row.packageCount, 3);
  assert.equal(row.verifiedCount, 0);
  assert.ok(row.createdDate);

  await verifyPackage(client.db, { packageId: packageIds[0], actorId });
  await verifyPackage(client.db, { packageId: packageIds[1], actorId });
  assert.equal((await listMeasuringBoxes(client.db))[0].verifiedCount, 2);

  await closeTheBox(boxId, actorId, [packageIds[2]]); // the first two are already verified
  assert.equal((await listMeasuringBoxes(client.db)).length, 0);
});

// --- detail --------------------------------------------------------------------

test("detail: box fields + packages with part identity + suggestedNetWeightKg; 404", async () => {
  await reset();
  const { orderId, boxId, packageIds } = await finishedOrder();

  const detail = await getMeasuringBoxDetail(client.db, boxId);
  assert.equal(detail.boxId, boxId);
  assert.equal(detail.pickingOrderId, orderId);
  assert.equal(detail.status, "open");
  assert.equal(detail.boxSize, null);
  assert.equal(detail.grossWeight, null);
  assert.equal(detail.netWeight, null);
  assert.equal(detail.destinationCountry, null);
  assert.equal(detail.shippedAt, null);
  assert.ok(detail.createdDate);
  // 1000 pcs + 500 pcs at 6.3 g per 1000 pcs = 9.45 g → 0.009 kg
  // (the 181G package has no net_weight_formula row, so it contributes 0)
  assert.equal(detail.suggestedNetWeightKg, 0.009);

  assert.equal(detail.packages.length, 3);
  const byPartNo = new Map(detail.packages.map((p) => [p.partNo, p]));
  const pkg1 = byPartNo.get("RK73H1JTTD1002F")!;
  assert.equal(pkg1.id, packageIds[0]);
  assert.equal(pkg1.qty, 1000);
  assert.equal(pkg1.dateCode, "2603");
  assert.equal(pkg1.lotCode, "L2603A");
  assert.equal(pkg1.coo, "JP");
  assert.equal(pkg1.cow, "JP");
  assert.equal(pkg1.verified, false);
  assert.equal(pkg1.verifyVerified, false);
  assert.equal(pkg1.wclItemNo, "RK73H1JTTD1002F");
  const pkg2 = byPartNo.get("RK73H1JTTD2202F")!;
  assert.equal(pkg2.id, packageIds[1]);
  assert.equal(pkg2.qty, 500);
  assert.equal(pkg2.dateCode, "2603");
  assert.equal(pkg2.lotCode, "L2603B");
  const pkg3 = byPartNo.get("RK73B1JTTD181G")!;
  assert.equal(pkg3.id, packageIds[2]);
  assert.equal(pkg3.qty, 300);
  assert.equal(pkg3.dateCode, "2604");
  assert.equal(pkg3.lotCode, "L2604A");

  const notFound = await catchHttp(getMeasuringBoxDetail(client.db, randomUUID()));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "shipping_box_not_found");
});

test("detail: suggested net weight is null when no package has a formula row", async () => {
  await reset();
  const actorId = await actorIdOf();
  // RK73B1JTTD181G is seeded without a net_weight_formula row
  const bareOrderId = randomUUID();
  const bareItemId = randomUUID();
  const bareBoxId = "BOX-S-BARE-1";
  await client.db.execute(sql`INSERT INTO picking_orders (id, order_no, status, created_date, last_update_date)
      VALUES (${bareOrderId}, 'SO-BARE', 'finished', now(), now())`);
  await client.db.execute(sql`INSERT INTO picking_items (id, picking_order_id, part_no, qty, line_id, line_number, shipment_number, created_date, last_update_date)
      VALUES (${bareItemId}, ${bareOrderId}, 'RK73B1JTTD181G', 100, 9003, 1, 1, now(), now())`);
  await client.db.execute(sql`INSERT INTO shipping_boxes (id, picking_order_id, status, created_date, last_update_date)
      VALUES (${bareBoxId}, ${bareOrderId}, 'open', now(), now())`);
  await client.db.execute(sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_date, last_update_date)
      VALUES (${randomUUID()}, ${bareItemId}, ${bareOrderId}, 'inventory_lot', 'bare-src', 100, ${bareBoxId}, now(), now())`);

  const detail = await getMeasuringBoxDetail(client.db, bareBoxId);
  assert.equal(detail.suggestedNetWeightKg, null);
  assert.equal(detail.packages.length, 1);
});

// --- close chain + config combinations --------------------------------------------

test("close IS the measuring completion: spawns the box's verify task when verify is enabled", async () => {
  await reset();
  const { orderId, boxId, actorId, packageIds } = await finishedOrder();
  await closeTheBox(boxId, actorId, packageIds);

  const box = await queryGet<{ status: string; destinationCountry: string | null }>(
    client.db,
    sql`SELECT status, destination_country AS "destinationCountry" FROM shipping_boxes WHERE id = ${boxId}`
  );
  assert.deepEqual(box, { status: "closed", destinationCountry: "ACME Electronics (HK)" });

  const task = await queryGet<{ status: string; shippingBoxId: string }>(
    client.db,
    sql`SELECT status, shipping_box_id AS "shippingBoxId" FROM verify_tasks WHERE shipping_box_id = ${boxId}`
  );
  assert.deepEqual(task, { status: "pending", shippingBoxId: boxId });

  // the order stays finished; no measuring task table exists at all
  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "finished");
});

test("close: verify disabled → no verify task; measuring disabled → close guards unchanged", async () => {
  await reset(["verify"]);
  const fx = await finishedOrder();
  await closeTheBox(fx.boxId, fx.actorId, fx.packageIds);
  const task = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM verify_tasks WHERE shipping_box_id = ${fx.boxId}`
  );
  assert.equal(task, undefined);
  const box = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM shipping_boxes WHERE id = ${fx.boxId}`);
  assert.equal(box!.status, "closed");

  // measuring step off no longer changes the close guards: the same
  // measurement requirements apply (unverified packages block the close)
  await reset(["measuring"]);
  const fx2 = await finishedOrder();
  const unverified = await catchHttp(closeShippingBox(client.db, { shippingBoxId: fx2.boxId, actorId: fx2.actorId }));
  assert.equal(unverified.status, 409);
  assert.equal(unverified.message, "all_packages_must_be_verified");
  await closeTheBox(fx2.boxId, fx2.actorId, fx2.packageIds);
  // verify step still enabled here → the box's verify task spawned
  const task2 = await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM verify_tasks WHERE shipping_box_id = ${fx2.boxId}`
  );
  assert.equal(task2!.status, "pending");
});
