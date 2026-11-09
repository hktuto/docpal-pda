// Cancel-invoice ingest (spec docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md).
// The upstream cancel_invoice / cancel_invoice_tn tables are externally
// managed (no migration, like wcl_part_drawno) — the test creates them itself.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { allocateAll } from "./allocate.js";
import { runCancelInvoiceSyncOnce } from "../jobs/cancelInvoiceSync.js";
import {
  confirmCancelPutBack,
  listCancelRecords,
  setCancelReplacement,
} from "./cancelInvoice.js";
import { listPutBackTasks } from "./putback.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
  // DDL mirrors the live upstream tables (192.168.3.99, Nov 2026).
  await client.db.execute(sql`CREATE TABLE IF NOT EXISTS cancel_invoice (
    id varchar NOT NULL PRIMARY KEY,
    state varchar,
    batch_no varchar,
    pi_deliver_id bigint NOT NULL,
    pi_invoice_num varchar NOT NULL,
    status_code varchar,
    customer_id bigint,
    last_update_date timestamp,
    organization_id bigint,
    update_logs jsonb,
    created_date timestamp,
    updated_date timestamp
  )`);
  await client.db.execute(sql`CREATE TABLE IF NOT EXISTS cancel_invoice_tn (
    id varchar NOT NULL PRIMARY KEY,
    state varchar,
    batch_no varchar,
    tn_number varchar,
    org_id bigint,
    tn_status varchar,
    last_update_date timestamp,
    tn_line_id bigint,
    tn_line_num bigint,
    po_number varchar,
    update_logs jsonb,
    created_date timestamp,
    updated_date timestamp
  )`);
});

after(async () => {
  await client.sql.end({ timeout: 1 });
});

beforeEach(async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM cancel_invoice`);
  await client.db.execute(sql`DELETE FROM cancel_invoice_tn`);
});

// --- helpers (business-key lookups, never hardcoded seed UUIDs) --------------

async function pickingOrderIdOf(orderNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_orders WHERE order_no = ${orderNo}`
  );
  return row!.id;
}

/** Insert one upstream cancel_invoice row; returns its id. */
async function insertInvoiceCancel(piInvoiceNum: string, ts: Date = new Date()): Promise<string> {
  const id = randomUUID();
  await client.db.execute(
    sql`INSERT INTO cancel_invoice (id, state, batch_no, pi_deliver_id, pi_invoice_num, organization_id, created_date, last_update_date)
        VALUES (${id}, 'completed', 'test', 1, ${piInvoiceNum}, 160, ${ts}, ${ts})`
  );
  return id;
}

async function insertTnCancel(tnNumber: string, tnLineId: number, ts: Date = new Date()): Promise<string> {
  const id = randomUUID();
  await client.db.execute(
    sql`INSERT INTO cancel_invoice_tn (id, state, batch_no, tn_number, org_id, tn_status, tn_line_id, tn_line_num, created_date, last_update_date)
        VALUES (${id}, 'completed', 'test', ${tnNumber}, 2, 'CANCELED', ${tnLineId}, 1, ${ts}, ${ts})`
  );
  return id;
}

async function cancelRecordOf(source: string, sourceId: string) {
  return queryGet<{ id: string; outcome: string; status: string; message: string | null; picking_order_id: string | null; picking_item_id: string | null }>(
    client.db,
    sql`SELECT id, outcome, status, message, picking_order_id, picking_item_id FROM cancel_records WHERE source = ${source} AND source_id = ${sourceId}`
  );
}

/** transaction_logs.actor_id has an FK — confirm/replacement need a real user. */
async function anyUserId(): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users ORDER BY created_date LIMIT 1`);
  return row!.id;
}
async function insertOpenOrderWithLines(orderNo: string, lineIds: number[]): Promise<{ orderId: string; itemIds: Record<number, string> }> {
  const orderId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_orders (id, order_no, status, created_date, last_update_date)
        VALUES (${orderId}, ${orderNo}, 'pending', now(), now())`
  );
  const itemIds: Record<number, string> = {};
  for (const lineId of lineIds) {
    const id = randomUUID();
    itemIds[lineId] = id;
    await client.db.execute(
      sql`INSERT INTO picking_items (id, picking_order_id, part_no, qty, line_id, line_number, status, created_date, last_update_date)
          VALUES (${id}, ${orderId}, 'TEST/PART', 100, ${lineId}, ${lineId}, 'pending', now(), now())`
    );
  }
  return { orderId, itemIds };
}

