import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { createTestDb } from "./test-helper.js";
import { resetTables } from "./tables.js";
import { cancelMismatch, editMismatch, getMismatch, reportMismatch } from "./mismatch.js";
import { assertInvariantsHold } from "./invariants.guard.js";

const { sql: testSql, db } = await createTestDb();

test.beforeEach(async () => {
  await resetTables(db);
});

const T0 = "2024-01-01T00:00:00Z";

async function seedBase() {
  await db.execute(`
    INSERT INTO users (id, username, password_hash, display_name, created_at)
      VALUES ('reporter','reporter','h','Reporter','${T0}'),
             ('other','other','h','Other','${T0}');
    INSERT INTO parts (id, part_no) VALUES ('p','P');
    INSERT INTO receiving_orders (id, ref_no, status, created_at, updated_at) VALUES ('ro','R','in_hand','${T0}','${T0}');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('inv','ro','INV','${T0}','${T0}');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty)
      VALUES ('rii','inv','p',10,10);
  `);
}

async function seedItem(id: string, opts: { qty?: number; received?: number; picked?: number } = {}) {
  const { qty = 10, received = 10, picked = 0 } = opts;
  await db.execute(sql`
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, picked_qty)
    VALUES (${id}, 'inv', 'p', ${qty}, ${received}, ${picked})
  `);
}

/** Single-level allocation consuming `qty` of the item (picking_items.allocated_qty kept in sync). */
async function seedAllocation(itemId: string, qty: number) {
  await db.execute(`
    INSERT INTO picking_orders (id, ref_no, status, created_at, updated_at) VALUES ('po-${itemId}','PO-${itemId}','picking','${T0}','${T0}');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, allocated_qty, created_at, updated_at)
      VALUES ('pi-${itemId}','po-${itemId}','p',${qty},${qty},'${T0}','${T0}');
    INSERT INTO allocations (id, picking_item_id, receiving_invoice_item_id, qty, created_at, updated_at)
      VALUES ('al-${itemId}','pi-${itemId}','${itemId}',${qty},'${T0}','${T0}');
  `);
}

async function item(id: string) {
  return (await db.execute<{
    received_qty: number; picked_qty: number; reported_mismatch: boolean;
    mismatch_reason: string | null; mismatch_qty: number | null;
    wrong_part_no: string | null; mismatch_note: string | null;
  }>(
    sql`SELECT received_qty, picked_qty, reported_mismatch, mismatch_reason, mismatch_qty, wrong_part_no, mismatch_note
        FROM receiving_invoice_items WHERE id = ${id}`
  ))[0];
}

interface LogRow {
  from_state: string | null;
  to_state: string;
  actor_id: string;
  metadata: Record<string, unknown>;
}

async function transitionLogs(): Promise<LogRow[]> {
  return Array.from(
    await db.execute<LogRow>(
      `SELECT from_state, to_state, actor_id, metadata FROM transaction_logs
       WHERE entity_type = 'receiving_invoice_item' ORDER BY created_at, id`
    )
  );
}

test("reportMismatch flags the item inline and applies the effective received qty", async () => {
  await seedBase();
  assert.equal(await getMismatch(db, "rii"), null);
  const row = await db.transaction(async (tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "qty_mismatch", mismatchQty: 8, actorId: "reporter" })
  );
  assert.deepEqual(row, {
    receiving_invoice_item_id: "rii",
    reason: "qty_mismatch",
    mismatch_qty: 8,
    wrong_part_no: null,
    note: null,
    effective_received_qty: 8,
    reported: true,
  });
  // the effective qty is applied to the item already at report time
  assert.deepEqual(await item("rii"), {
    received_qty: 8,
    picked_qty: 0,
    reported_mismatch: true,
    mismatch_reason: "qty_mismatch",
    mismatch_qty: 8,
    wrong_part_no: null,
    mismatch_note: null,
  });
  const logs = await transitionLogs();
  assert.deepEqual(
    logs.map(({ from_state, to_state, actor_id }) => ({ from_state, to_state, actor_id })),
    [{ from_state: null, to_state: "mismatch_reported", actor_id: "reporter" }]
  );
  assert.deepEqual(logs[0].metadata, {
    reason: "qty_mismatch",
    mismatchQty: 8,
    wrongPartNo: null,
    note: null,
    previousReceivedQty: 10,
    effectiveReceivedQty: 8,
  });
  await assertInvariantsHold(db);
});

