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
import { completeVerifyTask } from "./verify.js";
import { listShippingOrders, shipOrder } from "./shipping.js";
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

/** The seeded pending order driven to auto-finish (box left OPEN). */
async function finishedOrder(): Promise<FinishedFixture> {
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 1000
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F"); // qty 500
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G"); // qty 300 (A-01-02 / BOX-H-20260701-0002 lot)
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

async function verifyTaskOf(orderId: string): Promise<{ id: string; status: string } | undefined> {
  return queryGet<{ id: string; status: string }>(
    client.db,
    sql`SELECT id, status FROM verify_tasks WHERE picking_order_id = ${orderId}`
  );
}

/** Default config: order in the feed (verify task completed). */
async function shippedReadyOrder(): Promise<FinishedFixture> {
  const fx = await finishedOrder();
  await closeTheBox(fx.boxId, fx.actorId, fx.packageIds); // measuring auto-completes, verify spawns
  const vt = (await verifyTaskOf(fx.orderId))!;
  for (const packageId of fx.packageIds) {
    await verifyPackage(client.db, { packageId, actorId: fx.actorId }); // verify-step re-scan
  }
  await completeVerifyTask(client.db, { taskId: vt.id, actorId: fx.actorId });
  return fx;
}

// --- ship ---------------------------------------------------------------------

test("ship: happy path under the default config (verify enabled) — status, stamps, feed, log, event, second ship 409", async () => {
  await reset();
  const { orderId, actorId } = await shippedReadyOrder();

  const feedBefore = await listShippingOrders(client.db);
  assert.equal(feedBefore.length, 1);

  const res = await shipOrder(client.db, orderId, actorId);
  assert.deepEqual(res, { id: orderId, status: "shipped" });

  const order = await queryGet<{ status: string; shippedAt: Date | null; shippedBy: string | null }>(
    client.db,
    sql`SELECT status, shipped_at AS "shippedAt", shipped_by AS "shippedBy" FROM picking_orders WHERE id = ${orderId}`
  );
  assert.equal(order!.status, "shipped");
  assert.ok(order!.shippedAt);
  assert.equal(order!.shippedBy, actorId);

  // out of the feed
  assert.equal((await listShippingOrders(client.db)).length, 0);

  // transaction_logs row
  const log = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId} AND to_state = 'shipped'`
  );
  assert.deepEqual(log, { fromState: "finished", toState: "shipped", actorId });

  // SSE event on both topics
  const evt = await queryGet<{ type: string; topics: string[] }>(
    client.db,
    sql`SELECT type, topics FROM app_events WHERE type = 'picking_order.shipped' ORDER BY id DESC LIMIT 1`
  );
  assert.ok(evt);
  assert.deepEqual(evt!.topics, ["/picking-orders", "/shipping-orders"]);

  // already shipped → 409
  const again = await catchHttp(shipOrder(client.db, orderId, actorId));
  assert.equal(again.status, 409);
  assert.equal(again.message, "order_not_ready_to_ship");
});

test("ship: 409 order_not_ready_to_ship — pending order, and finished order whose verify task is still pending", async () => {
  await reset();
  const actorId = await actorIdOf();
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");

  // plain pending order: no completed verify task
  const pending = await catchHttp(shipOrder(client.db, orderId, actorId));
  assert.equal(pending.status, 409);
  assert.equal(pending.message, "order_not_ready_to_ship");

  // finished with the verify task still pending → not in the feed yet
  const fx = await finishedOrder();
  await closeTheBox(fx.boxId, fx.actorId, fx.packageIds);
  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "finished");
  assert.equal((await listShippingOrders(client.db)).length, 0);

  const notReady = await catchHttp(shipOrder(client.db, orderId, actorId));
  assert.equal(notReady.status, 409);
  assert.equal(notReady.message, "order_not_ready_to_ship");
});

test("ship: 404 picking_order_not_found + 400 actor_not_found", async () => {
  await reset();
  const { orderId, actorId } = await shippedReadyOrder();

  const notFound = await catchHttp(shipOrder(client.db, randomUUID(), actorId));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "picking_order_not_found");

  const badActor = await catchHttp(shipOrder(client.db, orderId, randomUUID()));
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");
});

test("ship: verify disabled — completed measuring task is shippable", async () => {
  await reset(["verify"]);
  const { orderId, actorId, boxId, packageIds } = await finishedOrder();
  await closeTheBox(boxId, actorId, packageIds); // measuring auto-completes, no verify task

  const feed = await listShippingOrders(client.db);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].source, "measuring");

  const res = await shipOrder(client.db, orderId, actorId);
  assert.deepEqual(res, { id: orderId, status: "shipped" });
  assert.equal((await listShippingOrders(client.db)).length, 0);
});

test("ship: measuring + verify disabled — finished order with no tasks is shippable", async () => {
  await reset(["measuring", "verify"]);
  const { orderId, actorId, boxId } = await finishedOrder();

  await updateShippingBox(client.db, boxId, { actorId, boxSize: "26 X 20 X 20", netWeightKg: 0.5, grossWeightKg: 0.8 });
  // close requires verified packages; no task gate in this mode → flag via SQL
  await client.db.execute(sql`UPDATE picking_packages SET verified = true WHERE shipping_box_id = ${boxId}`);
  await closeShippingBox(client.db, { shippingBoxId: boxId, actorId });

  const feed = await listShippingOrders(client.db);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].source, "picking");

  const res = await shipOrder(client.db, orderId, actorId);
  assert.deepEqual(res, { id: orderId, status: "shipped" });
  assert.equal((await listShippingOrders(client.db)).length, 0);
});