// --- tests -------------------------------------------------------------------

test("cancel_invoice: allocated order → cancelled, items cancelled, allocations released with RESERVE ledger rows", async () => {
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const allocs = await queryAll<{ id: string }>(
    client.db,
    sql`SELECT a.id FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderId} AND a.qty > 0`
  );
  assert.ok(allocs.length > 0, "seeded order should have allocations after allocateAll");

  const sourceId = await insertInvoiceCancel("SO-DEMO-0001");
  await runCancelInvoiceSyncOnce(client.db);

  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "cancelled");
  const itemStatuses = await queryAll<{ status: string }>(
    client.db,
    sql`SELECT status FROM picking_items WHERE picking_order_id = ${orderId}`
  );
  assert.ok(itemStatuses.every((i) => i.status === "cancelled"));
  const left = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderId} AND a.qty > 0`
  );
  assert.equal(left!.c, 0);
  const ledger = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM inventory_transactions
        WHERE txn_type = 'RESERVE' AND txn_reason = 'cancel invoice'
          AND reference_id IN (${sql.join(allocs.map((a) => sql`${a.id}`), sql`, `)})`
  );
  assert.equal(ledger!.c, allocs.length);

  const rec = await cancelRecordOf("cancel_invoice", sourceId);
  assert.equal(rec!.outcome, "cancelled");
  assert.equal(rec!.status, "done");
  assert.equal(rec!.picking_order_id, orderId);
  const tasks = await queryGet<{ c: number }>(client.db, sql`SELECT COUNT(*)::int AS c FROM put_back_tasks`);
  assert.equal(tasks!.c, 0);

  // Re-run: the row is deduped by cancel_records — nothing re-applies.
  await runCancelInvoiceSyncOnce(client.db);
  const n = await queryGet<{ c: number }>(client.db, sql`SELECT COUNT(*)::int AS c FROM cancel_records`);
  assert.equal(n!.c, 1);
});

