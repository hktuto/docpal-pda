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

async function receivingOrderIdOf(refNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE ref_no = ${refNo}`);
  return row!.id;
}

async function invoiceItemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        JOIN parts p ON p.id = rii.part_id
        WHERE ri.receiving_order_id = ${orderId} AND p.part_no = ${partNo}`
  );
  return row!.id;
}

async function seedLotIdOf(partNo: string, shelfCode: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT il.id FROM inventory_lots il JOIN parts p ON p.id = il.part_id
        WHERE p.part_no = ${partNo} AND il.shelf_code = ${shelfCode}`
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
 * Drive the seeded pending DAITO order (04958210) through the real flows:
 * confirm arrival (RECEIVE_TO_DOCK rows with NULL lot — never task-eligible),
 * then put away both items in full into one box on A-01-03 (PUT_AWAY rows
 * materialize the two lots that generation should pick up).
 */
async function putAwayFixture(opts: { close: boolean }): Promise<PutAwayFixture> {
  const actorId = await actorIdOf();
  const orderId = await receivingOrderIdOf("04958210");
  await confirmReceivingArrival(client.db, orderId, actorId);
  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  const s1 = await recordPutAwayScan(client.db, orderId, {
    actorId,
    receivingInvoiceItemId: await invoiceItemIdOf(orderId, "RK73B1JTTD181G"),
    qty: 5000,
  });
  const s2 = await recordPutAwayScan(client.db, orderId, {
    actorId,
    receivingInvoiceItemId: await invoiceItemIdOf(orderId, "P413"),
    qty: 3000,
  });
  await assignScanToBox(client.db, { scanId: s1.id, shelfBoxId: box.id, actorId });
  await assignScanToBox(client.db, { scanId: s2.id, shelfBoxId: box.id, actorId });
  if (opts.close) await closeShelfBox(client.db, { shelfBoxId: box.id, actorId });
  return { actorId, orderId, boxId: box.id };
}

// --- generate ------------------------------------------------------------------

test("generate: one task per lot moved that day, idempotent re-run, date validation", async () => {
  await reseed(client);
  await putAwayFixture({ close: true });

  const today = (await queryGet<{ d: string }>(client.db, sql`SELECT CURRENT_DATE::text AS d`))!.d;
  const r1 = await generateGoodsVerifyTasks(client.db, {});
  assert.equal(r1.date, today);
  assert.equal(r1.created, 2); // the two put-away lots (RECEIVE_TO_DOCK rows carry no lot)

  // one task per distinct lot moved today, snapshotting the lot
  const movedLots = await queryAll<{ id: string }>(
    client.db,
    sql`SELECT DISTINCT inventory_lot_id AS id FROM inventory_transactions
        WHERE inventory_lot_id IS NOT NULL AND txn_at::date = CURRENT_DATE`
  );
  assert.equal(movedLots.length, 2);

  const rows = await listGoodsVerifyTasks(client.db, {});
  assert.equal(rows.length, 2);
  const byPartNo = new Map(rows.map((r) => [r.partNo, r]));
  const t1 = byPartNo.get("RK73B1JTTD181G")!;
  assert.equal(t1.taskDate, today);
  assert.equal(t1.shelfCode, "A-01-03");
  assert.ok(t1.boxId);
  assert.equal(t1.expectedQty, 5000); // lot total_qty snapshot
  assert.equal(t1.status, "pending");
  assert.equal(t1.verifiedBy, null);
  assert.equal(t1.verifiedAt, null);
  assert.equal(byPartNo.get("P413")!.expectedQty, 3000);
  assert.equal(byPartNo.get("P413")!.wclItemNo, "P413");

  // idempotent: the (task_date, inventory_lot_id) unique index absorbs the re-run
  const r2 = await generateGoodsVerifyTasks(client.db, {});
  assert.equal(r2.created, 0);
  assert.equal((await listGoodsVerifyTasks(client.db, {})).length, 2);

  // a day without movements generates nothing
  const r3 = await generateGoodsVerifyTasks(client.db, { date: "2020-01-01" });
  assert.deepEqual(r3, { created: 0, date: "2020-01-01" });

  const bad = await catchHttp(generateGoodsVerifyTasks(client.db, { date: "not-a-date" }));
  assert.equal(bad.status, 400);
  assert.equal(bad.message, "invalid_date");
});

// --- queue ---------------------------------------------------------------------

test("queue: filters pass through, part join, shelf/box/part ordering", async () => {
  await reseed(client);
  await putAwayFixture({ close: true });
  const { date } = await generateGoodsVerifyTasks(client.db, {});

  const all = await listGoodsVerifyTasks(client.db, {});
  assert.equal(all.length, 2);
  // same shelf + box → ordered by part_no
  assert.equal(all[0].partNo, "P413");
  assert.equal(all[1].partNo, "RK73B1JTTD181G");

  assert.equal((await listGoodsVerifyTasks(client.db, { date })).length, 2);
  assert.equal((await listGoodsVerifyTasks(client.db, { date: "2020-01-01" })).length, 0);
  assert.equal((await listGoodsVerifyTasks(client.db, { status: "pending" })).length, 2);
  assert.equal((await listGoodsVerifyTasks(client.db, { status: "verified" })).length, 0);
  assert.equal((await listGoodsVerifyTasks(client.db, { shelfCode: "A-01-03" })).length, 2);
  assert.equal((await listGoodsVerifyTasks(client.db, { shelfCode: "A-01-01" })).length, 0);
  assert.equal((await listGoodsVerifyTasks(client.db, { date, status: "pending", shelfCode: "A-01-03" })).length, 2);
  assert.equal((await listGoodsVerifyTasks(client.db, { date, status: "verified", shelfCode: "A-01-03" })).length, 0);
});

// --- detail --------------------------------------------------------------------

test("detail: task + lot + box items; legacy box id → box null; 404", async () => {
  await reseed(client);
  const { actorId, boxId } = await putAwayFixture({ close: true });
  await generateGoodsVerifyTasks(client.db, {});

  const rows = await listGoodsVerifyTasks(client.db, {});
  const row = rows.find((r) => r.partNo === "RK73B1JTTD181G")!;
  const detail = await getGoodsVerifyTaskDetail(client.db, row.id);

  assert.equal(detail.task.id, row.id);
  assert.ok(detail.task.inventoryLotId);
  assert.equal(detail.task.shelfCode, "A-01-03");
  assert.equal(detail.task.boxId, boxId);
  assert.equal(detail.task.partNo, "RK73B1JTTD181G");
  assert.equal(detail.task.wclItemNo, "RK73B1JTTD181G");
  assert.equal(detail.task.description, "RES 180 OHM 5% 1/10W 0603");
  assert.equal(detail.task.expectedQty, 5000);
  assert.equal(detail.task.status, "pending");
  assert.ok(detail.task.createdAt);

  assert.deepEqual(detail.lot, {
    id: detail.task.inventoryLotId,
    dateCode: "2610",
    lotCode: null,
    coo: "JP",
    cow: null,
    shelfCode: "A-01-03",
    boxId,
    totalQty: 5000,
    allocatedQty: 0,
    availableQty: 5000,
    warehouseCode: "HK1",
    warehouseSectionCode: "HK",
    subInventoryCode: "STORE1",
  });

  assert.ok(detail.box);
  assert.equal(detail.box!.id, boxId);
  assert.equal(detail.box!.status, "closed");
  assert.equal(detail.box!.items.length, 2);
  assert.deepEqual(
    detail.box!.items.map((i) => ({ partNo: i.partNo, qty: i.qty, verified: i.verified, verifiedAt: i.verifiedAt })),
    [
      { partNo: "P413", qty: 3000, verified: false, verifiedAt: null },
      { partNo: "RK73B1JTTD181G", qty: 5000, verified: false, verifiedAt: null },
    ]
  );

  const notFound = await catchHttp(getGoodsVerifyTaskDetail(client.db, randomUUID()));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "goods_verify_task_not_found");

  // A seed lot moved (direct ledger row, e.g. a RESERVE): its legacy box id is
  // not a shelf_boxes row → detail.box null, verify skips box handling.
  const lotId = await seedLotIdOf("RK73H1JTTD1002F", "A-01-01");
  await queryRun(
    client.db,
    sql`INSERT INTO inventory_transactions (id, inventory_lot_id, part_id, shelf_code, box_id, txn_type, qty_type, qty_delta, txn_at, created_at)
        SELECT gen_random_uuid()::text, id, part_id, shelf_code, box_id, 'RESERVE', 'reserved', -100, now(), now()
        FROM inventory_lots WHERE id = ${lotId}`
  );
  const r = await generateGoodsVerifyTasks(client.db, {});
  assert.equal(r.created, 1);
  const seedTask = (await listGoodsVerifyTasks(client.db, {})).find((t) => t.partNo === "RK73H1JTTD1002F")!;
  assert.equal(seedTask.boxId, "BOX-0001"); // legacy box id copied from the lot
  const seedDetail = await getGoodsVerifyTaskDetail(client.db, seedTask.id);
  assert.equal(seedDetail.box, null);
  assert.equal(seedDetail.lot.totalQty, 10000);

  const res = await verifyGoodsVerifyTask(client.db, { taskId: seedTask.id, actorId });
  assert.equal(res.adjusted, false);
  const after = await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM goods_verify_tasks WHERE id = ${seedTask.id}`
  );
  assert.equal(after!.status, "verified");
});