test("reportMismatch wrong_part stores wrong_part_no, zeroes the receipt, and trims note/part no", async () => {
  await seedBase();
  const row = await db.transaction(async (tx) =>
    reportMismatch(tx, {
      receivingInvoiceItemId: "rii",
      reason: "wrong_part",
      mismatchQty: 4,
      wrongPartNo: " X-9 ",
      note: " swapped ",
      actorId: "reporter",
    })
  );
  assert.deepEqual(row, {
    receiving_invoice_item_id: "rii",
    reason: "wrong_part",
    mismatch_qty: 4,
    wrong_part_no: "X-9",
    note: "swapped",
    effective_received_qty: 0,
    reported: true,
  });
  assert.equal((await item("rii")).received_qty, 0);
  await assertInvariantsHold(db);
});

test("a second report on the same item is rejected (409 mismatch_already_reported)", async () => {
  await seedBase();
  await db.transaction(async (tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "qty_mismatch", mismatchQty: 8, actorId: "reporter" })
  );
  await assert.rejects(
    () => db.transaction(async (tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "damaged", mismatchQty: 1, actorId: "reporter" })),
    (e: any) => e.status === 409 && e.message === "mismatch_already_reported"
  );
  // the rejected report changed nothing
  assert.deepEqual(await item("rii"), {
    received_qty: 8,
    picked_qty: 0,
    reported_mismatch: true,
    mismatch_reason: "qty_mismatch",
    mismatch_qty: 8,
    wrong_part_no: null,
    mismatch_note: null,
  });
  await assertInvariantsHold(db);
});

test("reportMismatch returns 404 for an unknown item", async () => {
  await seedBase();
  await assert.rejects(
    () => db.transaction(async (tx) => reportMismatch(tx, { receivingInvoiceItemId: "nope", reason: "not_found", mismatchQty: null, actorId: "reporter" })),
    (e: any) => e.status === 404 && e.message === "receiving_invoice_item_not_found"
  );
});

test("editMismatch: 409 when nothing is reported; any actor may edit and re-apply the qty", async () => {
  await seedBase();
  await assert.rejects(
    () => db.transaction(async (tx) => editMismatch(tx, { receivingInvoiceItemId: "rii", actorId: "reporter", mismatchQty: 5 })),
    (e: any) => e.status === 409 && e.message === "no_mismatch_reported"
  );
  await db.transaction(async (tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "qty_mismatch", mismatchQty: 8, actorId: "reporter" })
  );
  // the inline model stores no reporter, so the old reporter-only rule is gone
  const edited = await db.transaction(async (tx) =>
    editMismatch(tx, { receivingInvoiceItemId: "rii", actorId: "other", reason: "damaged", mismatchQty: 3 })
  );
  assert.equal(edited.reason, "damaged");
  assert.equal(edited.mismatch_qty, 3);
  assert.equal(edited.effective_received_qty, 7);
  assert.equal(edited.reported, true);
  assert.equal((await item("rii")).received_qty, 7);
  assert.deepEqual((await transitionLogs()).map((l) => l.to_state), ["mismatch_reported", "mismatch_updated"]);
  await assertInvariantsHold(db);
});

