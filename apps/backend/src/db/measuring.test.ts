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
  addPackageToBox,
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
 * The seeded pending order (SO-DEMO-0001) driven to auto-finish through the
 * Phase 3 domain functions: allocate → scan all three items in full → box all
 * (auto-finish creates the measuring task). The box is left OPEN.
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
  const task = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM measuring_tasks WHERE picking_order_id = ${orderId}`);
  return { orderId, actorId, boxId: box.id, taskId: task!.id, packageIds: [p1, p2, p3] };
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

test("list: box counts, orderNo/shipTo join, status filter", async () => {
  await reseed(client);
  const { taskId, actorId, boxId, packageIds } = await finishedOrder();

  let rows = await listMeasuringTasks(client.db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, taskId);
  assert.equal(row.status, "pending");
  assert.equal(row.orderNo, "SO-DEMO-0001");
  assert.equal(row.shipTo, "ACME Electronics (HK)");
  assert.equal(row.boxCount, 1);
  assert.equal(row.closedBoxCount, 0); // box still open
  assert.ok(row.createdDate);

  await closeTheBox(boxId, actorId, packageIds); // last-box close auto-completes the task
  rows = await listMeasuringTasks(client.db);
  assert.equal(rows[0].boxCount, 1);
  assert.equal(rows[0].closedBoxCount, 1); // closed counts as closed-or-beyond
  assert.equal(rows[0].status, "completed");

  assert.equal((await listMeasuringTasks(client.db, "pending")).length, 0);
  assert.equal((await listMeasuringTasks(client.db, "completed")).length, 1);
});

// --- detail --------------------------------------------------------------------

test("detail: consolidated task/order/boxes, packages carry part identity; 404", async () => {
  await reseed(client);
  const { orderId, taskId, boxId, packageIds } = await finishedOrder();

  const detail = await getMeasuringTaskDetail(client.db, taskId);
  assert.equal(detail.task.id, taskId);
  assert.equal(detail.task.status, "pending");
  assert.equal(detail.task.pickingOrderId, orderId);
  assert.ok(detail.task.createdDate);

  assert.deepEqual(detail.order, {
    id: orderId,
    orderNo: "SO-DEMO-0001",
    status: "finished",
    shipTo: "ACME Electronics (HK)",
    customerCode: "ACME",
    poNo: "CUST-PO-9001",
  });

  assert.equal(detail.boxes.length, 1);
  const box = detail.boxes[0];
  assert.equal(box.id, boxId);
  assert.equal(box.status, "open");
  assert.equal(box.boxSize, null);
  assert.equal(box.grossWeight, null);
  assert.equal(box.netWeight, null);
  assert.equal(box.destinationCountry, null);
  // 1000 pcs + 500 pcs at 6.3 g per 1000 pcs = 9.45 g → 0.009 kg
  // (the 181G package has no net_weight_formula row, so it contributes 0)
  assert.equal(box.suggestedNetWeightKg, 0.009);

  assert.equal(box.packages.length, 3);
  const byPartNo = new Map(box.packages.map((p) => [p.partNo, p]));
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
  await closeTheBox(boxId, actorId, [packageIds[0], packageIds[2]]);
  const unboxed = await catchHttp(completeMeasuringTask(client.db, { taskId, actorId }));
  assert.equal(unboxed.status, 409);
  assert.equal(unboxed.message, "picking_items_not_fully_packed");
});

// --- auto-complete chain ----------------------------------------------------------

test("auto-complete: last box close completes measuring + spawns verify; manual complete then 409s", async () => {
  await reseed(client);
  const { orderId, actorId, boxId, taskId, packageIds } = await finishedOrder();
  await closeTheBox(boxId, actorId, packageIds);

  // the close auto-completed the measuring task (no manual complete needed)
  const task = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM measuring_tasks WHERE id = ${taskId}`);
  assert.equal(task!.status, "completed");
  const log = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'measuring_task' AND entity_id = ${taskId}`
  );
  assert.deepEqual(log, { fromState: "pending", toState: "completed", actorId });

  // verify task spawned (verify step enabled by default)
  const verifyTask = await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM verify_tasks WHERE picking_order_id = ${orderId}`
  );
  assert.equal(verifyTask!.status, "pending");

  // completing measuring does NOT flip the picking order status
  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "finished");

  // list reflects the new status
  assert.equal((await listMeasuringTasks(client.db, "pending")).length, 0);
  assert.equal((await listMeasuringTasks(client.db, "completed")).length, 1);

  // a later manual complete is a stale-action 409
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

