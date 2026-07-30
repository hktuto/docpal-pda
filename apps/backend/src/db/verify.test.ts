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
  reopenShippingBox,
  scanPickingItem,
  updateShippingBox,
  verifyPackage,
} from "./picking.js";
import { completeVerifyTask, getVerifyTaskDetail, listVerifyTasks } from "./verify.js";
import { getShippingOrderDetail, listShippingOrders } from "./shipping.js";
import { generateGoodsVerifyTasks } from "./goodsverify.js";
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
 * domain functions: allocate → scan all three items in full → box all. The box
 * is left OPEN. Which task the finish creates depends on the flow-step config.
 */
async function finishedOrder(): Promise<FinishedFixture> {
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 1000
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F"); // qty 500
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G"); // qty 300 (from the A-01-02 / BOX-H-20260701-0002 lot)
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

async function measuringTaskOf(orderId: string): Promise<{ id: string; status: string } | undefined> {
  return queryGet<{ id: string; status: string }>(
    client.db,
    sql`SELECT id, status FROM measuring_tasks WHERE picking_order_id = ${orderId}`
  );
}

async function verifyTaskOf(orderId: string): Promise<{ id: string; status: string } | undefined> {
  return queryGet<{ id: string; status: string }>(
    client.db,
    sql`SELECT id, status FROM verify_tasks WHERE picking_order_id = ${orderId}`
  );
}

/** Default config: finish → measuring task → close box (auto-completes
 *  measuring and spawns the verify task). */
async function pendingVerifyTask(): Promise<FinishedFixture & { verifyTaskId: string }> {
  const fx = await finishedOrder();
  await closeTheBox(fx.boxId, fx.actorId, fx.packageIds);
  const mt = (await measuringTaskOf(fx.orderId))!;
  assert.equal(mt.status, "completed"); // auto-completed by the last-box close
  const vt = (await verifyTaskOf(fx.orderId))!;
  return { ...fx, verifyTaskId: vt.id };
}

/** Verify-step re-scan: scan every package (works against the closed box and
 *  sets verified + verify_verified) so completeVerifyTask's guard passes. */
async function rescanAll(actorId: string, packageIds: string[]): Promise<void> {
  for (const packageId of packageIds) {
    await verifyPackage(client.db, { packageId, actorId });
  }
}

// --- list / detail (mirror of the measuring suite) -----------------------------

test("list: box counts, orderNo/shipTo join, status filter", async () => {
  await reset();
  const { verifyTaskId } = await pendingVerifyTask();

  const rows = await listVerifyTasks(client.db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, verifyTaskId);
  assert.equal(row.status, "pending");
  assert.equal(row.orderNo, "SO-DEMO-0001");
  assert.equal(row.shipTo, "ACME Electronics (HK)");
  assert.equal(row.boxCount, 1);
  assert.equal(row.closedBoxCount, 1);
  assert.ok(row.createdDate);

  assert.equal((await listVerifyTasks(client.db, "pending")).length, 1);
  assert.equal((await listVerifyTasks(client.db, "completed")).length, 0);
});

test("detail: consolidated task/order/boxes; 404", async () => {
  await reset();
  const { orderId, verifyTaskId, boxId, packageIds } = await pendingVerifyTask();

  const detail = await getVerifyTaskDetail(client.db, verifyTaskId);
  assert.equal(detail.task.id, verifyTaskId);
  assert.equal(detail.task.status, "pending");
  assert.equal(detail.task.pickingOrderId, orderId);

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
  assert.equal(box.status, "closed");
  assert.equal(box.boxSize, "26 X 20 X 20");
  assert.equal(box.suggestedNetWeightKg, 0.009); // 1000+500 pcs at 6.3 g per 1000 pcs (181G has no formula row)
  assert.equal(box.packages.length, 3);
  const byPartNo = new Map(box.packages.map((p) => [p.partNo, p]));
  assert.equal(byPartNo.get("RK73H1JTTD1002F")!.id, packageIds[0]);
  assert.equal(byPartNo.get("RK73H1JTTD1002F")!.verified, true);
  assert.equal(byPartNo.get("RK73H1JTTD1002F")!.verifyVerified, false);
  assert.equal(byPartNo.get("RK73H1JTTD2202F")!.id, packageIds[1]);
  assert.equal(byPartNo.get("RK73B1JTTD181G")!.id, packageIds[2]);
  assert.equal(byPartNo.get("RK73B1JTTD181G")!.qty, 300);

  const notFound = await catchHttp(getVerifyTaskDetail(client.db, randomUUID()));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "verify_task_not_found");
});

