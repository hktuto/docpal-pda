import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestDb } from "./test-helper.js";
import { resetTables } from "./tables.js";
import { reportPickingOrderIssues } from "./pickingIssues.js";
import { assertInvariantsHold } from "./invariants.guard.js";

const { sql: sqlClient, db } = await createTestDb();

async function seedFixtures() {
  await resetTables(db);
  await db.execute(
    `INSERT INTO users (id, username, password_hash, role, display_name, created_at) VALUES ('op7','op7','h','operator','Op7',now())`
  );
  await db.execute(
    `INSERT INTO parts (id, part_no) VALUES ('p7','P7')`
  );
  await db.execute(
    `INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES
      ('po7a','PO-7A','pending',now(),now()),
      ('po7b','PO-7B','picking',now(),now()),
      ('po7c','PO-7C','finished',now(),now()),
      ('po7d','PO-7D','pending',now(),now())`
  );
  await db.execute(
    `INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES
      ('pi7a','po7a','p7',10,now(),now()),
      ('pi7b','po7b','p7',10,now(),now()),
      ('pi7d','po7d','p7',3,now(),now())`
  );
}

async function order(id: string) {
  const rows = await db.execute<{
    status: string;
    issue_reason: string | null;
    issue_qty: number | null;
    issue_pack_size: number | null;
    issue_note: string | null;
    issue_remark: string | null;
    issue_reported_at: string | null;
    issue_reported_by: string | null;
  }>(
    sql`SELECT status, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark, issue_reported_at, issue_reported_by
        FROM picking_orders WHERE id = ${id}`
  );
  return rows[0];
}

async function logs(orderId: string) {
  return await db.execute<{ from_state: string; to_state: string; actor_id: string }>(
    sql`SELECT from_state, to_state, actor_id FROM transaction_logs
        WHERE entity_type='picking_order' AND entity_id = ${orderId}
        ORDER BY created_at, id`
  );
}

test("insufficient_stock reports pending/picking orders and skips finished ones", async () => {
  await seedFixtures();
  const result = await db.transaction(async (tx) =>
    reportPickingOrderIssues(tx, {
      pickingOrderIds: ["po7a", "po7b", "po7c"],
      reason: "insufficient_stock",
      qty: 5,
      remark: "short on shelf",
      actorId: "op7",
    })
  );
  assert.deepEqual(result.reported, ["po7a", "po7b"]);
  assert.deepEqual(result.skipped, ["po7c"]);

  const a = (await order("po7a"))!;
  assert.equal(a.status, "issue");
  assert.equal(a.issue_reason, "insufficient_stock");
  assert.equal(a.issue_qty, 5);
  assert.equal(a.issue_pack_size, null);
  assert.equal(a.issue_remark, "short on shelf");
  assert.equal(a.issue_reported_by, "op7");
  assert.ok(a.issue_reported_at);

  const b = (await order("po7b"))!;
  assert.equal(b.status, "issue");
  assert.equal(b.issue_qty, 5);
  assert.equal(b.issue_reported_by, "op7");

  // the finished order is untouched
  assert.equal((await order("po7c"))!.status, "finished");

  assert.deepEqual(Array.from(await logs("po7a")), [{ from_state: "pending", to_state: "issue", actor_id: "op7" }]);
  assert.deepEqual(Array.from(await logs("po7b")), [{ from_state: "picking", to_state: "issue", actor_id: "op7" }]);
  await assertInvariantsHold(db);
});

test("insufficient_stock qty must be >= 0 and below the order's total required qty", async () => {
  await seedFixtures();
  await assert.rejects(
    async () =>
      db.transaction(async (tx) =>
        reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "insufficient_stock", qty: 10, actorId: "op7" })
      ),
    (e: any) => e.status === 400
  );
  await assert.rejects(
    async () =>
      db.transaction(async (tx) =>
        reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "insufficient_stock", qty: -1, actorId: "op7" })
      ),
    (e: any) => e.status === 400
  );
  // rejected reports changed nothing: no status change, no transition logs
  assert.equal((await order("po7a"))!.status, "pending");
  assert.deepEqual(Array.from(await logs("po7a")), []);
  await assertInvariantsHold(db);
});

test("a mid-loop validation failure rolls back earlier updates and logs", async () => {
  await seedFixtures();
  // po7a (total 10) passes the qty check, po7d (total 3) fails it second
  await assert.rejects(
    async () =>
      db.transaction(async (tx) =>
        reportPickingOrderIssues(tx, {
          pickingOrderIds: ["po7a", "po7d"],
          reason: "insufficient_stock",
          qty: 5,
          actorId: "op7",
        })
      ),
    (e: any) => e.status === 400
  );
  // po7a's update + transition log were rolled back with the transaction
  assert.equal((await order("po7a"))!.status, "pending");
  assert.deepEqual(Array.from(await logs("po7a")), []);
  assert.equal((await order("po7d"))!.status, "pending");
  await assertInvariantsHold(db);
});

test("cannot_divide requires a positive pack_size and stores it", async () => {
  await seedFixtures();
  await assert.rejects(
    async () =>
      db.transaction(async (tx) =>
        reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "cannot_divide", packSize: 0, actorId: "op7" })
      ),
    (e: any) => e.status === 400
  );
  assert.deepEqual(Array.from(await logs("po7a")), []);
  const result = await db.transaction(async (tx) =>
    reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "cannot_divide", packSize: 6, actorId: "op7" })
  );
  assert.deepEqual(result.reported, ["po7a"]);
  const a = (await order("po7a"))!;
  assert.equal(a.status, "issue");
  assert.equal(a.issue_reason, "cannot_divide");
  assert.equal(a.issue_pack_size, 6);
  assert.equal(a.issue_qty, null);
  await assertInvariantsHold(db);
});

test("merge requires at least two orders", async () => {
  await seedFixtures();
  await assert.rejects(
    async () =>
      db.transaction(async (tx) =>
        reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "merge", actorId: "op7" })
      ),
    (e: any) => e.status === 400
  );
  assert.deepEqual(Array.from(await logs("po7a")), []);
  const result = await db.transaction(async (tx) =>
    reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a", "po7b"], reason: "merge", actorId: "op7" })
  );
  assert.deepEqual(result.reported, ["po7a", "po7b"]);
  assert.equal((await order("po7a"))!.issue_reason, "merge");
  assert.equal((await order("po7b"))!.issue_reason, "merge");
  await assertInvariantsHold(db);
});

test("'other' reports with remark only (no qty/pack_size), mirroring the web", async () => {
  await seedFixtures();
  const result = await db.transaction(async (tx) =>
    reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "other", remark: "damaged label", actorId: "op7" })
  );
  assert.deepEqual(result.reported, ["po7a"]);
  const a = (await order("po7a"))!;
  assert.equal(a.status, "issue");
  assert.equal(a.issue_reason, "other");
  assert.equal(a.issue_qty, null);
  assert.equal(a.issue_pack_size, null);
  assert.equal(a.issue_note, null);
  assert.equal(a.issue_remark, "damaged label");
  await assertInvariantsHold(db);
});

test("unknown order ids are skipped, not an error", async () => {
  await seedFixtures();
  const result = await db.transaction(async (tx) =>
    reportPickingOrderIssues(tx, {
      pickingOrderIds: ["nope", "po7a"],
      reason: "cannot_divide",
      packSize: 6,
      actorId: "op7",
    })
  );
  assert.deepEqual(result.reported, ["po7a"]);
  assert.deepEqual(result.skipped, ["nope"]);
  await assertInvariantsHold(db);
});

test.after(async () => {
  await sqlClient.end();
});
