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
import { getShippingOrderDetail, listShippingOrders, shipShippingBox } from "./shipping.js";
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

interface ClosedBoxFixture {
  orderId: string;
  actorId: string;
  boxId: string;
  packageIds: string[];
}

/** The seeded pending order (SO-DEMO-0001) driven through pack + measure:
 *  allocate → scan all three items in full → box all (auto-finish) → verify,
 *  measure, close (spawns the box's pending verify task when enabled). */
async function closedBox(): Promise<ClosedBoxFixture> {
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
  for (const packageId of [p1, p2, p3]) {
    await verifyPackage(client.db, { packageId, actorId });
  }
  await updateShippingBox(client.db, box.id, { actorId, boxSize: "26 X 20 X 20", netWeightKg: 0.5, grossWeightKg: 0.8 });
  await closeShippingBox(client.db, { shippingBoxId: box.id, actorId });
  return { orderId, actorId, boxId: box.id, packageIds: [p1, p2, p3] };
}

async function verifyTaskOf(boxId: string): Promise<{ id: string; status: string } | undefined> {
  return queryGet<{ id: string; status: string }>(
    client.db,
    sql`SELECT id, status FROM verify_tasks WHERE shipping_box_id = ${boxId}`
  );
}

/** Default config: box in the feed (verify task completed). */
async function shippedReadyBox(): Promise<ClosedBoxFixture> {
  const fx = await closedBox();
  const vt = (await verifyTaskOf(fx.boxId))!;
  for (const packageId of fx.packageIds) {
    await verifyPackage(client.db, { packageId, actorId: fx.actorId }); // verify-step re-scan
  }
  await completeVerifyTask(client.db, { taskId: vt.id, actorId: fx.actorId });
  return fx;
}

// --- feed ---------------------------------------------------------------------

test("feed: closed unshipped boxes only, verify-gated when the step is enabled", async () => {
  await reset();
  const fx = await closedBox();

  // closed, but the verify task is still pending → not in the feed
  assert.equal((await listShippingOrders(client.db)).length, 0);
  // an open box is never feed material either
  const otherOrderId = await pickingOrderIdOf("SO-DEMO-0002");
  await createShippingBox(client.db, { pickingOrderId: otherOrderId, actorId: fx.actorId });

  const vt = (await verifyTaskOf(fx.boxId))!;
  for (const packageId of fx.packageIds) {
    await verifyPackage(client.db, { packageId, actorId: fx.actorId });
  }
  await completeVerifyTask(client.db, { taskId: vt.id, actorId: fx.actorId });

  const feed = await listShippingOrders(client.db);
  assert.equal(feed.length, 1);
  const row = feed[0];
  assert.equal(row.boxId, fx.boxId);
  assert.deepEqual(row.orderNos, ["SO-DEMO-0001"]);
  assert.deepEqual(row.shipTos, ["ACME Electronics (HK)"]);
  assert.equal(row.destinationCountry, "ACME Electronics (HK)");
  assert.equal(row.boxSize, "26 X 20 X 20");
  assert.equal(row.netWeight, 0.5);
  assert.equal(row.grossWeight, 0.8);
  assert.equal(row.packageCount, 3);
  assert.ok(row.closedAt);
});

test("feed: verify disabled → a closed box is feed-ready without any task", async () => {
  await reset(["verify"]);
  await closedBox();
  const feed = await listShippingOrders(client.db);
  assert.equal(feed.length, 1);
  assert.deepEqual(feed[0].orderNos, ["SO-DEMO-0001"]);
});

// --- detail -------------------------------------------------------------------

test("detail: box + packages (part identity) + orders involved; 404", async () => {
  await reset();
  const { orderId, boxId, packageIds } = await shippedReadyBox();

  const detail = await getShippingOrderDetail(client.db, boxId);
  assert.equal(detail.box.boxId, boxId);
  assert.equal(detail.box.pickingOrderId, orderId);
  assert.equal(detail.box.status, "closed");
  assert.equal(detail.box.boxSize, "26 X 20 X 20");
  assert.equal(detail.box.shippedAt, null);
  assert.equal(detail.box.shippedBy, null);

  assert.deepEqual(
    detail.packages.map((p) => p.id).sort(),
    [...packageIds].sort()
  );
  const byPartNo = new Map(detail.packages.map((p) => [p.partNo, p]));
  assert.equal(byPartNo.get("RK73H1JTTD1002F")!.wclItemNo, "RK73H1JTTD1002F");

  assert.deepEqual(detail.orders, [
    {
      id: orderId,
      orderNo: "SO-DEMO-0001",
      status: "finished",
      shipTo: "ACME Electronics (HK)",
      customerCode: "ACME",
      poNo: "CUST-PO-9001",
    },
  ]);

  const notFound = await catchHttp(getShippingOrderDetail(client.db, randomUUID()));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "shipping_box_not_found");
});