// --- complete guards + happy path ------------------------------------------------

test("complete: happy path + guards (404, actor, not pending, re-scan required)", async () => {
  await reset();
  const { orderId, actorId, packageIds, verifyTaskId } = await pendingVerifyTask();

  const notFound = await catchHttp(completeVerifyTask(client.db, { taskId: randomUUID(), actorId }));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "verify_task_not_found");

  const badActor = await catchHttp(completeVerifyTask(client.db, { taskId: verifyTaskId, actorId: randomUUID() }));
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");

  // no package re-scanned yet → 409
  const notRescanned = await catchHttp(completeVerifyTask(client.db, { taskId: verifyTaskId, actorId }));
  assert.equal(notRescanned.status, 409);
  assert.equal(notRescanned.message, "packages_not_all_rescanned");

  // re-scan one package (closed box is fine during verify) → still 409
  await verifyPackage(client.db, { packageId: packageIds[0], actorId });
  const halfRescanned = await catchHttp(completeVerifyTask(client.db, { taskId: verifyTaskId, actorId }));
  assert.equal(halfRescanned.status, 409);
  assert.equal(halfRescanned.message, "packages_not_all_rescanned");

  await verifyPackage(client.db, { packageId: packageIds[1], actorId });
  await verifyPackage(client.db, { packageId: packageIds[2], actorId });
  await completeVerifyTask(client.db, { taskId: verifyTaskId, actorId });

  const task = await verifyTaskOf(orderId);
  assert.equal(task!.status, "completed");
  const log = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'verify_task' AND entity_id = ${verifyTaskId}`
  );
  assert.deepEqual(log, { fromState: "pending", toState: "completed", actorId });

  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "finished");

  const again = await catchHttp(completeVerifyTask(client.db, { taskId: verifyTaskId, actorId }));
  assert.equal(again.status, 409);
  assert.equal(again.message, "verify_task_not_pending");
});

test("complete: 409 while a box is open (reopened during verify)", async () => {
  await reset();
  const { actorId, boxId, verifyTaskId } = await pendingVerifyTask();
  await reopenShippingBox(client.db, { shippingBoxId: boxId, actorId });

  const boxesOpen = await catchHttp(completeVerifyTask(client.db, { taskId: verifyTaskId, actorId }));
  assert.equal(boxesOpen.status, 409);
  assert.equal(boxesOpen.message, "shipping_boxes_not_all_closed");
});

// --- chain: config combinations -----------------------------------------------------

test("chain: measuring disabled + verify enabled → finish creates a verify task; verify works end-to-end", async () => {
  await reset(["measuring"]);
  const { orderId, actorId, boxId, packageIds } = await finishedOrder();

  assert.equal(await measuringTaskOf(orderId), undefined);
  const vt = (await verifyTaskOf(orderId))!;
  assert.equal(vt.status, "pending");

  // verifyPackage accepts the pending verify task; close → complete works.
  await closeTheBox(boxId, actorId, packageIds);
  await completeVerifyTask(client.db, { taskId: vt.id, actorId });
  assert.equal((await verifyTaskOf(orderId))!.status, "completed");

  // shipping feed sourced from verify
  const feed = await listShippingOrders(client.db);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].source, "verify");
  assert.equal(feed[0].taskId, vt.id);
  assert.equal(feed[0].pickingOrderId, orderId);
});

test("chain: both disabled → finish creates no tasks; shipping feed source='picking'", async () => {
  await reset(["measuring", "verify"]);
  const { orderId, actorId, boxId, packageIds } = await finishedOrder();

  assert.equal(await measuringTaskOf(orderId), undefined);
  assert.equal(await verifyTaskOf(orderId), undefined);

  // verifyPackage has no task to hang on → 409 with the neutral code
  const noTask = await catchHttp(verifyPackage(client.db, { packageId: packageIds[0], actorId }));
  assert.equal(noTask.status, 409);
  assert.equal(noTask.message, "no_pending_measure_or_verify_task");

  await updateShippingBox(client.db, boxId, { actorId, boxSize: "26 X 20 X 20", netWeightKg: 0.5, grossWeightKg: 0.8 });
  // close requires verified packages; verify manually via SQL (no task gate in this mode)
  await client.db.execute(sql`UPDATE picking_packages SET verified = true WHERE shipping_box_id = ${boxId}`);
  await closeShippingBox(client.db, { shippingBoxId: boxId, actorId });

  const feed = await listShippingOrders(client.db);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].source, "picking");
  assert.equal(feed[0].taskId, null);
  assert.equal(feed[0].pickingOrderId, orderId);
  assert.equal(feed[0].orderNo, "SO-DEMO-0001");
  assert.equal(feed[0].boxCount, 1);
  assert.equal(feed[0].closedBoxCount, 1);
  assert.ok(feed[0].completedAt);
});

test("chain: measuring + verify enabled → close auto-completes measuring + spawns verify; feed sourced from verify only after verify completes", async () => {
  await reset();
  const { orderId, actorId, packageIds, verifyTaskId } = await pendingVerifyTask();

  // measuring completed → verify spawned, but feed is empty until verify completes
  assert.equal((await measuringTaskOf(orderId))!.status, "completed");
  assert.equal((await listShippingOrders(client.db)).length, 0);

  await rescanAll(actorId, packageIds);
  await completeVerifyTask(client.db, { taskId: verifyTaskId, actorId });
  const feed = await listShippingOrders(client.db);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].source, "verify");
  assert.equal(feed[0].taskId, verifyTaskId);

  // completing measuring again is impossible (not pending) — spawn stays single
  const count = await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM verify_tasks WHERE picking_order_id = ${orderId}`
  );
  assert.equal(count!.n, 1);
});

