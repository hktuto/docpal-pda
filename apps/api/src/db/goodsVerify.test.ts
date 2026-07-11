import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createDb } from "./client.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createTables } from "./tables.js";
import { verifyShelfBoxItem, scheduleCycleCount } from "./putAway.js";
import { completeVerificationTask } from "./measure.js";
import { assertInvariantsHold } from "./invariants.guard.js";

// route-test bootstrap: temp DATABASE_URL must be set before importing the app
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
const dbPath = path.join(dir, "t.sqlite");
process.env.DATABASE_URL = dbPath;
const { app } = await import("../index.js");
const routeSqlite = new Database(dbPath);

routeSqlite.exec(`
  INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
  INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0'), ('p2','Y','Y','0','0');
  INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','e','RO-1','in_hand','sup','0','0');
  INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at) VALUES ('inv','e','ro','INV-1','sup','0','0');
  INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, put_away_qty, created_at, updated_at) VALUES ('rii','inv','p',5,5,5,'0','0'), ('rii2','inv','p2',3,3,3,'0','0');
  INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at, updated_at) VALUES ('box','ro','A1','closed','0','0');
  INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, verified, created_at, updated_at) VALUES ('pas','rii',5,'box',0,'0','0'), ('pas2','rii2',3,'box',0,'0','0');
  INSERT INTO verification_tasks (id, kind, status, shelf_box_id, due_at, created_at, updated_at) VALUES ('vt','cycle_count','pending','box','2099-01-01T09:00:00.000Z','0','0');
`);

function makeDb() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(d, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0'), ('p2','Y','Y','0','0');
    INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','e','RO-1','in_hand','sup','0','0');
    INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at) VALUES ('inv','e','ro','INV-1','sup','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, put_away_qty, created_at, updated_at) VALUES ('rii','inv','p',5,5,5,'0','0'), ('rii2','inv','p2',3,3,3,'0','0');
    INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at, updated_at) VALUES ('box','ro','A1','closed','0','0');
    INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, verified, created_at, updated_at) VALUES ('pas','rii',5,'box',0,'0','0'), ('pas2','rii2',3,'box',0,'0','0');
    INSERT INTO verification_tasks (id, kind, status, shelf_box_id, due_at, created_at, updated_at) VALUES ('vt','cycle_count','pending','box','2099-01-01T09:00:00.000Z','0','0');
  `);
  return { sqlite, db };
}

test("verifyShelfBoxItem verifies only the given part's scans in the box", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p", actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT verified FROM put_away_scans WHERE id='pas'").get() as any).verified, 1);
  assert.equal((sqlite.prepare("SELECT verified FROM put_away_scans WHERE id='pas2'").get() as any).verified, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("verifyShelfBoxItem 404s when the part has no unverified scans in the box", () => {
  const { sqlite, db } = makeDb();
  assert.throws(
    () => db.transaction((tx) => verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "nope" })),
    (e: any) => e.status === 404,
  );
  sqlite.close();
});

test("completeVerificationTask(cycle_count) 409s while scans remain unverified", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p" }));
  assert.throws(
    () => db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: "vt", actorId: "u1" })),
    (e: any) => e.status === 409,
  );
  sqlite.close();
});

test("completeVerificationTask(cycle_count) completes task and marks box verified", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => {
    verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p" });
    verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p2" });
    completeVerificationTask(tx, { verificationTaskId: "vt", actorId: "u1" });
  });
  assert.equal((sqlite.prepare("SELECT status FROM verification_tasks WHERE id='vt'").get() as any).status, "completed");
  assert.equal((sqlite.prepare("SELECT status FROM shelf_boxes WHERE id='box'").get() as any).status, "verified");
  assertInvariantsHold(db);
  sqlite.close();
});

test("same-day complete + restock creates a new pending task and resets the box", () => {
  const { sqlite, db } = makeDb();
  // align the seeded task's due date with scheduleCycleCount's nextMorning() (local tomorrow 09:00)
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  sqlite.prepare("UPDATE verification_tasks SET due_at=? WHERE id='vt'").run(d.toISOString());
  db.transaction((tx) => {
    verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p" });
    verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p2" });
    completeVerificationTask(tx, { verificationTaskId: "vt", actorId: "u1" });
  });
  assert.equal((sqlite.prepare("SELECT status FROM shelf_boxes WHERE id='box'").get() as any).status, "verified");
  // same-day stock change must schedule a NEW task (completed same-day task must not coalesce)
  db.transaction((tx) => scheduleCycleCount(tx, "box"));
  const counts = sqlite.prepare(
    "SELECT SUM(status='pending') AS pending, SUM(status='completed') AS completed FROM verification_tasks WHERE kind='cycle_count' AND shelf_box_id='box'"
  ).get() as any;
  assert.equal(counts.pending, 1);
  assert.equal(counts.completed, 1);
  assert.equal((sqlite.prepare("SELECT status FROM shelf_boxes WHERE id='box'").get() as any).status, "closed");
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS c FROM put_away_scans WHERE shelf_box_id='box' AND verified=1").get() as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("completeVerificationTask(cycle_count) 409s when the box is not closed", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => {
    verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p" });
    verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p2" });
  });
  for (const status of ["open", "verified"]) {
    sqlite.exec(`UPDATE shelf_boxes SET status='${status}' WHERE id='box'`);
    assert.throws(
      () => db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: "vt", actorId: "u1" })),
      (e: any) => e.status === 409,
    );
  }
  sqlite.close();
});

test("POST /shelf-boxes/:id/verify-item marks scans verified", async () => {
  const res = await app.request("/shelf-boxes/box/verify-item", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ part_id: "p", actor_id: "u1" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.verified_count, 1);
});

test("GET /verification-tasks?due_before=... filters by due_at", async () => {
  const res = await app.request("/verification-tasks?due_before=2099-01-02T00:00:00.000Z");
  assert.equal(res.status, 200);
  const tasks = (await res.json()) as any[];
  assert.ok(tasks.some((t) => t.id === "vt"));
  const res2 = await app.request("/verification-tasks?due_before=2020-01-01T00:00:00.000Z");
  assert.equal(((await res2.json()) as any[]).length, 0);
});

test("cleanup", () => { routeSqlite.close(); });
