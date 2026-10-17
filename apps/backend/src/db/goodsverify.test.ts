import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet, queryRun } from "./query.js";
import { allocateAll } from "./allocate.js";
import { confirmReceivingArrival } from "./receiving.js";
import { assignScanToBox, closeShelfBox, createShelfBox, recordPutAwayScan } from "./putaway.js";
import { runGoodsVerifyDayEnd } from "../jobs/goodsVerifyDayEnd.js";
import {
  generateGoodsVerifyTasks,
  getGoodsVerifyTaskDetail,
  listGoodsVerifyTasks,
  verifyGoodsVerifyTask,
} from "./goodsverify.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

// --- business-key lookups (never hardcode seed UUIDs) ------------------------

async function actorIdOf(username = "operator"): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

async function receivingOrderIdOf(batchNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = ${batchNo}`);
  return row!.id;
}

async function invoiceItemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId} AND rii.part_no = ${partNo}`
  );
  return row!.id;
}

async function seedLotIdOf(partNo: string, shelfCode: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT il.id FROM inventory_lots il
        WHERE il.part_no = ${partNo} AND il.shelf_code = ${shelfCode}`
  );
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

interface PutAwayFixture {
  actorId: string;
  orderId: string;
  boxId: string;
}

/**
 * Drive the seeded pending KOA order (100002) through the real flows:
 * confirm arrival (RECEIVE_TO_DOCK rows with NULL lot — never task-eligible),
 * then put away the two C2001 items in full into one box on A0103 (PUT_AWAY
 * rows materialize the two lots that generation should pick up).
 */
async function putAwayFixture(opts: { close: boolean }): Promise<PutAwayFixture> {
  const actorId = await actorIdOf();
  const orderId = await receivingOrderIdOf("100002");
  await confirmReceivingArrival(client.db, orderId, actorId);
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A0103", actorId });
  const s1 = await recordPutAwayScan(client.db, orderId, {
    actorId,
    receivingInvoiceItemId: await invoiceItemIdOf(orderId, "RK73B1JTTD181G"),
    qty: 600,
  });
  const s2 = await recordPutAwayScan(client.db, orderId, {
    actorId,
    receivingInvoiceItemId: await invoiceItemIdOf(orderId, "RK73H1JTTD4702F"),
    qty: 1200,
  });
  await assignScanToBox(client.db, { scanId: s1.id, shelfBoxId: box.id, actorId });
  await assignScanToBox(client.db, { scanId: s2.id, shelfBoxId: box.id, actorId });
  if (opts.close) await closeShelfBox(client.db, { shelfBoxId: box.id, actorId });
  return { actorId, orderId, boxId: box.id };
}

// --- generate ------------------------------------------------------------------

test("generate: one task per shelf with net movement, idempotent re-run, date validation", async () => {
  await reseed(client);
  await putAwayFixture({ close: true });

  const today = (await queryGet<{ d: string }>(client.db, sql`SELECT CURRENT_DATE::text AS d`))!.d;
  const r1 = await generateGoodsVerifyTasks(client.db, {});
  assert.equal(r1.date, today);
  assert.equal(r1.created, 1); // one shelf (A0103) with two parts moved

  const rows = await listGoodsVerifyTasks(client.db, {});
  assert.equal(rows.length, 1);
  const task = rows[0];
  assert.equal(task.taskDate, today);
  assert.equal(task.shelfCode, "A0103");
  assert.equal(task.status, "pending");
  assert.equal(task.verifiedBy, null);
  assert.equal(task.verifiedAt, null);
  assert.equal(task.movementsCount, 2);

  // movements array carries per-part summary
  const byPartNo = new Map(task.movements.map((m) => [m.partNo, m]));
  const m1 = byPartNo.get("RK73B1JTTD181G")!;
  assert.equal(m1.qtyChange, 600);
  assert.equal(m1.currentTotal, 600);
  assert.equal(m1.wclItemNo, "RK73B1JTTD181G");
  const m2 = byPartNo.get("RK73H1JTTD4702F")!;
  assert.equal(m2.qtyChange, 1200);
  assert.equal(m2.currentTotal, 1200);

  // idempotent: the (task_date, shelf_code) unique index absorbs the re-run
  const r2 = await generateGoodsVerifyTasks(client.db, {});
  assert.equal(r2.created, 0);
  assert.equal((await listGoodsVerifyTasks(client.db, {})).length, 1);

  // a day without movements generates nothing
  const r3 = await generateGoodsVerifyTasks(client.db, { date: "2020-01-01" });
  assert.deepEqual(r3, { created: 0, date: "2020-01-01" });

  const bad = await catchHttp(generateGoodsVerifyTasks(client.db, { date: "not-a-date" }));
  assert.equal(bad.status, 400);
  assert.equal(bad.message, "invalid_date");
});

test("generate: only parts with non-zero net delta are included", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  const orderId = await receivingOrderIdOf("100002");
  await confirmReceivingArrival(client.db, orderId, actorId);
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A0103", actorId });

  // Put away 600 of RK73B1JTTD181G
  const s1 = await recordPutAwayScan(client.db, orderId, {
    actorId,
    receivingInvoiceItemId: await invoiceItemIdOf(orderId, "RK73B1JTTD181G"),
    qty: 600,
  });
  await assignScanToBox(client.db, { scanId: s1.id, shelfBoxId: box.id, actorId });

  // Add a PICK transaction that exactly cancels the put-away (net zero)
  const lotId = await seedLotIdOf("RK73B1JTTD181G", "A0103");
  await queryRun(
    client.db,
    sql`INSERT INTO inventory_transactions (id, inventory_lot_id, part_no, shelf_code, box_id, txn_type, qty_type, qty_delta, txn_at, created_date)
        VALUES (gen_random_uuid()::text, ${lotId}, 'RK73B1JTTD181G', 'A0103', ${box.id}, 'PICK', 'on_hand', -600, now(), now())`
  );

  const r = await generateGoodsVerifyTasks(client.db, {});
  assert.equal(r.created, 0); // net zero → no task
});

// --- queue ---------------------------------------------------------------------

test("queue: filters pass through, shelf ordering", async () => {
  await reseed(client);
  await putAwayFixture({ close: true });
  const { date } = await generateGoodsVerifyTasks(client.db, {});

  const all = await listGoodsVerifyTasks(client.db, {});
  assert.equal(all.length, 1);
  assert.equal(all[0].shelfCode, "A0103");

  assert.equal((await listGoodsVerifyTasks(client.db, { date })).length, 1);
  assert.equal((await listGoodsVerifyTasks(client.db, { date: "2020-01-01" })).length, 0);
  assert.equal((await listGoodsVerifyTasks(client.db, { status: "pending" })).length, 1);
  assert.equal((await listGoodsVerifyTasks(client.db, { status: "verified" })).length, 0);
  assert.equal((await listGoodsVerifyTasks(client.db, { shelfCode: "A0103" })).length, 1);
  assert.equal((await listGoodsVerifyTasks(client.db, { shelfCode: "A0101" })).length, 0);
  assert.equal((await listGoodsVerifyTasks(client.db, { date, status: "pending", shelfCode: "A0103" })).length, 1);
  assert.equal((await listGoodsVerifyTasks(client.db, { date, status: "verified", shelfCode: "A0103" })).length, 0);
});

// --- detail --------------------------------------------------------------------

test("detail: task with movements; 404", async () => {
  await reseed(client);
  await putAwayFixture({ close: true });
  await generateGoodsVerifyTasks(client.db, {});

  const rows = await listGoodsVerifyTasks(client.db, {});
  const row = rows[0];
  const detail = await getGoodsVerifyTaskDetail(client.db, row.id);

  assert.equal(detail.task.id, row.id);
  assert.equal(detail.task.shelfCode, "A0103");
  assert.equal(detail.task.status, "pending");
  assert.equal(detail.task.movementsCount, 2);
  assert.ok(detail.task.createdDate);

  const byPartNo = new Map(detail.task.movements.map((m) => [m.partNo, m]));
  assert.equal(byPartNo.get("RK73B1JTTD181G")!.qtyChange, 600);
  assert.equal(byPartNo.get("RK73H1JTTD4702F")!.qtyChange, 1200);

  const notFound = await catchHttp(getGoodsVerifyTaskDetail(client.db, randomUUID()));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "goods_verify_task_not_found");
});

// --- verify happy path ----------------------------------------------------------

test("verify: pure confirmation — task verified, transition log, no ADJUST", async () => {
  await reseed(client);
  const { actorId } = await putAwayFixture({ close: true });
  await generateGoodsVerifyTasks(client.db, {});
  const row = (await listGoodsVerifyTasks(client.db, {}))[0];

  const res = await verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId });
  assert.equal(res.adjusted, false);

  const task = await queryGet<{ status: string; verifiedBy: string; verifiedAt: Date }>(
    client.db,
    sql`SELECT status, verified_by AS "verifiedBy", verified_at AS "verifiedAt" FROM goods_verify_tasks WHERE id = ${row.id}`
  );
  assert.equal(task!.status, "verified");
  assert.equal(task!.verifiedBy, actorId);
  assert.ok(task!.verifiedAt);

  const taskLog = await queryGet<{ fromState: string; toState: string; actorId: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'goods_verify_task' AND entity_id = ${row.id}`
  );
  assert.deepEqual(taskLog, { fromState: "pending", toState: "verified", actorId });

  // no correction → no ADJUST row
  assert.equal(
    (await queryAll(client.db, sql`SELECT id FROM inventory_transactions WHERE txn_type = 'ADJUST'`)).length,
    0
  );
});

