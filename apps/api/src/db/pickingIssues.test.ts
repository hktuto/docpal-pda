import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { reportPickingOrderIssues } from "./pickingIssues.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO users (id, username, password_hash, role, name, created_at, updated_at)
      VALUES ('op7','op7','h','operator','Op7','0','0');
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p7','P7','P7','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES
      ('po7a','e7a','PO-7A','pending','0','0'),
      ('po7b','e7b','PO-7B','picking','0','0'),
      ('po7c','e7c','PO-7C','finished','0','0'),
      ('po7d','e7d','PO-7D','pending','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES
      ('pi7a','po7a','p7',10,'0','0'),
      ('pi7b','po7b','p7',10,'0','0'),
      ('pi7d','po7d','p7',3,'0','0');
  `);
  return { sqlite, db };
}

function order(sqlite: any, id: string) {
  return sqlite
    .prepare(
      `SELECT status, issue_reason, issue_qty, issue_pack_size, issue_note, issue_remark,
              issue_reported_at, issue_reported_by
       FROM picking_orders WHERE id = ?`
    )
    .get(id) as any;
}

function logs(sqlite: any, orderId: string) {
  return sqlite
    .prepare(
      `SELECT from_status, to_status, actor_id FROM transition_logs
       WHERE entity_type='picking_order' AND entity_id = ? ORDER BY created_at, id`
    )
    .all(orderId) as any[];
}

test("insufficient_stock reports pending/picking orders and skips finished ones", () => {
  const { sqlite, db } = makeDb();
  const result = db.transaction((tx) =>
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

  const a = order(sqlite, "po7a");
  assert.equal(a.status, "issue");
  assert.equal(a.issue_reason, "insufficient_stock");
  assert.equal(a.issue_qty, 5);
  assert.equal(a.issue_pack_size, null);
  assert.equal(a.issue_remark, "short on shelf");
  assert.equal(a.issue_reported_by, "op7");
  assert.ok(a.issue_reported_at);

  const b = order(sqlite, "po7b");
  assert.equal(b.status, "issue");
  assert.equal(b.issue_qty, 5);
  assert.equal(b.issue_reported_by, "op7");

  // the finished order is untouched
  assert.equal(order(sqlite, "po7c").status, "finished");

  assert.deepEqual(logs(sqlite, "po7a"), [{ from_status: "pending", to_status: "issue", actor_id: "op7" }]);
  assert.deepEqual(logs(sqlite, "po7b"), [{ from_status: "picking", to_status: "issue", actor_id: "op7" }]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("insufficient_stock qty must be >= 0 and below the order's total required qty", () => {
  const { sqlite, db } = makeDb();
  assert.throws(
    () =>
      db.transaction((tx) =>
        reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "insufficient_stock", qty: 10, actorId: "op7" })
      ),
    (e: any) => e.status === 400
  );
  assert.throws(
    () =>
      db.transaction((tx) =>
        reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "insufficient_stock", qty: -1, actorId: "op7" })
      ),
    (e: any) => e.status === 400
  );
  // rejected reports changed nothing: no status change, no transition logs
  assert.equal(order(sqlite, "po7a").status, "pending");
  assert.deepEqual(logs(sqlite, "po7a"), []);
  assertInvariantsHold(db);
  sqlite.close();
});

test("a mid-loop validation failure rolls back earlier updates and logs", () => {
  const { sqlite, db } = makeDb();
  // po7a (total 10) passes the qty check, po7d (total 3) fails it second
  assert.throws(
    () =>
      db.transaction((tx) =>
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
  assert.equal(order(sqlite, "po7a").status, "pending");
  assert.deepEqual(logs(sqlite, "po7a"), []);
  assert.equal(order(sqlite, "po7d").status, "pending");
  assertInvariantsHold(db);
  sqlite.close();
});

test("cannot_divide requires a positive pack_size and stores it", () => {
  const { sqlite, db } = makeDb();
  assert.throws(
    () =>
      db.transaction((tx) =>
        reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "cannot_divide", packSize: 0, actorId: "op7" })
      ),
    (e: any) => e.status === 400
  );
  assert.deepEqual(logs(sqlite, "po7a"), []);
  const result = db.transaction((tx) =>
    reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "cannot_divide", packSize: 6, actorId: "op7" })
  );
  assert.deepEqual(result.reported, ["po7a"]);
  const a = order(sqlite, "po7a");
  assert.equal(a.status, "issue");
  assert.equal(a.issue_reason, "cannot_divide");
  assert.equal(a.issue_pack_size, 6);
  assert.equal(a.issue_qty, null);
  assertInvariantsHold(db);
  sqlite.close();
});

test("merge requires at least two orders", () => {
  const { sqlite, db } = makeDb();
  assert.throws(
    () =>
      db.transaction((tx) =>
        reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "merge", actorId: "op7" })
      ),
    (e: any) => e.status === 400
  );
  assert.deepEqual(logs(sqlite, "po7a"), []);
  const result = db.transaction((tx) =>
    reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a", "po7b"], reason: "merge", actorId: "op7" })
  );
  assert.deepEqual(result.reported, ["po7a", "po7b"]);
  assert.equal(order(sqlite, "po7a").issue_reason, "merge");
  assert.equal(order(sqlite, "po7b").issue_reason, "merge");
  assertInvariantsHold(db);
  sqlite.close();
});

test("'other' reports with remark only (no qty/pack_size), mirroring the web", () => {
  const { sqlite, db } = makeDb();
  const result = db.transaction((tx) =>
    reportPickingOrderIssues(tx, { pickingOrderIds: ["po7a"], reason: "other", remark: "damaged label", actorId: "op7" })
  );
  assert.deepEqual(result.reported, ["po7a"]);
  const a = order(sqlite, "po7a");
  assert.equal(a.status, "issue");
  assert.equal(a.issue_reason, "other");
  assert.equal(a.issue_qty, null);
  assert.equal(a.issue_pack_size, null);
  assert.equal(a.issue_note, null);
  assert.equal(a.issue_remark, "damaged label");
  assertInvariantsHold(db);
  sqlite.close();
});

test("unknown order ids are skipped, not an error", () => {
  const { sqlite, db } = makeDb();
  const result = db.transaction((tx) =>
    reportPickingOrderIssues(tx, {
      pickingOrderIds: ["nope", "po7a"],
      reason: "cannot_divide",
      packSize: 6,
      actorId: "op7",
    })
  );
  assert.deepEqual(result.reported, ["po7a"]);
  assert.deepEqual(result.skipped, ["nope"]);
  assertInvariantsHold(db);
  sqlite.close();
});
