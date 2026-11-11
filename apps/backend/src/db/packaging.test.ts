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
  finishPickingOrder,
  scanPickingItem,
  updateShippingBox,
  verifyPackage,
} from "./picking.js";
import { completeVerifyTask } from "./verify.js";
import { confirmPackaging, getPackagingOrderDetail, listPackagingOrders } from "./packaging.js";
import { getShippingOrderDetail, listShippingOrders, shipShippingBox } from "./shipping.js";
import { listTaskAssignments, setTaskAssignee } from "./taskAssignments.js";
import { _setFlowStepsDisabledForTests, _setStepEnabledForTests, type FlowStep } from "../config.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

/** Reseed + default steps (packaging OFF — it is opt-in); `packaging` flips the step on.
 *  label_print_rules is not truncated by reseed (see labeling.test.ts) — stale
 *  demo rules would push the fixture order into the label-printing queue. */
async function reset(opts: { packaging?: boolean; disabled?: FlowStep[] } = {}): Promise<void> {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM label_print_rules`);
  _setFlowStepsDisabledForTests(opts.disabled ?? []);
  _setStepEnabledForTests("packaging", opts.packaging === true);
}

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

interface PackagedFixture {
  orderId: string;
  actorId: string;
  boxId: string;
  packageIds: string[];
  verifyTaskId: string;
}

/** The seeded pending order (SO-DEMO-0001) driven all the way through:
 *  allocate → scan all three items → box → finish → measure-verify → close →
 *  verify re-scan + complete verify task (order → measuring_finished). */
async function verifiedOrder(): Promise<PackagedFixture> {
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 1000
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F"); // qty 500
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G"); // qty 300
  const p1 = (await scanPickingItem(client.db, item1, { actorId, allocationId: await allocationIdOf(item1), qty: 1000 })).packageIds[0];
  const p2 = (await scanPickingItem(client.db, item2, { actorId, allocationId: await allocationIdOf(item2), qty: 500 })).packageIds[0];
  const p3 = (await scanPickingItem(client.db, item3, { actorId, allocationId: await allocationIdOf(item3), qty: 300 })).packageIds[0];
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId });
  await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });
  const packageIds = [p1, p2, p3];
  for (const packageId of packageIds) await verifyPackage(client.db, { packageId, actorId });
  await updateShippingBox(client.db, box.id, { actorId, boxSize: "26 X 20 X 20", netWeightKg: 0.5, grossWeightKg: 0.8 });
  await closeShippingBox(client.db, { shippingBoxId: box.id, actorId });
  const vt = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM verify_tasks WHERE shipping_box_id = ${box.id}`);
  if (vt) {
    // verify on: the close reset the re-scan credit — re-scan + complete (order → measuring_finished)
    for (const packageId of packageIds) await verifyPackage(client.db, { packageId, actorId });
    await completeVerifyTask(client.db, { taskId: vt.id, actorId });
  }
  return { orderId, actorId, boxId: box.id, packageIds, verifyTaskId: vt?.id ?? "" };
}