// --- verify guards ---------------------------------------------------------------

test("verify guards: 404, actor_not_found, not pending", async () => {
  await reseed(client);
  const { actorId } = await putAwayFixture({ close: true });
  await generateGoodsVerifyTasks(client.db, {});
  const row = (await listGoodsVerifyTasks(client.db, {}))[0];

  const notFound = await catchHttp(verifyGoodsVerifyTask(client.db, { taskId: randomUUID(), actorId }));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "goods_verify_task_not_found");

  const badActor = await catchHttp(verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId: randomUUID() }));
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");

  // verify once, then a second verify is rejected
  await verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId });
  const again = await catchHttp(verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId }));
  assert.equal(again.status, 409);
  assert.equal(again.message, "goods_verify_task_not_pending");
});

// --- nightly cron runner (jobs/goodsVerifyDayEnd.ts) -------------------------

test("runGoodsVerifyDayEnd: covers yesterday's movements, idempotent re-run", async () => {
  await reseed(client);
  const lotId = await seedLotIdOf("RK73H1JTTD1002F", "A0101");
  // an on-hand movement stamped yesterday (the business day that just ended
  // at 00:00); reserved-only movement never generates a task
  await queryRun(
    client.db,
    sql`INSERT INTO inventory_transactions (id, inventory_lot_id, part_no, shelf_code, box_id, txn_type, qty_type, qty_delta, txn_at, created_date)
        SELECT gen_random_uuid()::text, id, part_no, shelf_code, box_id, 'PICK', 'on_hand', -100,
               now() - interval '1 day', now() - interval '1 day'
        FROM inventory_lots WHERE id = ${lotId}`
  );

  const yesterday = (await queryGet<{ d: string }>(client.db, sql`SELECT (CURRENT_DATE - 1)::text AS d`))!.d;
  const r1 = await runGoodsVerifyDayEnd(client.db);
  assert.equal(r1.created, 1);
  assert.deepEqual(r1.dates, [yesterday, (await queryGet<{ d: string }>(client.db, sql`SELECT CURRENT_DATE::text AS d`))!.d]);

  const tasks = await listGoodsVerifyTasks(client.db, {});
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskDate, yesterday);
  assert.equal(tasks[0].shelfCode, "A0101");

  const r2 = await runGoodsVerifyDayEnd(client.db);
  assert.equal(r2.created, 0);
});
