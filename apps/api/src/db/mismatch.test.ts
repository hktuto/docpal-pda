import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { cancelMismatch, confirmMismatch, editMismatch, getLatestMismatch, reportMismatch } from "./mismatch.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO users (id, username, password_hash, role, name, created_at, updated_at)
      VALUES ('reporter','reporter','h','operator','Reporter','0','0'),
             ('confirmer','confirmer','h','operator','Confirmer','0','0');
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','P','P','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e','R','in_hand','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('inv','ro','INV','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
      VALUES ('rii','inv','p',10,10,10,'0','0');
  `);
  return { sqlite, db };
}

function seedItem(sqlite: any, id: string, opts: { qty?: number; received?: number; picked?: number; available?: number } = {}) {
  const { qty = 10, received = 10, picked = 0, available = received - picked } = opts;
  sqlite
    .prepare(
      `INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, picked_qty, available_qty, created_at, updated_at)
       VALUES (?, 'inv', 'p', ?, ?, ?, ?, '0', '0')`
    )
    .run(id, qty, received, picked, available);
}

function item(sqlite: any, id: string) {
  return sqlite.prepare(`SELECT received_qty, available_qty, picked_qty FROM receiving_invoice_items WHERE id = ?`).get(id) as any;
}

function transitionLogs(sqlite: any) {
  return sqlite
    .prepare("SELECT from_status, to_status, actor_id FROM transition_logs WHERE entity_type='receiving_item_mismatch' ORDER BY created_at, id")
    .all() as any[];
}

test("reportMismatch creates a pending row and applies the effective received qty", () => {
  const { sqlite, db } = makeDb();
  const row = db.transaction((tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "qty_mismatch", mismatchQty: 8, actorId: "reporter" })
  );
  assert.equal(row.kind, "qty_mismatch");
  assert.equal(row.mismatch_qty, 8);
  assert.equal(row.status, "pending");
  assert.equal(row.reported_by, "reporter");
  assert.equal(row.effective_received_qty, 8);
  assert.equal(row.previous_received_qty, 10);
  // web semantics: the effective qty is applied to the item already at report time
  assert.deepEqual(item(sqlite, "rii"), { received_qty: 8, available_qty: 8, picked_qty: 0 });
  assert.deepEqual(transitionLogs(sqlite), [{ from_status: null, to_status: "pending", actor_id: "reporter" }]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("a second report on the same item is rejected (409)", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "qty_mismatch", mismatchQty: 8, actorId: "reporter" }));
  assert.throws(
    () => db.transaction((tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "damaged", mismatchQty: 1, actorId: "reporter" })),
    (e: any) => e.status === 409
  );
  // rejected report changed nothing: still exactly one active row with its original values
  const active = sqlite.prepare("SELECT * FROM receiving_item_mismatches WHERE status != 'cancelled'").all() as any[];
  assert.equal(active.length, 1);
  assert.equal(active[0].kind, "qty_mismatch");
  assert.equal(active[0].mismatch_qty, 8);
  assert.equal(active[0].status, "pending");
  assert.deepEqual(item(sqlite, "rii"), { received_qty: 8, available_qty: 8, picked_qty: 0 });
  assertInvariantsHold(db);
  sqlite.close();
});

test("reportMismatch returns 404 for an unknown item", () => {
  const { sqlite, db } = makeDb();
  assert.throws(
    () => db.transaction((tx) => reportMismatch(tx, { receivingInvoiceItemId: "nope", reason: "not_found", mismatchQty: null, actorId: "reporter" })),
    (e: any) => e.status === 404
  );
  sqlite.close();
});

test("editMismatch: non-reporter is rejected; the reporter's edit re-applies the qty", () => {
  const { sqlite, db } = makeDb();
  const reported = db.transaction((tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "qty_mismatch", mismatchQty: 8, actorId: "reporter" })
  );
  assert.throws(
    () => db.transaction((tx) => editMismatch(tx, { mismatchId: reported.id, actorId: "confirmer", reason: "damaged", mismatchQty: 3 })),
    (e: any) => e.status === 409
  );
  // rejected edit changed nothing: the row keeps its reported values
  const unchanged = sqlite.prepare("SELECT kind, mismatch_qty, effective_received_qty, status FROM receiving_item_mismatches WHERE id = ?").get(reported.id) as any;
  assert.deepEqual(unchanged, { kind: "qty_mismatch", mismatch_qty: 8, effective_received_qty: 8, status: "pending" });
  assert.deepEqual(item(sqlite, "rii"), { received_qty: 8, available_qty: 8, picked_qty: 0 });
  const edited = db.transaction((tx) =>
    editMismatch(tx, { mismatchId: reported.id, actorId: "reporter", reason: "damaged", mismatchQty: 3 })
  );
  assert.equal(edited.kind, "damaged");
  assert.equal(edited.mismatch_qty, 3);
  assert.equal(edited.effective_received_qty, 7);
  assert.equal(edited.status, "pending");
  assert.deepEqual(item(sqlite, "rii"), { received_qty: 7, available_qty: 7, picked_qty: 0 });
  assertInvariantsHold(db);
  sqlite.close();
});

test("confirmMismatch: the reporter cannot confirm; another user confirms", () => {
  const { sqlite, db } = makeDb();
  const reported = db.transaction((tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "qty_mismatch", mismatchQty: 8, actorId: "reporter" })
  );
  db.transaction((tx) => editMismatch(tx, { mismatchId: reported.id, actorId: "reporter", reason: "damaged", mismatchQty: 3 }));
  assert.throws(
    () => db.transaction((tx) => confirmMismatch(tx, { mismatchId: reported.id, actorId: "reporter" })),
    (e: any) => e.status === 409
  );
  const confirmed = db.transaction((tx) => confirmMismatch(tx, { mismatchId: reported.id, actorId: "confirmer" }));
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmed_by, "confirmer");
  assert.ok(confirmed.confirmed_at);
  // damaged 3 of 10 -> effective 7 was applied at edit time; confirm keeps it
  assert.deepEqual(item(sqlite, "rii"), { received_qty: 7, available_qty: 7, picked_qty: 0 });
  assert.deepEqual(transitionLogs(sqlite).at(-1), { from_status: "pending", to_status: "confirmed", actor_id: "confirmer" });
  // a confirmed mismatch still blocks a new report
  assert.throws(
    () => db.transaction((tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "damaged", mismatchQty: 1, actorId: "reporter" })),
    (e: any) => e.status === 409
  );
  assertInvariantsHold(db);
  sqlite.close();
});

test("cancelMismatch: the reporter cannot cancel; another user cancels, reverts the qty, and a new report succeeds", () => {
  const { sqlite, db } = makeDb();
  seedItem(sqlite, "rii2");
  const reported = db.transaction((tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii2", reason: "qty_mismatch", mismatchQty: 8, actorId: "reporter" })
  );
  assert.throws(
    () => db.transaction((tx) => cancelMismatch(tx, { mismatchId: reported.id, actorId: "reporter" })),
    (e: any) => e.status === 409
  );
  const cancelled = db.transaction((tx) => cancelMismatch(tx, { mismatchId: reported.id, actorId: "confirmer" }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelled_by, "confirmer");
  assert.ok(cancelled.cancelled_at);
  // cancel reverts received_qty to previous_received_qty
  assert.deepEqual(item(sqlite, "rii2"), { received_qty: 10, available_qty: 10, picked_qty: 0 });
  assert.equal(getLatestMismatch(db, "rii2"), null);
  const fresh = db.transaction((tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii2", reason: "qty_mismatch", mismatchQty: 5, actorId: "reporter" })
  );
  assert.equal(fresh.status, "pending");
  assert.equal(getLatestMismatch(db, "rii2")?.id, fresh.id);
  assertInvariantsHold(db);
  sqlite.close();
});

test("validation errors map to 400", () => {
  const { sqlite, db } = makeDb();
  seedItem(sqlite, "rii3");
  // over_shipment requires qty > 0
  assert.throws(
    () => db.transaction((tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii3", reason: "over_shipment", mismatchQty: 0, actorId: "reporter" })),
    (e: any) => e.status === 400 && e.message === "quantity_must_be_greater_than_zero"
  );
  // wrong_part requires wrong_part_no
  assert.throws(
    () => db.transaction((tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii3", reason: "wrong_part", mismatchQty: 2, actorId: "reporter" })),
    (e: any) => e.status === 400 && e.message === "wrong_part_number_required"
  );
  // not_found cannot carry a qty
  assert.throws(
    () => db.transaction((tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii3", reason: "not_found", mismatchQty: 2, actorId: "reporter" })),
    (e: any) => e.status === 400 && e.message === "not_found_mismatch_cannot_include_qty"
  );
  assert.equal(getLatestMismatch(db, "rii3"), null);
  assertInvariantsHold(db);
  sqlite.close();
});

test("report is rejected (409) when the effective qty falls below picked + put-away + allocated", () => {
  const { sqlite, db } = makeDb();
  seedItem(sqlite, "rii4", { picked: 4 }); // received 10, picked 4, available 6
  // web semantics: assertCanApplyMismatchQty runs at report time, so the report itself
  // is rejected — there is no pending row left to confirm.
  assert.throws(
    () => db.transaction((tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii4", reason: "not_found", mismatchQty: null, actorId: "reporter" })),
    (e: any) => e.status === 409 && e.message === "mismatch_qty_below_consumed_stock"
  );
  assert.equal(getLatestMismatch(db, "rii4"), null);
  assertInvariantsHold(db);
  sqlite.close();
});
