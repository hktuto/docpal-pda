import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { setupTestDb, reseed, upstreamWrite, type TestDb } from "./test-helper.js";
import { fetchSyncEventsSince } from "./sync-events.js";
import { upsertPart, deletePart, upsertPickingOrder, deletePickingOrder } from "./ingest.js";

// Trigger-driven table-change feed (catalog: docs/backend/event-catalog.md).
// reseed() suppresses the trigger (SET LOCAL app.sync_events_off), so each
// test starts with an empty sync_events table and only its own writes appear.

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

test("trigger: backend-role writes emit <table>.<op> events with new/old row images", async () => {
  await reseed(client);
  assert.equal((await fetchSyncEventsSince(client.db, 0)).length, 0, "reseed leaves no events");

  const partId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO parts (id, brand, part_no) VALUES (${partId}, 'KOA', 'SYNC-TEST-1')`
  );
  await upstreamWrite(client, (tx) => tx.execute(sql`UPDATE parts SET description = 'desc' WHERE id = ${partId}`));
  await client.db.execute(sql`DELETE FROM parts WHERE id = ${partId}`);

  const rows = await fetchSyncEventsSince(client.db, 0);
  assert.deepEqual(
    rows.map((r) => r.eventType),
    ["parts.insert", "parts.update", "parts.delete"]
  );

  const [ins, upd, del] = rows as [any, any, any];
  assert.equal(ins.eventData.table, "parts");
  assert.equal(ins.eventData.action, "INSERT");
  assert.equal(ins.eventData.new.part_no, "SYNC-TEST-1");
  assert.equal(ins.eventData.old, null);
  assert.equal(upd.eventData.action, "UPDATE");
  assert.equal(upd.eventData.new.description, "desc");
  assert.equal(upd.eventData.old.description, null);
  assert.equal(del.eventData.action, "DELETE");
  assert.equal(del.eventData.new, null);
  assert.equal(del.eventData.old.part_no, "SYNC-TEST-1");

  // since-cursor paging
  const after = await fetchSyncEventsSince(client.db, ins.id);
  assert.deepEqual(
    after.map((r) => r.eventType),
    ["parts.update", "parts.delete"]
  );
});

test("trigger: app.sync_events_off suppresses events", async () => {
  await reseed(client);
  await client.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.sync_events_off = 1`);
    await tx.execute(
      sql`INSERT INTO parts (id, brand, part_no) VALUES (${randomUUID()}, 'KOA', 'SYNC-TEST-2')`
    );
  });
  assert.equal((await fetchSyncEventsSince(client.db, 0)).length, 0);
});

test("trigger: rolled-back writes leave no events", async () => {
  await reseed(client);
  await assert.rejects(
    client.db.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO parts (id, brand, part_no) VALUES (${randomUUID()}, 'KOA', 'SYNC-TEST-3')`
      );
      throw new Error("boom");
    })
  );
  assert.equal((await fetchSyncEventsSince(client.db, 0)).length, 0);
});

test("ingest: upsert/delete writes are suppressed from the feed", async () => {
  await reseed(client);

  // Master-data ingest: create + update + delete.
  const partNo = "SYNC-INGEST-1";
  const wclItemNo = "WCL/SYNC-INGEST-1";
  await upsertPart(client.db, { partNo, wclItemNo, brand: "KOA", description: "ingest" });
  await upsertPart(client.db, { partNo, wclItemNo, brand: "KOA", description: "ingest v2" });
  await deletePart(client.db, wclItemNo);

  // Order ingest: create (pending) + delete. Seeded part RK73H1JTTD1002F.
  const orderId = "eeeeeeee-0000-4000-8000-0000000000ee";
  await upsertPickingOrder(client.db, orderId, {
    order: { orderNo: "SYNC-INGEST-PO-1" },
    items: [{ partNo: "RK73H1JTTD1002F", qty: 5, lineId: 1, lineNumber: 1, shipmentNumber: 1 }],
  });
  await deletePickingOrder(client.db, orderId);

  assert.equal((await fetchSyncEventsSince(client.db, 0)).length, 0);
});