test("cancelMismatch clears the inline fields, restores received_qty, and allows a fresh report", async () => {
  await seedBase();
  await assert.rejects(
    () => db.transaction(async (tx) => cancelMismatch(tx, { receivingInvoiceItemId: "rii", actorId: "other" })),
    (e: any) => e.status === 409 && e.message === "no_mismatch_reported"
  );
  await db.transaction(async (tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "qty_mismatch", mismatchQty: 8, actorId: "reporter" })
  );
  const cancelled = await db.transaction(async (tx) => cancelMismatch(tx, { receivingInvoiceItemId: "rii", actorId: "other" }));
  assert.deepEqual(cancelled, {
    receiving_invoice_item_id: "rii",
    reason: null,
    mismatch_qty: null,
    wrong_part_no: null,
    note: null,
    effective_received_qty: 10,
    reported: false,
  });
  assert.deepEqual(await item("rii"), {
    received_qty: 10,
    picked_qty: 0,
    reported_mismatch: false,
    mismatch_reason: null,
    mismatch_qty: null,
    wrong_part_no: null,
    mismatch_note: null,
  });
  assert.equal(await getMismatch(db, "rii"), null);
  const logs = await transitionLogs();
  assert.deepEqual(logs.map((l) => l.to_state), ["mismatch_reported", "mismatch_cancelled"]);
  assert.deepEqual(logs.at(-1)!.metadata, { restoredReceivedQty: 10 });
  // a fresh report succeeds after a cancel
  const fresh = await db.transaction(async (tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "qty_mismatch", mismatchQty: 5, actorId: "reporter" })
  );
  assert.equal(fresh.effective_received_qty, 5);
  assert.equal((await getMismatch(db, "rii"))?.mismatch_qty, 5);
  await assertInvariantsHold(db);
});

test("cancel restores the document qty (documented approximation for partial receipts)", async () => {
  await seedBase();
  await seedItem("rii2", { qty: 10, received: 6 });
  await db.transaction(async (tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii2", reason: "qty_mismatch", mismatchQty: 5, actorId: "reporter" })
  );
  assert.equal((await item("rii2")).received_qty, 5);
  await db.transaction(async (tx) => cancelMismatch(tx, { receivingInvoiceItemId: "rii2", actorId: "reporter" }));
  // previous_received_qty no longer exists anywhere: cancel restores qty (10), not the pre-report 6
  assert.equal((await item("rii2")).received_qty, 10);
  await assertInvariantsHold(db);
});

test("validation errors map to 400", async () => {
  await seedBase();
  // over_shipment requires qty > 0
  await assert.rejects(
    () => db.transaction(async (tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "over_shipment", mismatchQty: 0, actorId: "reporter" })),
    (e: any) => e.status === 400 && e.message === "quantity_must_be_greater_than_zero"
  );
  // wrong_part requires wrong_part_no
  await assert.rejects(
    () => db.transaction(async (tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "wrong_part", mismatchQty: 2, actorId: "reporter" })),
    (e: any) => e.status === 400 && e.message === "wrong_part_number_required"
  );
  // not_found cannot carry a qty
  await assert.rejects(
    () => db.transaction(async (tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii", reason: "not_found", mismatchQty: 2, actorId: "reporter" })),
    (e: any) => e.status === 400 && e.message === "not_found_mismatch_cannot_include_qty"
  );
  // the rejected reports left the item untouched
  assert.equal(await getMismatch(db, "rii"), null);
  assert.equal((await item("rii")).received_qty, 10);
  await assertInvariantsHold(db);
});

test("report is rejected (409) when the effective qty falls below picked + put-away + allocated", async () => {
  await seedBase();
  await seedItem("rii3", { picked: 4 }); // received 10, picked 4
  await seedAllocation("rii3", 2); // allocated 2 -> consumed 6
  await assert.rejects(
    () => db.transaction(async (tx) => reportMismatch(tx, { receivingInvoiceItemId: "rii3", reason: "not_found", mismatchQty: null, actorId: "reporter" })),
    (e: any) => e.status === 409 && e.message === "mismatch_qty_below_consumed_stock"
  );
  assert.equal(await getMismatch(db, "rii3"), null);
  // an effective qty that still covers consumption is accepted
  const row = await db.transaction(async (tx) =>
    reportMismatch(tx, { receivingInvoiceItemId: "rii3", reason: "damaged", mismatchQty: 2, actorId: "reporter" })
  );
  assert.equal(row.effective_received_qty, 8);
  await assertInvariantsHold(db);
});

test.after(async () => {
  await testSql.end();
});