// --- ship ---------------------------------------------------------------------

test("ship: happy path — box stamps, order derives shipped, feed, logs, event, second ship 409", async () => {
  await reset();
  const { orderId, actorId, boxId } = await shippedReadyBox();

  assert.equal((await listShippingOrders(client.db)).length, 1);

  const res = await shipShippingBox(client.db, boxId, actorId);
  assert.deepEqual(res, { id: boxId, status: "shipped", shippedOrderIds: [orderId] });

  const box = await queryGet<{ shippedAt: Date | null; shippedBy: string | null }>(
    client.db,
    sql`SELECT shipped_at AS "shippedAt", shipped_by AS "shippedBy" FROM shipping_boxes WHERE id = ${boxId}`
  );
  assert.ok(box!.shippedAt);
  assert.equal(box!.shippedBy, actorId);

  const order = await queryGet<{ status: string; shippedAt: Date | null; shippedBy: string | null }>(
    client.db,
    sql`SELECT status, shipped_at AS "shippedAt", shipped_by AS "shippedBy" FROM picking_orders WHERE id = ${orderId}`
  );
  assert.equal(order!.status, "shipped");
  assert.ok(order!.shippedAt);
  assert.equal(order!.shippedBy, actorId);

  // out of the feed
  assert.equal((await listShippingOrders(client.db)).length, 0);

  // transaction_logs rows: the box and the derived order
  const boxLog = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'shipping_box' AND entity_id = ${boxId} AND to_state = 'shipped'`
  );
  assert.deepEqual(boxLog, { fromState: "closed", toState: "shipped", actorId });
  const orderLog = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId} AND to_state = 'shipped'`
  );
  assert.deepEqual(orderLog, { fromState: "finished", toState: "shipped", actorId });

  // SSE event on both topics; the old order event is gone
  const evt = await queryGet<{ type: string; topics: string[] }>(
    client.db,
    sql`SELECT type, topics FROM app_events WHERE type = 'shipping_box.shipped' ORDER BY id DESC LIMIT 1`
  );
  assert.ok(evt);
  assert.deepEqual(evt!.topics, ["/shipping-orders", "/picking-orders"]);
  const oldEvt = await queryGet<{ id: number }>(client.db, sql`SELECT id FROM app_events WHERE type = 'picking_order.shipped'`);
  assert.equal(oldEvt, undefined);

  // already shipped → 409
  const again = await catchHttp(shipShippingBox(client.db, boxId, actorId));
  assert.equal(again.status, 409);
  assert.equal(again.message, "box_not_ready_to_ship");
});

test("ship: 409 box_not_ready_to_ship — open box, and closed box whose verify task is still pending", async () => {
  await reset();
  const actor = await actorIdOf();

  // open box → not shippable
  const openOrderId = await pickingOrderIdOf("SO-DEMO-0001");
  const openBox = await createShippingBox(client.db, { pickingOrderId: openOrderId, actorId: actor });
  const open = await catchHttp(shipShippingBox(client.db, openBox.id, actor));
  assert.equal(open.status, 409);
  assert.equal(open.message, "box_not_ready_to_ship");

  // closed, verify task pending → not in the feed yet
  const fx = await closedBox();
  assert.equal((await listShippingOrders(client.db)).length, 0);
  const notReady = await catchHttp(shipShippingBox(client.db, fx.boxId, actor));
  assert.equal(notReady.status, 409);
  assert.equal(notReady.message, "box_not_ready_to_ship");
});

test("ship: 404 shipping_box_not_found + 400 actor_not_found", async () => {
  await reset();
  const { actorId, boxId } = await shippedReadyBox();

  const notFound = await catchHttp(shipShippingBox(client.db, randomUUID(), actorId));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "shipping_box_not_found");

  const badActor = await catchHttp(shipShippingBox(client.db, boxId, randomUUID()));
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");
});

test("ship: verify disabled — a plain closed box is shippable", async () => {
  await reset(["verify"]);
  const { orderId, actorId, boxId } = await closedBox();

  const feed = await listShippingOrders(client.db);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].boxId, boxId);

  const res = await shipShippingBox(client.db, boxId, actorId);
  assert.deepEqual(res, { id: boxId, status: "shipped", shippedOrderIds: [orderId] });
  assert.equal((await listShippingOrders(client.db)).length, 0);
});