/** Raw second order whose packages ride in an existing box (cross-order packing). */
async function orderInBox(orderNo: string, boxId: string, status = "picking_finished"): Promise<string> {
  const orderId = randomUUID();
  const itemId = randomUUID();
  await client.db.execute(sql`INSERT INTO picking_orders (id, order_no, status, created_date, last_update_date)
      VALUES (${orderId}, ${orderNo}, ${status}, now(), now())`);
  await client.db.execute(sql`INSERT INTO picking_items (id, picking_order_id, part_no, qty, created_date, last_update_date)
      VALUES (${itemId}, ${orderId}, 'RK73B1JTTD181G', 100, now(), now())`);
  await client.db.execute(sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_date, last_update_date)
      VALUES (${randomUUID()}, ${itemId}, ${orderId}, 'inventory_lot', 'x-order-src', 100, ${boxId}, now(), now())`);
  return orderId;
}

interface PackagedCols {
  packagedAt: Date | null;
  packedWeight: number | null;
  packedBoxCount: number | null;
  packedPalletCount: number | null;
}

async function packagedRow(orderId: string): Promise<PackagedCols> {
  return (await queryGet<PackagedCols>(
    client.db,
    sql`SELECT packaged_at AS "packagedAt", packed_weight AS "packedWeight",
               packed_box_count AS "packedBoxCount", packed_pallet_count AS "packedPalletCount"
        FROM picking_orders WHERE id = ${orderId}`
  ))!;
}

// --- queue derivation --------------------------------------------------------------

test("queue: verified order appears with auto box/package counts; unboxed/open/pending-verify/labeling states are excluded", async () => {
  await reset({ packaging: true });
  const fx = await verifiedOrder();
  const rows = await listPackagingOrders(client.db);
  const row = rows.find((r) => r.id === fx.orderId)!;
  assert.ok(row, "verified order in the packaging queue");
  assert.equal(row.boxCount, 1);
  assert.equal(row.packageCount, 3);
  assert.equal(row.packedBoxCount, null);
  assert.equal(row.assignee, null);

  // a package torn out of the box → not fully boxed
  await client.db.execute(sql`UPDATE picking_packages SET shipping_box_id = NULL WHERE id = ${fx.packageIds[0]}`);
  assert.equal((await listPackagingOrders(client.db)).find((r) => r.id === fx.orderId), undefined);
  await client.db.execute(sql`UPDATE picking_packages SET shipping_box_id = ${fx.boxId} WHERE id = ${fx.packageIds[0]}`);

  // box reopened → excluded
  await client.db.execute(sql`UPDATE shipping_boxes SET status = 'open' WHERE id = ${fx.boxId}`);
  assert.equal((await listPackagingOrders(client.db)).find((r) => r.id === fx.orderId), undefined);
  await client.db.execute(sql`UPDATE shipping_boxes SET status = 'closed' WHERE id = ${fx.boxId}`);

  // pending verify task (the order-keyed guard when another box is pending) → excluded
  await client.db.execute(sql`UPDATE verify_tasks SET status = 'pending' WHERE id = ${fx.verifyTaskId}`);
  assert.equal((await listPackagingOrders(client.db)).find((r) => r.id === fx.orderId), undefined);
  await client.db.execute(sql`UPDATE verify_tasks SET status = 'completed' WHERE id = ${fx.verifyTaskId}`);

  // labeling stage still open → excluded
  await client.db.execute(sql`UPDATE picking_orders SET labeling_pending = true WHERE id = ${fx.orderId}`);
  assert.equal((await listPackagingOrders(client.db)).find((r) => r.id === fx.orderId), undefined);
  await client.db.execute(sql`UPDATE picking_orders SET labeling_pending = false WHERE id = ${fx.orderId}`);

  assert.equal((await listPackagingOrders(client.db)).find((r) => r.id === fx.orderId)?.boxCount, 1);
});

test("queue: verify step off — closed box alone qualifies (no verify task exists)", async () => {
  await reset({ packaging: true, disabled: ["verify"] });
  const fx = await verifiedOrder();
  const row = (await listPackagingOrders(client.db)).find((r) => r.id === fx.orderId);
  assert.ok(row, "closed-box order queues without verify");
});

test("detail: boxes listed; unknown order 404", async () => {
  await reset({ packaging: true });
  const fx = await verifiedOrder();
  const detail = await getPackagingOrderDetail(client.db, fx.orderId);
  assert.equal(detail.orderNo, "SO-DEMO-0001");
  assert.equal(detail.boxes.length, 1);
  assert.equal(detail.boxes[0].id, fx.boxId);
  assert.equal(detail.boxes[0].packageCount, 3);
  assert.equal((await catchHttp(getPackagingOrderDetail(client.db, "nope"))).message, "packaging_order_not_found");
});

// --- confirm ----------------------------------------------------------------------

test("confirm: stamps weight/by/at with server-recomputed box count, ledger + SSE event; pending queue drains, completed lists it", async () => {
  await reset({ packaging: true });
  const fx = await verifiedOrder();
  const result = await confirmPackaging(client.db, { orderId: fx.orderId, weight: 12.3456, palletCount: null, actorId: fx.actorId });
  assert.deepEqual(result, { id: fx.orderId, boxCount: 1 });
  const row = await packagedRow(fx.orderId);
  assert.ok(row.packagedAt, "packaged_at stamped");
  assert.equal(row.packedWeight, 12.346, "kg rounded to ≤3 dp");
  assert.equal(row.packedBoxCount, 1);
  assert.equal(row.packedPalletCount, null);
  const order = await queryGet<{ status: string; packagedBy: string }>(
    client.db,
    sql`SELECT status, packaged_by AS "packagedBy" FROM picking_orders WHERE id = ${fx.orderId}`
  );
  assert.equal(order!.status, "measuring_finished", "status untouched");
  assert.equal(order!.packagedBy, fx.actorId);

  const log = await queryGet<{ from: string; to: string }>(
    client.db,
    sql`SELECT from_state AS "from", to_state AS "to" FROM transaction_logs
        WHERE entity_type = 'picking_order' AND entity_id = ${fx.orderId} AND to_state = 'packaged'`
  );
  assert.deepEqual(log, { from: "packaging_pending", to: "packaged" });
  const evt = await queryGet<{ topics: string[] }>(
    client.db,
    sql`SELECT topics FROM app_events WHERE type = 'picking.packaged' ORDER BY id DESC LIMIT 1`
  );
  assert.deepEqual(evt?.topics, ["/packaging-orders", "/picking-orders", "/shipping-orders"]);

  assert.equal((await listPackagingOrders(client.db)).find((r) => r.id === fx.orderId), undefined);
  const done = (await listPackagingOrders(client.db, { status: "completed" })).find((r) => r.id === fx.orderId)!;
  assert.equal(done.packedWeight, 12.346);
  assert.equal(done.packagedBy, fx.actorId);
});

test("confirm: pallet mode stores the count alongside the auto box count", async () => {
  await reset({ packaging: true });
  const fx = await verifiedOrder();
  await confirmPackaging(client.db, { orderId: fx.orderId, weight: 80, palletCount: 2, actorId: fx.actorId });
  const row = await packagedRow(fx.orderId);
  assert.equal(row.packedPalletCount, 2);
  assert.equal(row.packedBoxCount, 1);
});

test("confirm guards: not-ready 409, double-confirm 409, unknown 404, bad payload 400", async () => {
  await reset({ packaging: true });
  const fx = await verifiedOrder();
  const bad = () => ({ orderId: fx.orderId, actorId: fx.actorId });

  await client.db.execute(sql`UPDATE verify_tasks SET status = 'pending' WHERE id = ${fx.verifyTaskId}`);
  assert.equal((await catchHttp(confirmPackaging(client.db, { ...bad(), weight: 1, palletCount: null }))).message, "packaging_not_ready");
  await client.db.execute(sql`UPDATE verify_tasks SET status = 'completed' WHERE id = ${fx.verifyTaskId}`);

  assert.equal((await catchHttp(confirmPackaging(client.db, { orderId: "nope", weight: 1, palletCount: null, actorId: fx.actorId }))).message, "packaging_order_not_found");
  assert.equal((await catchHttp(confirmPackaging(client.db, { ...bad(), weight: 0, palletCount: null }))).message, "invalid_weight");
  assert.equal((await catchHttp(confirmPackaging(client.db, { ...bad(), weight: NaN, palletCount: null }))).message, "invalid_weight");
  assert.equal((await catchHttp(confirmPackaging(client.db, { ...bad(), weight: 1, palletCount: 0 }))).message, "invalid_pallet_count");
  assert.equal((await catchHttp(confirmPackaging(client.db, { ...bad(), weight: 1, palletCount: 1.5 }))).message, "invalid_pallet_count");

  await confirmPackaging(client.db, { ...bad(), weight: 5, palletCount: null });
  assert.equal((await catchHttp(confirmPackaging(client.db, { ...bad(), weight: 5, palletCount: null }))).message, "packaging_not_ready", "double-confirm drains the queue");
});

// --- ship gate --------------------------------------------------------------------

test("ship gate: box ships only once every order in it is packaged (shared box); cancelled orders do not block", async () => {
  await reset({ packaging: true });
  const fx = await verifiedOrder();

  assert.equal((await listShippingOrders(client.db)).find((r) => r.boxId === fx.boxId), undefined, "unpacked order blocks the feed");
  assert.equal((await catchHttp(shipShippingBox(client.db, fx.boxId, fx.actorId))).message, "box_not_ready_to_ship");

  // cross-order: a second order sharing the box blocks even after the first is packaged
  const orderB = await orderInBox("SO-PKG-B", fx.boxId);
  await confirmPackaging(client.db, { orderId: fx.orderId, weight: 10, palletCount: null, actorId: fx.actorId });
  assert.equal((await listShippingOrders(client.db)).find((r) => r.boxId === fx.boxId), undefined, "B still blocks");
  await confirmPackaging(client.db, { orderId: orderB, weight: 4, palletCount: null, actorId: fx.actorId });

  // a cancelled order in the box does not block
  await orderInBox("SO-PKG-C", fx.boxId, "cancelled");
  const feed = await listShippingOrders(client.db);
  const row = feed.find((r) => r.boxId === fx.boxId)!;
  assert.ok(row, "all live orders packaged → feed");
  assert.equal(row.packaged, true);

  const detail = await getShippingOrderDetail(client.db, fx.boxId);
  const a = detail.orders.find((o) => o.id === fx.orderId)!;
  assert.equal(a.packedWeight, 10);
  assert.equal(a.packedBoxCount, 1);
  assert.ok(a.packagedAt);

  assert.equal((await shipShippingBox(client.db, fx.boxId, fx.actorId)).status, "shipped");
});

test("ship gate: packaging step off — feed unchanged (packaged flag reflects data only)", async () => {
  await reset(); // packaging OFF
  const fx = await verifiedOrder();
  const row = (await listShippingOrders(client.db)).find((r) => r.boxId === fx.boxId)!;
  assert.ok(row, "unpacked box still shippable with the step off");
  assert.equal(row.packaged, false);
  assert.equal((await shipShippingBox(client.db, fx.boxId, fx.actorId)).status, "shipped");
});

// --- assignees ----------------------------------------------------------------------

test("assignee: picking_tasks side row drives the admin picker + queue visibility", async () => {
  await reset({ packaging: true });
  const fx = await verifiedOrder();
  await setTaskAssignee(client.db, { flow: "packaging", id: fx.orderId, assignee: "operator", actorId: null });

  const rows = await listTaskAssignments(client.db, "packaging");
  assert.deepEqual(
    rows.find((r) => r.id === fx.orderId),
    { id: fx.orderId, label: "SO-DEMO-0001", orderNo: "SO-DEMO-0001", status: "measuring_finished", assignee: "operator" }
  );

  assert.equal((await listPackagingOrders(client.db, { username: "operator" })).find((r) => r.id === fx.orderId)?.assignee, "operator");
  assert.equal((await listPackagingOrders(client.db, { username: "someone-else" })).find((r) => r.id === fx.orderId), undefined);
  assert.ok((await listPackagingOrders(client.db)).find((r) => r.id === fx.orderId), "unfiltered (admin) sees it");

  await setTaskAssignee(client.db, { flow: "packaging", id: fx.orderId, assignee: null, actorId: null });
  assert.equal((await listPackagingOrders(client.db, { username: "someone-else" })).find((r) => r.id === fx.orderId)?.assignee, null);
});