test("cancel_invoice with a picked boxed package → put-back task + item (source shelf), package un-boxed, emptied box deleted", async () => {
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const alloc = await queryGet<{ itemId: string; lotId: string; partNo: string; shelf: string }>(
    client.db,
    sql`SELECT pi.id AS "itemId", a.inventory_lot_id AS "lotId", pi.part_no AS "partNo", il.shelf_code AS "shelf"
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN inventory_lots il ON il.id = a.inventory_lot_id
        WHERE pi.picking_order_id = ${orderId} AND a.qty > 0
        LIMIT 1`
  );
  assert.ok(alloc?.lotId);

  const boxId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO shipping_boxes (id, picking_order_id, status, created_date, last_update_date)
        VALUES (${boxId}, ${orderId}, 'closed', now(), now())`
  );
  const pkgId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_date, last_update_date)
        VALUES (${pkgId}, ${alloc.itemId}, ${orderId}, 'inventory_lot', ${alloc.lotId}, 10, ${boxId}, now(), now())`
  );

  const sourceId = await insertInvoiceCancel("SO-DEMO-0001");
  await runCancelInvoiceSyncOnce(client.db);

  const task = await queryGet<{ id: string; picking_item_id: string; status: string }>(
    client.db,
    sql`SELECT id, picking_item_id, status FROM put_back_tasks WHERE cancel_source = 'cancel_invoice' AND cancel_source_id = ${sourceId}`
  );
  assert.ok(task);
  assert.equal(task.picking_item_id, ""); // whole-order task
  assert.equal(task.status, "awaiting"); // created by the cron, NOT released to the PDA yet

  const item = await queryGet<{ part_no: string; qty: number; shelf_code: string; status: string; org_id: number | null }>(
    client.db,
    sql`SELECT part_no, qty, shelf_code, status, org_id FROM put_back_task_items WHERE picking_package_id = ${pkgId}`
  );
  assert.ok(item);
  assert.equal(item.shelf_code, alloc.shelf);
  assert.equal(item.qty, 10);
  assert.equal(item.status, "pending");
  assert.notEqual(item.org_id, null);

  // Un-boxed and the emptied box removed.
  const pkg = await queryGet<{ shipping_box_id: string | null }>(
    client.db,
    sql`SELECT shipping_box_id FROM picking_packages WHERE id = ${pkgId}`
  );
  assert.equal(pkg!.shipping_box_id, null);
  const box = await queryGet<{ c: number }>(client.db, sql`SELECT COUNT(*)::int AS c FROM shipping_boxes WHERE id = ${boxId}`);
  assert.equal(box!.c, 0);

  const rec = await cancelRecordOf("cancel_invoice", sourceId);
  assert.equal(rec!.outcome, "cancelled_with_putback");

  // Confirm gate (2026-11-09): the awaiting task is not work yet — the PDA
  // queue (status='pending') hides it until the admin confirms the cancel.
  assert.equal((await listPutBackTasks(client.db, "pending", undefined)).length, 0);
  const actorId = await anyUserId();
  const released = await confirmCancelPutBack(client.db, { recordId: rec!.id, actorId });
  assert.equal(released.tasksReleased, 1);
  const afterConfirm = await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM put_back_tasks WHERE id = ${task.id}`
  );
  assert.equal(afterConfirm!.status, "pending");
  assert.equal((await listPutBackTasks(client.db, "pending", undefined)).length, 1);
  // Second confirm → nothing awaiting.
  await assert.rejects(
    () => confirmCancelPutBack(client.db, { recordId: rec!.id, actorId }),
    /no_awaiting_putback_tasks/
  );
});

test("admin records the replacement invoice on a cancel record", async () => {
  await insertOpenOrderWithLines("REPL-TEST-01", [888001]);
  const sourceId = await insertInvoiceCancel("REPL-TEST-01");
  await runCancelInvoiceSyncOnce(client.db);
  const rec = await cancelRecordOf("cancel_invoice", sourceId);

  const actorId = await anyUserId();
  await setCancelReplacement(client.db, { recordId: rec!.id, replacementOrderNo: "REPL-NEW-01", actorId });
  let listed = (await listCancelRecords(client.db)) as Array<Record<string, unknown>>;
  let row = listed.find((r) => r.id === rec!.id)!;
  assert.equal(row.replacementOrderNo, "REPL-NEW-01");
  assert.equal(row.replacementOrderId, null); // the replacement order is not synced in yet

  // Once the replacement exists, the list resolves it for the admin link.
  await client.db.execute(
    sql`INSERT INTO picking_orders (id, order_no, status, created_date, last_update_date)
        VALUES (${randomUUID()}, 'REPL-NEW-01', 'pending', now(), now())`
  );
  listed = (await listCancelRecords(client.db)) as Array<Record<string, unknown>>;
  row = listed.find((r) => r.id === rec!.id)!;
  assert.notEqual(row.replacementOrderId, null);

  // Clearing works too.
  await setCancelReplacement(client.db, { recordId: rec!.id, replacementOrderNo: "  ", actorId });
  listed = (await listCancelRecords(client.db)) as Array<Record<string, unknown>>;
  row = listed.find((r) => r.id === rec!.id)!;
  assert.equal(row.replacementOrderNo, null);
});

test("cancel_invoice_tn: cancels only the matching line (line_id); order closes when the last line cancels", async () => {
  const { orderId, itemIds } = await insertOpenOrderWithLines("TN-TEST-01", [777001, 777002]);

  const s1 = await insertTnCancel("TN-TEST-01", 777001);
  await runCancelInvoiceSyncOnce(client.db);

  let statuses = await queryAll<{ line_id: number; status: string }>(
    client.db,
    sql`SELECT line_id::int AS line_id, status FROM picking_items WHERE picking_order_id = ${orderId}`
  );
  assert.equal(statuses.find((s) => s.line_id === 777001)!.status, "cancelled");
  assert.equal(statuses.find((s) => s.line_id === 777002)!.status, "pending");
  let order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "pending"); // one line still open
  let rec = await cancelRecordOf("cancel_invoice_tn", s1);
  assert.equal(rec!.outcome, "cancelled");
  assert.equal(rec!.picking_item_id, itemIds[777001]);

  const s2 = await insertTnCancel("TN-TEST-01", 777002);
  await runCancelInvoiceSyncOnce(client.db);
  order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "cancelled");
  // The first row was not re-fetched (unchanged timestamp, done record): outcome intact.
  rec = await cancelRecordOf("cancel_invoice_tn", s1);
  assert.equal(rec!.outcome, "cancelled");
  const task = await queryGet<{ picking_item_id: string }>(
    client.db,
    sql`SELECT picking_item_id FROM put_back_tasks WHERE cancel_source_id = ${s2}`
  );
  assert.equal(task, undefined); // nothing picked → no task
});

test("shipped order → ignored, nothing changes", async () => {
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  await client.db.execute(sql`UPDATE picking_orders SET status = 'shipped' WHERE id = ${orderId}`);
  const before = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderId} AND a.qty > 0`
  );

  const sourceId = await insertInvoiceCancel("SO-DEMO-0001");
  await runCancelInvoiceSyncOnce(client.db);

  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "shipped");
  const left = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderId} AND a.qty > 0`
  );
  assert.equal(left!.c, before!.c);
  const rec = await cancelRecordOf("cancel_invoice", sourceId);
  assert.equal(rec!.outcome, "ignored");
  assert.match(rec!.message ?? "", /already shipped/);
  // The matched order is recorded even when nothing is applied (admin link).
  assert.equal(rec!.picking_order_id, orderId);
});

test("unknown pi_invoice_num → no_match, no order cancelled, hidden from the admin list", async () => {
  const sourceId = await insertInvoiceCancel("NOPE-9999");
  await runCancelInvoiceSyncOnce(client.db);
  const rec = await cancelRecordOf("cancel_invoice", sourceId);
  assert.equal(rec!.outcome, "no_match");
  assert.equal(rec!.picking_order_id, null);
  const cancelled = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM picking_orders WHERE status = 'cancelled'`
  );
  assert.equal(cancelled!.c, 0);
  // no_match rows are cron audit only — the admin list never shows them.
  const listed = await listCancelRecords(client.db);
  assert.equal(listed.length, 0);
});

