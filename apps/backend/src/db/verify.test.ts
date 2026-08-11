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
  reopenShippingBox,
  scanPickingItem,
  updateShippingBox,
  verifyPackage,
} from "./picking.js";
import { completeVerifyTask, getVerifyTaskDetail, listVerifyTasks } from "./verify.js";
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

interface ClosedBoxFixture {
  orderId: string;
  actorId: string;
  boxId: string;
  packageIds: string[];
}

/**
 * The seeded pending order (SO-DEMO-0001) driven through pack + measure:
 * allocate → scan all three items in full → box all (auto-finish) → verify,
 * measure, close. Closing IS the measuring completion; with the verify step
 * enabled it spawns the box's pending verify task.
 */
async function closedBox(): Promise<ClosedBoxFixture> {
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
  for (const packageId of [p1, p2, p3]) {
    await verifyPackage(client.db, { packageId, actorId }); // open box → verified
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

/** Default config fixture: closed box + its pending verify task. */
async function pendingVerifyTask(): Promise<ClosedBoxFixture & { verifyTaskId: string }> {
  const fx = await closedBox();
  const vt = (await verifyTaskOf(fx.boxId))!;
  assert.equal(vt.status, "pending"); // spawned by the close
  return { ...fx, verifyTaskId: vt.id };
}

/** Verify-step re-scan: scan every package (closed box + pending task →
 *  verified + verify_verified) so completeVerifyTask's guard passes. */
async function rescanAll(actorId: string, packageIds: string[]): Promise<void> {
  for (const packageId of packageIds) {
    await verifyPackage(client.db, { packageId, actorId });
  }
}

// --- list / detail -----------------------------------------------------------------

test("list: box-keyed rows (orderNos/destination/packageCount/verifyVerifiedCount), status filter", async () => {
  await reset();
  const { boxId, verifyTaskId } = await pendingVerifyTask();

  const rows = await listVerifyTasks(client.db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.taskId, verifyTaskId);
  assert.equal(row.status, "pending");
  assert.equal(row.shippingBoxId, boxId);
  assert.equal(row.boxStatus, "closed");
  assert.deepEqual(row.orderNos, ["SO-DEMO-0001"]);
  assert.equal(row.destinationCountry, "ACME Electronics (HK)");
  assert.equal(row.packageCount, 3);
  assert.equal(row.verifyVerifiedCount, 0);
  assert.ok(row.createdDate);

  assert.equal((await listVerifyTasks(client.db, "pending")).length, 1);
  assert.equal((await listVerifyTasks(client.db, "completed")).length, 0);
});

test("detail: task + box + packages (part identity, both flags); 404", async () => {
  await reset();
  const { boxId, packageIds, verifyTaskId } = await pendingVerifyTask();

  const detail = await getVerifyTaskDetail(client.db, verifyTaskId);
  assert.equal(detail.task.id, verifyTaskId);
  assert.equal(detail.task.status, "pending");
  assert.equal(detail.task.shippingBoxId, boxId);
  assert.ok(detail.task.createdDate);

  assert.equal(detail.box.id, boxId);
  assert.equal(detail.box.status, "closed");
  assert.equal(detail.box.boxSize, "26 X 20 X 20");
  assert.equal(detail.box.netWeight, 0.5);
  assert.equal(detail.box.grossWeight, 0.8);
  assert.equal(detail.box.destinationCountry, "ACME Electronics (HK)");
  assert.equal(detail.box.shippedAt, null);
  assert.equal(detail.box.suggestedNetWeightKg, 0.009); // 1000+500 pcs at 6.3 g per 1000 pcs (181G has no formula row)

  assert.equal(detail.packages.length, 3);
  const byPartNo = new Map(detail.packages.map((p) => [p.partNo, p]));
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
  const { orderId, actorId, boxId, packageIds, verifyTaskId } = await pendingVerifyTask();

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

  const task = await verifyTaskOf(boxId);
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

test("complete: 409 shipping_box_not_closed while the box is open (reopened during verify)", async () => {
  await reset();
  const { actorId, boxId, packageIds, verifyTaskId } = await pendingVerifyTask();
  // re-scan all first so only the box-state guard can fire
  await rescanAll(actorId, packageIds);
  await reopenShippingBox(client.db, { shippingBoxId: boxId, actorId });

  const boxesOpen = await catchHttp(completeVerifyTask(client.db, { taskId: verifyTaskId, actorId }));
  assert.equal(boxesOpen.status, 409);
  assert.equal(boxesOpen.message, "shipping_box_not_closed");
});

// --- chain: verify task creation across config combinations -----------------------

test("chain: close spawns the box's verify task iff the verify step is enabled (all four measuring/verify combos)", async () => {
  for (const [disabled, expectTask] of [
    [[], true],
    [["measuring"], true],
    [["verify"], false],
    [["measuring", "verify"], false],
  ] as [FlowStep[], boolean][]) {
    await reset(disabled);
    const fx = await closedBox();
    const task = await verifyTaskOf(fx.boxId);
    assert.equal(task !== undefined, expectTask, `disabled=${disabled.join(",")}`);
  }
});

// --- verifyPackage branching -----------------------------------------------------------

test("verifyPackage: open box → verified only; closed box + pending task → both flags; closed box without task → 409", async () => {
  await reset();
  const { actorId, boxId, packageIds } = await pendingVerifyTask();

  // verify-step re-scan against the closed box: both flags set
  await verifyPackage(client.db, { packageId: packageIds[0], actorId });
  const rescanned = await queryGet<{ verified: boolean; verifyVerified: boolean }>(
    client.db,
    sql`SELECT verified, verify_verified AS "verifyVerified" FROM picking_packages WHERE id = ${packageIds[0]}`
  );
  assert.deepEqual(rescanned, { verified: true, verifyVerified: true });
  const pkgLog = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'picking_package' AND entity_id = ${packageIds[0]}
        ORDER BY created_date DESC, id DESC LIMIT 1`
  );
  assert.deepEqual(pkgLog, { fromState: "verified", toState: "verify_verified", actorId });

  const dup = await catchHttp(verifyPackage(client.db, { packageId: packageIds[0], actorId }));
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "package_already_verified");

  // closed box WITHOUT a pending verify task (verify step disabled at close)
  await reset(["verify"]);
  const fx = await closedBox();
  assert.equal(await verifyTaskOf(fx.boxId), undefined);
  const noTask = await catchHttp(verifyPackage(client.db, { packageId: fx.packageIds[0], actorId: fx.actorId }));
  assert.equal(noTask.status, 409);
  assert.equal(noTask.message, "no_pending_measure_or_verify_task");
});

// --- reopen during verify --------------------------------------------------------------

test("reopen: closed box → open + both package flags reset, task stays pending; re-verify + re-close + complete; no task duplication", async () => {
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
  assert.equal((await verifyTaskOf(boxId))!.status, "pending"); // task untouched

  const log = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'shipping_box' AND entity_id = ${boxId}
        ORDER BY created_date DESC, id DESC LIMIT 1`
  );
  assert.deepEqual(log, { fromState: "closed", toState: "open", actorId });

  // full re-measure: re-scan (open box → verified), re-close
  for (const packageId of packageIds) {
    await verifyPackage(client.db, { packageId, actorId });
  }
  await closeShippingBox(client.db, { shippingBoxId: boxId, actorId });

  // the re-close re-runs the verify-task spawn idempotently: still exactly
  // one task for the box, and the finished order never re-finishes
  assert.equal((await queryGet<{ n: number }>(client.db, sql`SELECT COUNT(*)::int AS n FROM verify_tasks WHERE shipping_box_id = ${boxId}`))!.n, 1);
  const finishLogs = await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM transaction_logs
        WHERE entity_type = 'picking_order' AND entity_id = ${orderId} AND to_state = 'finished'`
  );
  assert.equal(finishLogs!.n, 1);

  await rescanAll(actorId, packageIds);
  await completeVerifyTask(client.db, { taskId: verifyTaskId, actorId });
  assert.equal((await verifyTaskOf(boxId))!.status, "completed");
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

  // open box guard: a fresh open box never has a verify task
  await reseed(client);
  _setFlowStepsDisabledForTests([]);
  const actorId2 = await actorIdOf();
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const openBox = await createShippingBox(client.db, { pickingOrderId: orderId, actorId: actorId2 });
  const notClosed = await catchHttp(reopenShippingBox(client.db, { shippingBoxId: openBox.id, actorId: actorId2 }));
  assert.equal(notClosed.status, 409);
  assert.equal(notClosed.message, "shipping_box_not_closed");

  // closed box whose verify step was disabled at close (no task at all) → 409
  await reset(["verify"]);
  const fx = await closedBox();
  const noVerify = await catchHttp(reopenShippingBox(client.db, { shippingBoxId: fx.boxId, actorId: fx.actorId }));
  assert.equal(noVerify.status, 409);
  assert.equal(noVerify.message, "verify_task_not_pending");
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