// --- multi-order box -------------------------------------------------------------

interface ShipWorld {
  actorId: string;
  orderAId: string;
  orderBId: string;
  box1Id: string;
  box2Id: string;
}

/**
 * Two finished orders packed across two closed boxes: box1 holds order A's
 * only package plus half of order B; box2 holds the rest of order B. Both
 * boxes carry a completed verify task so the default config lets them ship.
 */
async function seedShipWorld(): Promise<ShipWorld> {
  const actorId = await actorIdOf();
  const orderAId = randomUUID();
  const orderBId = randomUUID();
  const itemAId = randomUUID();
  const itemBId = randomUUID();
  const box1Id = "BOX-S-SHIP-1";
  const box2Id = "BOX-S-SHIP-2";
  await client.db.execute(sql`INSERT INTO picking_orders (id, order_no, status, created_date, last_update_date)
      VALUES (${orderAId}, 'SO-SHIP-A', 'finished', now(), now()),
             (${orderBId}, 'SO-SHIP-B', 'finished', now(), now())`);
  await client.db.execute(sql`INSERT INTO picking_items (id, picking_order_id, part_no, qty, picked_qty, line_id, line_number, shipment_number, created_date, last_update_date)
      VALUES (${itemAId}, ${orderAId}, 'RK73H1JTTD1002F', 100, 100, 9101, 1, 1, now(), now()),
             (${itemBId}, ${orderBId}, 'RK73H1JTTD2202F', 50, 50, 9102, 1, 1, now(), now())`);
  await client.db.execute(sql`INSERT INTO shipping_boxes (id, picking_order_id, status, destination_country, box_size, net_weight, gross_weight, created_date, last_update_date)
      VALUES (${box1Id}, ${orderAId}, 'closed', 'HK', '26 X 20 X 20', 0.5, 0.8, now(), now()),
             (${box2Id}, ${orderBId}, 'closed', 'HK', '26 X 20 X 20', 0.2, 0.3, now(), now())`);
  await client.db.execute(sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, verified, created_date, last_update_date)
      VALUES (${randomUUID()}, ${itemAId}, ${orderAId}, 'inventory_lot', 'ship-src-a', 100, ${box1Id}, true, now(), now()),
             (${randomUUID()}, ${itemBId}, ${orderBId}, 'inventory_lot', 'ship-src-b1', 25, ${box1Id}, true, now(), now()),
             (${randomUUID()}, ${itemBId}, ${orderBId}, 'inventory_lot', 'ship-src-b2', 25, ${box2Id}, true, now(), now())`);
  await client.db.execute(sql`INSERT INTO verify_tasks (id, shipping_box_id, status, created_date, last_update_date)
      VALUES (${randomUUID()}, ${box1Id}, 'completed', now(), now()),
             (${randomUUID()}, ${box2Id}, 'completed', now(), now())`);
  return { actorId, orderAId, orderBId, box1Id, box2Id };
}

test("multi-order box: an order flips to shipped only when every box holding its packages is shipped", async () => {
  await reset();
  const { actorId, orderAId, orderBId, box1Id, box2Id } = await seedShipWorld();

  // the shared box aggregates both order numbers in the feed
  const feed = await listShippingOrders(client.db);
  assert.equal(feed.length, 2);
  const row1 = feed.find((r) => r.boxId === box1Id)!;
  assert.deepEqual([...row1.orderNos].sort(), ["SO-SHIP-A", "SO-SHIP-B"]);
  assert.equal(row1.packageCount, 2);

  // ship box1: order A is fully covered by box1 → shipped; order B still has
  // packages in the unshipped box2 → stays finished
  const res1 = await shipShippingBox(client.db, box1Id, actorId);
  assert.deepEqual(res1.shippedOrderIds, [orderAId]);
  const statusOf = async (id: string) =>
    (await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${id}`))!.status;
  assert.equal(await statusOf(orderAId), "shipped");
  assert.equal(await statusOf(orderBId), "finished");

  // ship box2 → order B flips
  const res2 = await shipShippingBox(client.db, box2Id, actorId);
  assert.deepEqual(res2.shippedOrderIds, [orderBId]);
  assert.equal(await statusOf(orderBId), "shipped");

  assert.equal((await listShippingOrders(client.db)).length, 0);
});