test("µs-precision upstream stamp is not treated as an update on every pass", async () => {
  // Upstream timestamps carry microseconds but cancel_records.source_ts is
  // written from a JS Date (milliseconds) — a raw comparison made every row
  // look updated forever, re-applying (and overwriting the outcome with
  // `ignored`) on each cron pass.
  await allocateAll(client.db);
  const sourceId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO cancel_invoice (id, state, batch_no, pi_deliver_id, pi_invoice_num, organization_id, created_date, last_update_date)
        VALUES (${sourceId}, 'completed', 'test', 1, 'SO-DEMO-0001', 160,
                '2026-11-09 03:09:37.963468', '2026-11-09 03:09:37.963468')`
  );
  await runCancelInvoiceSyncOnce(client.db);
  assert.equal((await cancelRecordOf("cancel_invoice", sourceId))!.outcome, "cancelled");

  await runCancelInvoiceSyncOnce(client.db);
  assert.equal((await cancelRecordOf("cancel_invoice", sourceId))!.outcome, "cancelled");
});

test("upstream row updated (last_update_date moved) → reprocessed; already-cancelled order → ignored", async () => {
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const sourceId = await insertInvoiceCancel("SO-DEMO-0001");
  await runCancelInvoiceSyncOnce(client.db);
  assert.equal((await cancelRecordOf("cancel_invoice", sourceId))!.outcome, "cancelled");

  const ts = new Date(Date.now() + 3_600_000);
  await client.db.execute(sql`UPDATE cancel_invoice SET last_update_date = ${ts}`);
  await runCancelInvoiceSyncOnce(client.db);

  const rec = await cancelRecordOf("cancel_invoice", sourceId);
  assert.equal(rec!.outcome, "ignored");
  assert.match(rec!.message ?? "", /already cancelled/);
  const n = await queryGet<{ c: number }>(client.db, sql`SELECT COUNT(*)::int AS c FROM cancel_records`);
  assert.equal(n!.c, 1);
  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "cancelled");
});

test("cancelled TN line is never re-allocated (allocateAll after a line cancel)", async () => {
  const pair = await queryGet<{ orgId: number; sub: string }>(
    client.db,
    sql`SELECT org_id AS "orgId", sub_inventory_code AS "sub" FROM picking_orders WHERE order_no = 'SO-DEMO-0001' AND org_id IS NOT NULL LIMIT 1`
  );
  assert.ok(pair, "seed world should have an order with an org pair");
  const shelf = await queryGet<{ code: string }>(client.db, sql`SELECT code FROM shelves LIMIT 1`);
  assert.ok(shelf);

  const orderId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_orders (id, order_no, status, org_id, sub_inventory_code, created_date, last_update_date)
        VALUES (${orderId}, 'TN-REALLOC-01', 'pending', ${pair!.orgId}, ${pair!.sub}, now(), now())`
  );
  const itemIds: Record<number, string> = {};
  for (const lineId of [778001, 778002]) {
    const id = randomUUID();
    itemIds[lineId] = id;
    await client.db.execute(
      sql`INSERT INTO picking_items (id, picking_order_id, part_no, qty, line_id, line_number, status, created_date, last_update_date)
          VALUES (${id}, ${orderId}, 'ZZZ/REALLOC-PART', 100, ${lineId}, ${lineId}, 'pending', now(), now())`
    );
  }
  await client.db.execute(
    sql`INSERT INTO inventory_lots (id, part_no, shelf_code, org_id, sub_inventory_code, total_qty, allocated_qty, created_date, last_update_date)
        VALUES (${randomUUID()}, 'ZZZ/REALLOC-PART', ${shelf!.code}, ${pair!.orgId}, ${pair!.sub}, 500, 0, now(), now())`
  );

  await allocateAll(client.db);
  const both = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM allocations WHERE picking_item_id IN (${itemIds[778001]}, ${itemIds[778002]}) AND qty > 0`
  );
  assert.equal(both!.c, 2, "both lines allocated");

  await insertTnCancel("TN-REALLOC-01", 778001);
  await runCancelInvoiceSyncOnce(client.db);

  // The next fleet rebuild must NOT put stock back onto the cancelled line.
  await allocateAll(client.db);
  const dead = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM allocations WHERE picking_item_id = ${itemIds[778001]} AND qty > 0`
  );
  assert.equal(dead!.c, 0, "cancelled line must not be re-allocated");
  const alive = await queryGet<{ allocatedQty: number; status: string }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty", status FROM picking_items WHERE id = ${itemIds[778002]}`
  );
  assert.equal(alive!.allocatedQty, 100);
  const order = await queryGet<{ allocationStatus: string; status: string }>(
    client.db,
    sql`SELECT allocation_status AS "allocationStatus", status FROM picking_orders WHERE id = ${orderId}`
  );
  assert.equal(order!.allocationStatus, "allocated"); // coverage ignores the cancelled line
  assert.equal(order!.status, "pending");

  await client.db.execute(sql`DELETE FROM picking_orders WHERE id = ${orderId}`); // cascades items/lots? lots survive — truncate handles next test
});

test("missing upstream tables → tolerated (idle cron, no throw)", async () => {
  // Runs last in this file — drops and recreates the externally-managed tables.
  await client.db.execute(sql`DROP TABLE cancel_invoice`);
  await client.db.execute(sql`DROP TABLE cancel_invoice_tn`);
  await runCancelInvoiceSyncOnce(client.db); // must not throw
  await client.db.execute(sql`CREATE TABLE cancel_invoice (id varchar PRIMARY KEY, pi_invoice_num varchar, state varchar, batch_no varchar, pi_deliver_id bigint, status_code varchar, customer_id bigint, organization_id bigint, update_logs jsonb, created_date timestamp, updated_date timestamp, last_update_date timestamp)`);
  await client.db.execute(sql`CREATE TABLE cancel_invoice_tn (id varchar PRIMARY KEY, state varchar, batch_no varchar, tn_number varchar, org_id bigint, tn_status varchar, last_update_date timestamp, tn_line_id bigint, tn_line_num bigint, po_number varchar, update_logs jsonb, created_date timestamp, updated_date timestamp)`);
});
