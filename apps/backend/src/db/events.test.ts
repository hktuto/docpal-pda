import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { emitEvent, fetchEventsSince, pruneEvents } from "./events.js";
import { allocateAll } from "./allocate.js";
import { generateGoodsVerifyTasks } from "./goodsverify.js";
import {
  upsertPickingOrder,
  upsertReceivingOrder,
  type IngestPickingBody,
  type IngestReceivingBody,
} from "./ingest.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

async function eventsOfType(type: string): Promise<{ id: number; topics: string[]; data: any }[]> {
  const rows = await client.db.execute(
    sql`SELECT id, topics, data FROM app_events WHERE type = ${type} ORDER BY id`
  );
  return rows as unknown as { id: number; topics: string[]; data: any }[];
}

test("emitEvent: rolls back with a failed tx, persists on commit", async () => {
  await reseed(client);
  await assert.rejects(
    client.db.transaction(async (tx) => {
      await emitEvent(tx, { type: "test.rolled_back", topics: ["/test"] });
      throw new Error("boom");
    })
  );
  await client.db.transaction(async (tx) => {
    await emitEvent(tx, { type: "test.committed", topics: ["/test"], data: { n: 1 } });
  });
  const all = await fetchEventsSince(client.db, 0);
  assert.deepEqual(
    all.map((r) => r.type),
    ["test.committed"]
  );
  assert.deepEqual(all[0]!.topics, ["/test"]);
  assert.deepEqual(all[0]!.data, { n: 1 });
});

test("pruneEvents: deletes rows older than 3 days, keeps recent ones", async () => {
  await reseed(client);
  await emitEvent(client.db, { type: "test.old", topics: ["/test"] });
  await client.db.execute(sql`UPDATE app_events SET created_date = now() - interval '4 days'`);
  await emitEvent(client.db, { type: "test.fresh", topics: ["/test"] });
  await pruneEvents(client.db);
  const all = await fetchEventsSince(client.db, 0);
  assert.deepEqual(
    all.map((r) => r.type),
    ["test.fresh"]
  );
});

test("allocateAll: emits one allocation.computed on change, none on an idempotent re-run", async () => {
  await reseed(client);
  const s1 = await allocateAll(client.db);
  assert.ok(s1.allocationsCreated > 0);
  const afterFirst = await eventsOfType("allocation.computed");
  assert.equal(afterFirst.length, 1);
  assert.deepEqual(afterFirst[0]!.topics, ["/picking-orders"]);
  assert.equal(afterFirst[0]!.data.allocationsCreated, s1.allocationsCreated);

  // The full recompute wipes and rebuilds the same rows (counters stay
  // non-zero) but the allocation set is unchanged → no event.
  const s2 = await allocateAll(client.db);
  assert.ok(s2.allocationsCreated > 0);
  assert.equal((await eventsOfType("allocation.computed")).length, 1);
});

const ID_PO_EVT = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const pickingBody: IngestPickingBody = {
  order: { orderNo: "PO-EVT-1" },
  items: [{ partNo: "RK73H1JTTD2202F", qty: 5, lineId: 7001, lineNumber: 1, shipmentNumber: 1 }],
};

test("ingest picking: emits created on insert, nothing on no-change, updated on change", async () => {
  await reseed(client);
  const r1 = await upsertPickingOrder(client.db, ID_PO_EVT, pickingBody);
  assert.equal(r1.created, true);
  let created = await eventsOfType("picking_order.created");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]!.topics, ["/picking-orders"]);
  assert.equal(created[0]!.data.orderNo, "PO-EVT-1");

  const r2 = await upsertPickingOrder(client.db, ID_PO_EVT, pickingBody);
  assert.equal(r2.changed, false);
  assert.equal((await eventsOfType("picking_order.created")).length, 1);
  assert.equal((await eventsOfType("picking_order.updated")).length, 0);

  const r3 = await upsertPickingOrder(client.db, ID_PO_EVT, {
    order: { orderNo: "PO-EVT-1" },
    items: [{ partNo: "RK73H1JTTD2202F", qty: 7, lineId: 7001, lineNumber: 1, shipmentNumber: 1 }],
  });
  assert.equal(r3.changed, true);
  const updated = await eventsOfType("picking_order.updated");
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.data.orderNo, "PO-EVT-1");
});

function receivingBody(): IngestReceivingBody {
  return {
    order: { subInventoryCode: "STORE1" },
    invoices: [{ invoiceNo: "INV-EVT-1", items: [{ partNo: "RK73H1JTTD2202F", lineQty: 10 }] }],
  };
}

test("ingest receiving: emits receiving_order.upserted on create and on change only", async () => {
  await reseed(client);
  const r1 = await upsertReceivingOrder(client.db, "RO-EVT-1", receivingBody());
  assert.equal(r1.created, true);
  const afterCreate = await eventsOfType("receiving_order.upserted");
  assert.equal(afterCreate.length, 1);
  assert.deepEqual(afterCreate[0]!.topics, ["/receiving-orders"]);
  assert.equal(afterCreate[0]!.data.batchNo, "RO-EVT-1");

  const r2 = await upsertReceivingOrder(client.db, "RO-EVT-1", receivingBody());
  assert.equal(r2.changed, false);
  assert.equal((await eventsOfType("receiving_order.upserted")).length, 1);

  const changedBody = receivingBody();
  changedBody.invoices[0]!.items[0]!.lineQty = 12;
  const r3 = await upsertReceivingOrder(client.db, "RO-EVT-1", changedBody);
  assert.equal(r3.changed, true);
  assert.equal((await eventsOfType("receiving_order.upserted")).length, 2);
});

test("generateGoodsVerifyTasks: emits goods_verify.tasks_created with date + count, silent on re-run", async () => {
  await reseed(client);
  await allocateAll(client.db); // RESERVE ledger rows = today's movement on the seed lots
  const r1 = await generateGoodsVerifyTasks(client.db, {});
  assert.ok(r1.created > 0);
  const rows = await eventsOfType("goods_verify.tasks_created");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.topics, ["/goods-verify-tasks"]);
  assert.equal(rows[0]!.data.count, r1.created);
  assert.equal(rows[0]!.data.date, r1.date);

  const r2 = await generateGoodsVerifyTasks(client.db, {});
  assert.equal(r2.created, 0);
  assert.equal((await eventsOfType("goods_verify.tasks_created")).length, 1);
});
