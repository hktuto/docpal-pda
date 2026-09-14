import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { emitEvent, fetchEventsSince, pruneEvents } from "./events.js";
import { allocateAll } from "./allocate.js";
import { generateGoodsVerifyTasks } from "./goodsverify.js";

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