test("auto-complete: not the last box / unboxed package → task stays pending", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 1000
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F"); // qty 500
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G"); // qty 300
  const p1 = (await scanPickingItem(client.db, item1, { actorId, allocationId: await allocationIdOf(item1), qty: 1000 })).packageIds[0];
  const p2 = (await scanPickingItem(client.db, item2, { actorId, allocationId: await allocationIdOf(item2), qty: 500 })).packageIds[0];
  const p3 = (await scanPickingItem(client.db, item3, { actorId, allocationId: await allocationIdOf(item3), qty: 300 })).packageIds[0];
  const box1 = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await createShippingBox(client.db, { pickingOrderId: orderId, actorId }); // second (empty) box, left open
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box1.id, actorId }); // auto-finishes
  const taskId = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM measuring_tasks WHERE picking_order_id = ${orderId}`))!.id;

  // another box is still open → closing box1 does not auto-complete
  await closeTheBox(box1.id, actorId, [p1, p2, p3]);
  const task = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM measuring_tasks WHERE id = ${taskId}`);
  assert.equal(task!.status, "pending");
});

// --- suggested net weight -----------------------------------------------------------

test("suggested net weight: formula-driven per box; null without any formula", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 1000
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F"); // qty 500
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G"); // qty 300
  const p1 = (await scanPickingItem(client.db, item1, { actorId, allocationId: await allocationIdOf(item1), qty: 1000 })).packageIds[0];
  const p2 = (await scanPickingItem(client.db, item2, { actorId, allocationId: await allocationIdOf(item2), qty: 500 })).packageIds[0];
  const p3 = (await scanPickingItem(client.db, item3, { actorId, allocationId: await allocationIdOf(item3), qty: 300 })).packageIds[0];

  // box1 holds the 1000 pcs of RK73H1JTTD1002F at 6.3 g per 1000 pcs → 6.3 g
  // → 0.006 kg; box2 holds the 500 pcs → 3.15 g → 0.003 kg plus the 181G
  // package, which has no formula row and contributes 0 (box2 finishes the order)
  const box1 = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addPackageToBox(client.db, { shippingBoxId: box1.id, packageId: p1, actorId });
  const box2 = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addPackageToBox(client.db, { shippingBoxId: box2.id, packageId: p2, actorId });
  await addPackageToBox(client.db, { shippingBoxId: box2.id, packageId: p3, actorId }); // auto-finishes here

  const taskId = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM measuring_tasks WHERE picking_order_id = ${orderId}`))!.id;
  const detail = await getMeasuringTaskDetail(client.db, taskId);
  const byBoxId = new Map(detail.boxes.map((b) => [b.id, b]));
  assert.equal(byBoxId.get(box1.id)!.suggestedNetWeightKg, 0.006);
  assert.equal(byBoxId.get(box2.id)!.suggestedNetWeightKg, 0.003);

  // a box whose package has no formula row → null (RK73B1JTTD181G is seeded
  // without a net_weight_formula row)
  const bareOrderId = randomUUID();
  const bareItemId = randomUUID();
  const barePkgId = randomUUID();
  const bareBoxId = "BOX-S-BARE-1";
  await client.db.execute(sql`INSERT INTO picking_orders (id, order_no, status, created_date, last_update_date)
      VALUES (${bareOrderId}, 'SO-BARE', 'finished', now(), now())`);
  await client.db.execute(sql`INSERT INTO measuring_tasks (id, picking_order_id, status, created_date)
      VALUES (${randomUUID()}, ${bareOrderId}, 'pending', now())`);
  await client.db.execute(sql`INSERT INTO picking_items (id, picking_order_id, part_no, qty, line_id, line_number, shipment_number, created_date, last_update_date)
      VALUES (${bareItemId}, ${bareOrderId}, 'RK73B1JTTD181G', 100, 9003, 1, 1, now(), now())`);
  await client.db.execute(sql`INSERT INTO shipping_boxes (id, picking_order_id, status, created_date, last_update_date)
      VALUES (${bareBoxId}, ${bareOrderId}, 'open', now(), now())`);
  await client.db.execute(sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_date, last_update_date)
      VALUES (${barePkgId}, ${bareItemId}, ${bareOrderId}, 'inventory_lot', 'bare-src', 100, ${bareBoxId}, now(), now())`);
  const bareTask = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM measuring_tasks WHERE picking_order_id = ${bareOrderId}`
  );
  const bareDetail = await getMeasuringTaskDetail(client.db, bareTask!.id);
  assert.equal(bareDetail.boxes[0].suggestedNetWeightKg, null);
});