// --- verify happy path ----------------------------------------------------------

test("verify: matching count — task/box/items verified, transition logs, no ADJUST", async () => {
  await reseed(client);
  const { actorId, boxId } = await putAwayFixture({ close: true });
  await generateGoodsVerifyTasks(client.db, {});
  const row = (await listGoodsVerifyTasks(client.db, {})).find((r) => r.partNo === "P413")!;

  const res = await verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId, countedQty: 3000 });
  assert.equal(res.adjusted, false); // countedQty == expectedQty → no correction

  const task = await queryGet<{ status: string; verifiedBy: string; verifiedAt: Date }>(
    client.db,
    sql`SELECT status, verified_by AS "verifiedBy", verified_at AS "verifiedAt" FROM goods_verify_tasks WHERE id = ${row.id}`
  );
  assert.equal(task!.status, "verified");
  assert.equal(task!.verifiedBy, actorId);
  assert.ok(task!.verifiedAt);

  const box = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM shelf_boxes WHERE id = ${boxId}`);
  assert.equal(box!.status, "verified");
  const items = await queryAll<{ verified: boolean; verifiedAt: Date | null }>(
    client.db,
    sql`SELECT verified, verified_at AS "verifiedAt" FROM shelf_box_items WHERE shelf_box_id = ${boxId}`
  );
  assert.equal(items.length, 2);
  for (const i of items) {
    assert.equal(i.verified, true);
    assert.ok(i.verifiedAt);
  }

  const boxLog = await queryGet<{ fromState: string; toState: string; actorId: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'shelf_box' AND entity_id = ${boxId} AND to_state = 'verified'`
  );
  assert.deepEqual(boxLog, { fromState: "closed", toState: "verified", actorId });
  const taskLog = await queryGet<{ fromState: string; toState: string; actorId: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'goods_verify_task' AND entity_id = ${row.id}`
  );
  assert.deepEqual(taskLog, { fromState: "pending", toState: "verified", actorId });

  // no correction → no ADJUST row, lot untouched
  assert.equal(
    (await queryAll(client.db, sql`SELECT id FROM inventory_transactions WHERE txn_type = 'ADJUST'`)).length,
    0
  );
  const lot = await queryGet<{ totalQty: number }>(
    client.db,
    sql`SELECT il.total_qty AS "totalQty" FROM inventory_lots il
        JOIN goods_verify_tasks gvt ON gvt.inventory_lot_id = il.id WHERE gvt.id = ${row.id}`
  );
  assert.equal(lot!.totalQty, 3000);
});

// --- verify with count mismatch --------------------------------------------------

test("verify: no countedQty → no ADJUST; mismatch → ADJUST row + lot total_qty updated", async () => {
  await reseed(client);
  const { actorId, boxId } = await putAwayFixture({ close: true });
  await generateGoodsVerifyTasks(client.db, {});
  const rows = await listGoodsVerifyTasks(client.db, {});
  const tP413 = rows.find((r) => r.partNo === "P413")!;
  const tR180 = rows.find((r) => r.partNo === "RK73B1JTTD181G")!;

  // no countedQty: pure confirmation, box closes out on this first task
  const r1 = await verifyGoodsVerifyTask(client.db, { taskId: tP413.id, actorId });
  assert.equal(r1.adjusted, false);
  assert.equal(
    (await queryAll(client.db, sql`SELECT id FROM inventory_transactions WHERE txn_type = 'ADJUST'`)).length,
    0
  );
  assert.equal(
    (await queryGet<{ status: string }>(client.db, sql`SELECT status FROM shelf_boxes WHERE id = ${boxId}`))!.status,
    "verified"
  );

  // mismatch on the second task of the same (already verified) box: corrects
  // the lot + ADJUST, no second box transition
  const r2 = await verifyGoodsVerifyTask(client.db, { taskId: tR180.id, actorId, countedQty: 4800 });
  assert.equal(r2.adjusted, true);

  const lot = await queryGet<{ id: string; totalQty: number; allocatedQty: number; availableQty: number }>(
    client.db,
    sql`SELECT il.id, il.total_qty AS "totalQty", il.allocated_qty AS "allocatedQty", il.available_qty AS "availableQty"
        FROM inventory_lots il JOIN goods_verify_tasks gvt ON gvt.inventory_lot_id = il.id
        WHERE gvt.id = ${tR180.id}`
  );
  assert.deepEqual(
    { totalQty: lot!.totalQty, allocatedQty: lot!.allocatedQty, availableQty: lot!.availableQty },
    { totalQty: 4800, allocatedQty: 0, availableQty: 4800 }
  );

  const adjust = await queryGet<{
    qtyType: string;
    qtyDelta: number;
    inventoryLotId: string;
    partId: string;
    shelfCode: string;
    boxId: string;
    dateCode: string;
    lotCode: string | null;
    coo: string;
    cow: string | null;
    referenceType: string;
    referenceId: string;
    actorId: string;
    txnReason: string;
  }>(
    client.db,
    sql`SELECT qty_type AS "qtyType", qty_delta AS "qtyDelta",
               inventory_lot_id AS "inventoryLotId", part_id AS "partId",
               shelf_code AS "shelfCode", box_id AS "boxId",
               date_code AS "dateCode", lot_code AS "lotCode", coo, cow,
               reference_type AS "referenceType", reference_id AS "referenceId",
               actor_id AS "actorId", txn_reason AS "txnReason"
        FROM inventory_transactions WHERE txn_type = 'ADJUST'`
  );
  assert.ok(adjust);
  assert.equal(adjust!.qtyType, "on_hand");
  assert.equal(adjust!.qtyDelta, -200); // 4800 counted − 5000 expected
  assert.equal(adjust!.inventoryLotId, lot!.id);
  assert.equal(adjust!.shelfCode, "A-01-03");
  assert.equal(adjust!.boxId, boxId);
  assert.equal(adjust!.dateCode, "2610");
  assert.equal(adjust!.referenceType, "goods_verify_task");
  assert.equal(adjust!.referenceId, tR180.id);
  assert.equal(adjust!.actorId, actorId);
  assert.equal(adjust!.txnReason, "cycle count adjustment");

  const boxLogs = await queryAll<{ id: string }>(
    client.db,
    sql`SELECT id FROM transaction_logs WHERE entity_type = 'shelf_box' AND entity_id = ${boxId} AND to_state = 'verified'`
  );
  assert.equal(boxLogs.length, 1);
});

// --- verify guards ---------------------------------------------------------------

test("verify guards: 404, actor_not_found, open box, invalid countedQty, not pending", async () => {
  await reseed(client);
  const { actorId, boxId } = await putAwayFixture({ close: false }); // box stays OPEN
  await generateGoodsVerifyTasks(client.db, {});
  const row = (await listGoodsVerifyTasks(client.db, {}))[0];

  const notFound = await catchHttp(verifyGoodsVerifyTask(client.db, { taskId: randomUUID(), actorId }));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "goods_verify_task_not_found");

  const badActor = await catchHttp(verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId: randomUUID() }));
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");

  // an open box means put-away may still be in progress → refuse to verify
  const openBox = await catchHttp(verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId }));
  assert.equal(openBox.status, 409);
  assert.equal(openBox.message, "shelf_box_not_closed");

  const negative = await catchHttp(verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId, countedQty: -1 }));
  assert.equal(negative.status, 400);
  assert.equal(negative.message, "counted_qty_must_be_non_negative_integer");
  const fractional = await catchHttp(verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId, countedQty: 1.5 }));
  assert.equal(fractional.status, 400);
  assert.equal(fractional.message, "counted_qty_must_be_non_negative_integer");

  // close the box, verify, then a second verify is rejected
  await closeShelfBox(client.db, { shelfBoxId: boxId, actorId });
  await verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId });
  const again = await catchHttp(verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId }));
  assert.equal(again.status, 409);
  assert.equal(again.message, "goods_verify_task_not_pending");
});

test("verify: counted below allocated → 409 counted_qty_below_allocated; equal allowed", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  await allocateAll(client.db); // RESERVE rows on the seed lots = today's movement
  await generateGoodsVerifyTasks(client.db, {});

  const row = (await listGoodsVerifyTasks(client.db, {})).find((r) => r.partNo === "RK73H1JTTD1002F")!;
  assert.equal(row.expectedQty, 10000); // seed lot total
  const allocated = (
    await queryGet<{ n: number }>(
      client.db,
      sql`SELECT allocated_qty AS n FROM inventory_lots WHERE id = (SELECT inventory_lot_id FROM goods_verify_tasks WHERE id = ${row.id})`
    )
  )!.n;
  assert.equal(allocated, 2000); // SO-2026-0001 allocation

  const below = await catchHttp(verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId, countedQty: 1500 }));
  assert.equal(below.status, 409);
  assert.equal(below.message, "counted_qty_below_allocated");
  // task untouched
  assert.equal(
    (await queryGet<{ status: string }>(client.db, sql`SELECT status FROM goods_verify_tasks WHERE id = ${row.id}`))!.status,
    "pending"
  );

  // counted == allocated is the boundary: available_qty bottoms out at 0
  const res = await verifyGoodsVerifyTask(client.db, { taskId: row.id, actorId, countedQty: 2000 });
  assert.equal(res.adjusted, true);
  const lot = await queryGet<{ totalQty: number; allocatedQty: number; availableQty: number }>(
    client.db,
    sql`SELECT il.total_qty AS "totalQty", il.allocated_qty AS "allocatedQty", il.available_qty AS "availableQty"
        FROM inventory_lots il JOIN goods_verify_tasks gvt ON gvt.inventory_lot_id = il.id WHERE gvt.id = ${row.id}`
  );
  assert.deepEqual(lot, { totalQty: 2000, allocatedQty: 2000, availableQty: 0 });
  const adjust = await queryGet<{ qtyDelta: number }>(
    client.db,
    sql`SELECT qty_delta AS "qtyDelta" FROM inventory_transactions WHERE txn_type = 'ADJUST' AND reference_id = ${row.id}`
  );
  assert.equal(adjust!.qtyDelta, -8000);
});
