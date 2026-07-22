import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { allocateAll } from "./allocate.js";
import {
  addAllUnboxedToShippingBox,
  closeShippingBox,
  createShippingBox,
  removePackageFromBox,
  scanPickingItem,
  updateShippingBox,
  verifyPackage,
} from "./picking.js";
import { completeMeasuringTask, getMeasuringTaskDetail, listMeasuringTasks } from "./measuring.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

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
  taskId: string;
  packageIds: string[];
}

/**
 * The seeded pending order (SO-2026-0001) driven to auto-finish through the
 * Phase 3 domain functions: allocate → scan both items in full → box all
 * (auto-finish creates the measuring task). The box is left OPEN.
 */
async function finishedOrder(): Promise<FinishedFixture> {
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-2026-0001");
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 2000
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F"); // qty 1000
  const p1 = (await scanPickingItem(client.db, item1, { actorId, allocationId: await allocationIdOf(item1), qty: 2000 })).packageIds[0];
  const p2 = (await scanPickingItem(client.db, item2, { actorId, allocationId: await allocationIdOf(item2), qty: 1000 })).packageIds[0];
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId }); // auto-finishes
  const task = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM measuring_tasks WHERE picking_order_id = ${orderId}`);
  return { orderId, actorId, boxId: box.id, taskId: task!.id, packageIds: [p1, p2] };
}

/** Verify the given packages, stamp measurements, close the box. */
async function closeTheBox(boxId: string, actorId: string, packageIds: string[]): Promise<void> {
  for (const packageId of packageIds) {
    await verifyPackage(client.db, { packageId, actorId });
  }
  await updateShippingBox(client.db, boxId, { actorId, boxSize: "26 X 20 X 20", netWeightG: 500, grossWeightG: 800 });
  await closeShippingBox(client.db, { shippingBoxId: boxId, actorId });
}

// --- list ----------------------------------------------------------------------

test("list: box counts, orderNo/shipTo join, status filter", async () => {
  await reseed(client);
  const { taskId, actorId, boxId, packageIds } = await finishedOrder();

  let rows = await listMeasuringTasks(client.db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, taskId);
  assert.equal(row.status, "pending");
  assert.equal(row.orderNo, "SO-2026-0001");
  assert.equal(row.shipTo, "ACME Electronics (HK)");
  assert.equal(row.boxCount, 1);
  assert.equal(row.closedBoxCount, 0); // box still open
  assert.ok(row.createdAt);

  await closeTheBox(boxId, actorId, packageIds);
  rows = await listMeasuringTasks(client.db);
  assert.equal(rows[0].boxCount, 1);
  assert.equal(rows[0].closedBoxCount, 1); // closed counts as closed-or-beyond

  assert.equal((await listMeasuringTasks(client.db, "pending")).length, 1);
  assert.equal((await listMeasuringTasks(client.db, "completed")).length, 0);
});

// --- detail --------------------------------------------------------------------

test("detail: consolidated task/order/boxes, packages carry part identity; 404", async () => {
  await reseed(client);
  const { orderId, taskId, boxId, packageIds } = await finishedOrder();

  const detail = await getMeasuringTaskDetail(client.db, taskId);
  assert.equal(detail.task.id, taskId);
  assert.equal(detail.task.status, "pending");
  assert.equal(detail.task.pickingOrderId, orderId);
  assert.ok(detail.task.createdAt);

  assert.deepEqual(detail.order, {
    id: orderId,
    orderNo: "SO-2026-0001",
    status: "finished",
    shipTo: "ACME Electronics (HK)",
    customerCode: "ACME",
    poNo: "CUST-PO-8899",
  });

  assert.equal(detail.boxes.length, 1);
  const box = detail.boxes[0];
  assert.equal(box.id, boxId);
  assert.equal(box.status, "open");
  assert.equal(box.boxSize, null);
  assert.equal(box.grossWeight, null);
  assert.equal(box.netWeight, null);
  assert.equal(box.destinationCountry, null);

  assert.equal(box.packages.length, 2);
  const byPartNo = new Map(box.packages.map((p) => [p.partNo, p]));
  const pkg1 = byPartNo.get("RK73H1JTTD1002F")!;
  assert.equal(pkg1.id, packageIds[0]);
  assert.equal(pkg1.qty, 2000);
  assert.equal(pkg1.dateCode, "2601");
  assert.equal(pkg1.lotCode, "L2601A");
  assert.equal(pkg1.coo, "JP");
  assert.equal(pkg1.cow, "JP");
  assert.equal(pkg1.verified, false);
  assert.equal(pkg1.wclItemNo, "RK73H1JTTD1002F");
  const pkg2 = byPartNo.get("RK73H1JTTD2202F")!;
  assert.equal(pkg2.id, packageIds[1]);
  assert.equal(pkg2.qty, 1000);
  assert.equal(pkg2.dateCode, "2602");
  assert.equal(pkg2.lotCode, "L2602B");

  const notFound = await catchHttp(getMeasuringTaskDetail(client.db, randomUUID()));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "measuring_task_not_found");
});

// --- complete guards -------------------------------------------------------------

test("complete guards: 404, actor_not_found, boxes open, unboxed packages", async () => {
  await reseed(client);
  const { actorId, boxId, taskId, packageIds } = await finishedOrder();

  const notFound = await catchHttp(completeMeasuringTask(client.db, { taskId: randomUUID(), actorId }));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "measuring_task_not_found");

  const badActor = await catchHttp(completeMeasuringTask(client.db, { taskId, actorId: randomUUID() }));
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");

  // box still open → 409
  const boxesOpen = await catchHttp(completeMeasuringTask(client.db, { taskId, actorId }));
  assert.equal(boxesOpen.status, 409);
  assert.equal(boxesOpen.message, "shipping_boxes_not_all_closed");

  // Unbox one package, then close the box with the rest: all boxes closed but
  // a package is left unboxed → 409 (the old "picking item not fully packed"
  // guard — new-schema form of packed !== picked).
  await removePackageFromBox(client.db, { shippingBoxId: boxId, packageId: packageIds[1], actorId });
  await closeTheBox(boxId, actorId, [packageIds[0]]);
  const unboxed = await catchHttp(completeMeasuringTask(client.db, { taskId, actorId }));
  assert.equal(unboxed.status, 409);
  assert.equal(unboxed.message, "picking_items_not_fully_packed");
});

// --- complete happy path ----------------------------------------------------------

test("complete: happy path — completed + transition log, picking order stays finished", async () => {
  await reseed(client);
  const { orderId, actorId, boxId, taskId, packageIds } = await finishedOrder();
  await closeTheBox(boxId, actorId, packageIds);

  await completeMeasuringTask(client.db, { taskId, actorId });

  const task = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM measuring_tasks WHERE id = ${taskId}`);
  assert.equal(task!.status, "completed");
  const log = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'measuring_task' AND entity_id = ${taskId}`
  );
  assert.deepEqual(log, { fromState: "pending", toState: "completed", actorId });

  // old completeMeasuringTask does NOT flip the picking order status
  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "finished");

  // list reflects the new status
  assert.equal((await listMeasuringTasks(client.db, "pending")).length, 0);
  assert.equal((await listMeasuringTasks(client.db, "completed")).length, 1);

  const again = await catchHttp(completeMeasuringTask(client.db, { taskId, actorId }));
  assert.equal(again.status, 409);
  assert.equal(again.message, "measuring_task_not_pending");

  // no stock movement in measuring: no ledger rows reference the task
  const txns = await queryAll<{ id: string }>(
    client.db,
    sql`SELECT id FROM inventory_transactions WHERE reference_type = 'measuring_task'`
  );
  assert.equal(txns.length, 0);
});