test("chain: verify disabled → close auto-completes measuring, spawns nothing; feed = completed measuring", async () => {
  await reset(["verify"]);
  const { orderId, boxId, actorId, packageIds } = await finishedOrder();
  await closeTheBox(boxId, actorId, packageIds);
  const mt = (await measuringTaskOf(orderId))!;
  assert.equal(mt.status, "completed"); // auto-completed by the last-box close

  assert.equal(await verifyTaskOf(orderId), undefined);

  const feed = await listShippingOrders(client.db);
  assert.equal(feed.length, 1);
  assert.equal(feed[0].source, "measuring");
  assert.equal(feed[0].taskId, mt.id);
  assert.equal(feed[0].pickingOrderId, orderId);
});

// --- reopen during verify -------------------------------------------------------------

test("reopen: closed box → open + both package flags reset; re-verify + re-close + complete; no task/order duplication", async () => {
  await reset();
  const { orderId, actorId, boxId, packageIds, verifyTaskId } = await pendingVerifyTask();

  // one package re-scanned before the reopen, so the reset is observable
  await verifyPackage(client.db, { packageId: packageIds[0], actorId });
  await reopenShippingBox(client.db, { shippingBoxId: boxId, actorId });

  const box = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM shipping_boxes WHERE id = ${boxId}`);
  assert.equal(box!.status, "open");
  const pkgs = await queryAll<{ id: string; verified: boolean; verifyVerified: boolean }>(
    client.db,
    sql`SELECT id, verified, verify_verified AS "verifyVerified" FROM picking_packages WHERE shipping_box_id = ${boxId}`
  );
  assert.equal(pkgs.length, 3);
  assert.ok(pkgs.every((p) => !p.verified && !p.verifyVerified));

  const log = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'shipping_box' AND entity_id = ${boxId}
        ORDER BY created_date DESC, id DESC LIMIT 1`
  );
  assert.deepEqual(log, { fromState: "closed", toState: "open", actorId });

  // full re-measure: re-scan (allowed — pending verify task), re-close
  await closeTheBox(boxId, actorId, packageIds);

  // the re-close auto-finish re-check is a no-op for the finished order:
  // still exactly one measuring + one verify task, no extra 'finished' log
  assert.equal((await queryGet<{ n: number }>(client.db, sql`SELECT COUNT(*)::int AS n FROM measuring_tasks WHERE picking_order_id = ${orderId}`))!.n, 1);
  assert.equal((await queryGet<{ n: number }>(client.db, sql`SELECT COUNT(*)::int AS n FROM verify_tasks WHERE picking_order_id = ${orderId}`))!.n, 1);
  const finishLogs = await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM transaction_logs
        WHERE entity_type = 'picking_order' AND entity_id = ${orderId} AND to_state = 'finished'`
  );
  assert.equal(finishLogs!.n, 1);

  await completeVerifyTask(client.db, { taskId: verifyTaskId, actorId });
  assert.equal((await verifyTaskOf(orderId))!.status, "completed");
});

test("reopen: guards — open box 409 shipping_box_not_closed; no pending verify task 409 verify_task_not_pending", async () => {
  await reset();
  const { actorId, boxId, packageIds, verifyTaskId } = await pendingVerifyTask();

  // no pending verify task: complete verify first, then reopen → 409
  await rescanAll(actorId, packageIds);
  await completeVerifyTask(client.db, { taskId: verifyTaskId, actorId });
  const noTask = await catchHttp(reopenShippingBox(client.db, { shippingBoxId: boxId, actorId }));
  assert.equal(noTask.status, 409);
  assert.equal(noTask.message, "verify_task_not_pending");

  // open box guard: a separate fixture whose box is still open
  await reseed(client);
  const fx = await finishedOrder();
  const notClosed = await catchHttp(reopenShippingBox(client.db, { shippingBoxId: fx.boxId, actorId: fx.actorId }));
  assert.equal(notClosed.status, 409);
  assert.equal(notClosed.message, "shipping_box_not_closed");
});

test("reopen: 409 verify_task_not_pending when the order only has a pending measuring task", async () => {
  await reset();
  const fx = await finishedOrder();
  // keep the measuring task pending: an unboxed package blocks the
  // last-box-close auto-complete, so no verify task is spawned
  await removePackageFromBox(client.db, { shippingBoxId: fx.boxId, packageId: fx.packageIds[1], actorId: fx.actorId });
  // the box still holds packages 1 and 3 — both must be verified to close
  await closeTheBox(fx.boxId, fx.actorId, [fx.packageIds[0], fx.packageIds[2]]);
  assert.equal((await measuringTaskOf(fx.orderId))!.status, "pending");

  const noVerify = await catchHttp(reopenShippingBox(client.db, { shippingBoxId: fx.boxId, actorId: fx.actorId }));
  assert.equal(noVerify.status, 409);
  assert.equal(noVerify.message, "verify_task_not_pending");
});

// --- shipping detail -----------------------------------------------------------------

test("shipping detail: task-agnostic order + boxes[packages]; 404", async () => {
  await reset();
  const { orderId, boxId, packageIds } = await pendingVerifyTask();

  const detail = await getShippingOrderDetail(client.db, orderId);
  assert.equal(detail.order.id, orderId);
  assert.equal(detail.order.orderNo, "SO-DEMO-0001");
  assert.equal(detail.boxes.length, 1);
  assert.equal(detail.boxes[0].id, boxId);
  assert.deepEqual(
    detail.boxes[0].packages.map((p) => p.id).sort(),
    [...packageIds].sort()
  );

  const notFound = await catchHttp(getShippingOrderDetail(client.db, randomUUID()));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "picking_order_not_found");
});

// --- goods-verify step gate ------------------------------------------------------------

test("goods-verify disabled → generate is a no-op", async () => {
  await reset(["goods-verify"]);
  const res = await generateGoodsVerifyTasks(client.db, { date: "2026-07-27" });
  assert.equal(res.created, 0);
  assert.equal(res.date, "2026-07-27");
  const tasks = await queryAll<{ id: string }>(client.db, sql`SELECT id FROM goods_verify_tasks`);
  assert.equal(tasks.length, 0);
});
