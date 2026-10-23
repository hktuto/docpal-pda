// CN put-away (spec docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md):
// flow-config gating (404 unless cnReceiving, default false, exposed on
// GET /config), task list/detail, and completion — on-hand lot + PUT_AWAY
// ledger row per item, task/order completion, idempotency of full completion.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { completeCnPutAwayTx, getCnPutAwayTaskDetail, listCnPutAwayTasks } from "./putawayCn.js";
import { _setCnReceivingForTests, _setAllowedOrgIdsForTests, _resetFlowConfigForTests } from "../config.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../index.js"))["app"];

async function actorIdOf(username: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

/** Seed the finalized-CN-order world: in_hand order + invoice + item + task. */
async function seedCnPutAwayWorld(): Promise<{ orderId: string; itemId: string; taskId: string }> {
  const orderId = "cn-order-pa-1";
  const taskId = "cn-task-pa-1";
  await client.db.execute(
    sql`INSERT INTO receiving_orders_cn (id, batch_no, status, org_id) VALUES (${orderId}, 'TE20261010-9', 'in_hand', 2)`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoices_cn (id, receiving_order_id, invoice_no, total_qty, org_id) VALUES ('cn-inv-pa-1', ${orderId}, 'INV-CN-9', 100, 2)`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoice_items_cn (id, receiving_invoice_id, part_no, wcl_item_no, received_qty, date_code, org_id, sub_inventory_code)
        VALUES ('cn-item-pa-1', 'cn-inv-pa-1', 'RK73B1JTTD181G', 'WCL/181G', 100, '2641', 2, 'STORE1')`
  );
  await client.db.execute(
    sql`INSERT INTO put_away_tasks_cn (id, receiving_order_cn_id, org_id, sub_inventory_code, status)
        VALUES (${taskId}, ${orderId}, 2, 'STORE1', 'pending')`
  );
  return { orderId, itemId: "cn-item-pa-1", taskId };
}

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
});

after(() => {
  _setCnReceivingForTests(false);
});

async function operatorToken(): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "operator", password: "DocPal2026!" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

test("config: cnReceiving defaults to false and is exposed on GET /config", async () => {
  await reseed(client);
  const token = await operatorToken();
  const res = await app.request("/config", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { cnReceiving: boolean };
  assert.equal(body.cnReceiving, false);
});

test("routes: 404 while cnReceiving is off, live when on", async () => {
  await reseed(client);
  const token = await operatorToken();
  assert.equal(
    (await app.request("/put-away-cn/tasks", { headers: { Authorization: `Bearer ${token}` } })).status,
    404
  );
  _setCnReceivingForTests(true);
  const res = await app.request("/put-away-cn/tasks", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test("list: task row carries order + item counts", async () => {
  await reseed(client);
  await seedCnPutAwayWorld();
  const rows = await listCnPutAwayTasks(client.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].batchNo, "TE20261010-9");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].receivedItems, 1);
  assert.equal(rows[0].remainingItems, 1);
  assert.equal(rows[0].orgId, 2);
  assert.equal(rows[0].subInventoryCode, "STORE1");
});

test("list: no allowedOrgIds filter — a task in this warehouse lists even when its org is out of scope", async () => {
  await reseed(client);
  await seedCnPutAwayWorld();
  try {
    _setAllowedOrgIdsForTests([7, 14, 5, 12]); // org 2 deliberately excluded
    const rows = await listCnPutAwayTasks(client.db, "pending");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orgId, 2);
  } finally {
    _resetFlowConfigForTests();
  }
});

test("detail: items with remaining + lots; unknown id → 404", async () => {
  await reseed(client);
  const { taskId } = await seedCnPutAwayWorld();
  const detail = await getCnPutAwayTaskDetail(client.db, taskId);
  assert.equal(detail.order.batchNo, "TE20261010-9");
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].remainingQty, 100);
  assert.deepEqual(detail.lots, []);
  const err = await getCnPutAwayTaskDetail(client.db, "00000000-0000-4000-8000-000000000000").catch((e) => e);
  assert.equal(err.status, 404);
  assert.equal(err.message, "put_away_task_cn_not_found");
});

test("detail: admin suggestedShelf override (additional_data) wins over the computed suggestion", async () => {
  await reseed(client);
  const { taskId } = await seedCnPutAwayWorld();
  // Computed suggestion for this part (seed stock history) is "A0102"; the
  // admin-set override must replace it and drop the computed reason/box.
  await client.db.execute(
    sql`UPDATE receiving_invoice_items_cn
        SET additional_data = jsonb_build_object('suggestedShelf', 'A0999')
        WHERE id = 'cn-item-pa-1'`
  );
  const detail = await getCnPutAwayTaskDetail(client.db, taskId);
  assert.equal(detail.items[0].suggestedShelfCode, "A0999");
  assert.equal(detail.items[0].suggestionReason, null);
  assert.equal(detail.items[0].suggestedBoxId, null);
});

test("complete: partial put-away creates on-hand lot + ledger, task stays pending", async () => {
  await reseed(client);
  const { orderId, itemId, taskId } = await seedCnPutAwayWorld();
  const actorId = await actorIdOf("operator");
  const result = await client.db.transaction(async (tx) =>
    completeCnPutAwayTx(tx, { taskId, items: [{ itemId, qty: 60, shelfCode: "A0103" }], actorId })
  );
  assert.equal(result.taskCompleted, false);

  const lot = await queryGet<{
    partNo: string;
    shelfCode: string | null;
    orgId: number | null;
    subInventoryCode: string | null;
    totalQty: number;
    wclItemNo: string | null;
  }>(
    client.db,
    sql`SELECT part_no AS "partNo", shelf_code AS "shelfCode", org_id AS "orgId",
               sub_inventory_code AS "subInventoryCode", total_qty AS "totalQty", wcl_item_no AS "wclItemNo"
        FROM inventory_lots
        WHERE part_no = 'RK73B1JTTD181G' AND shelf_code = 'A0103'`
  );
  assert.ok(lot);
  assert.equal(lot!.totalQty, 60);
  assert.equal(lot!.orgId, 2); // pair from the CN item — allocation/stock-search see it
  assert.equal(lot!.subInventoryCode, "STORE1");
  // enclave → canonical at the lot boundary: the CN item's label code "2641"
  // is stored on the lot as canonical YYWW "4126" (spec
  // 2026-10-22-datecode-format-config-design.md)
  const lotDc = await queryGet<{ dateCode: string | null }>(
    client.db,
    sql`SELECT date_code AS "dateCode" FROM inventory_lots WHERE part_no = 'RK73B1JTTD181G' AND shelf_code = 'A0103'`
  );
  assert.equal(lotDc!.dateCode, "4126");

  const txns = await queryAll<{ txnType: string; qtyType: string; qtyDelta: number; referenceType: string | null; referenceId: string | null }>(
    client.db,
    sql`SELECT txn_type AS "txnType", qty_type AS "qtyType", qty_delta AS "qtyDelta",
               reference_type AS "referenceType", reference_id AS "referenceId"
        FROM inventory_transactions
        WHERE part_no = 'RK73B1JTTD181G' AND shelf_code = 'A0103'`
  );
  assert.equal(txns.length, 1);
  assert.equal(txns[0].txnType, "PUT_AWAY");
  assert.equal(txns[0].qtyType, "on_hand");
  assert.equal(txns[0].qtyDelta, 60);
  assert.equal(txns[0].referenceType, "receiving_order_cn");
  assert.equal(txns[0].referenceId, orderId);

  const task = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM put_away_tasks_cn WHERE id = ${taskId}`);
  assert.equal(task!.status, "pending");
  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_orders_cn WHERE id = ${orderId}`);
  assert.equal(order!.status, "in_hand");
});

test("complete: full put-away completes the task + clears the order; over-remaining and repeats rejected", async () => {
  await reseed(client);
  const { orderId, itemId, taskId } = await seedCnPutAwayWorld();
  const actorId = await actorIdOf("operator");
  await client.db.transaction(async (tx) =>
    completeCnPutAwayTx(tx, { taskId, items: [{ itemId, qty: 100, shelfCode: "A0103" }], actorId })
  );
  assert.equal((await queryGet<{ status: string }>(client.db, sql`SELECT status FROM put_away_tasks_cn WHERE id = ${taskId}`))!.status, "completed");
  assert.equal((await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_orders_cn WHERE id = ${orderId}`))!.status, "clear");

  // Second completion on the completed task → 409.
  const again = await client.db
    .transaction(async (tx) => completeCnPutAwayTx(tx, { taskId, items: [{ itemId, qty: 1, shelfCode: "A0103" }], actorId }))
    .catch((e) => e);
  assert.equal(again.status, 409);
  assert.equal(again.message, "put_away_task_cn_not_pending");
});

test("complete: qty over remaining → 409; unknown shelf → 404; wrong order's item → 404", async () => {
  await reseed(client);
  const { itemId, taskId } = await seedCnPutAwayWorld();
  const actorId = await actorIdOf("operator");

  const over = await client.db
    .transaction(async (tx) => completeCnPutAwayTx(tx, { taskId, items: [{ itemId, qty: 101, shelfCode: "A0103" }], actorId }))
    .catch((e) => e);
  assert.equal(over.status, 409);
  assert.equal(over.message, "scanned_qty_exceeds_remaining");

  const badShelf = await client.db
    .transaction(async (tx) => completeCnPutAwayTx(tx, { taskId, items: [{ itemId, qty: 1, shelfCode: "NOPE-99" }], actorId }))
    .catch((e) => e);
  assert.equal(badShelf.status, 404);
  assert.equal(badShelf.message, "shelf_not_found");

  // An item of another CN order does not belong to this task's order.
  await client.db.execute(
    sql`INSERT INTO receiving_orders_cn (id, batch_no, status, org_id) VALUES ('cn-order-other', 'TE-OTHER', 'in_hand', 2)`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoices_cn (id, receiving_order_id, invoice_no, org_id) VALUES ('cn-inv-other', 'cn-order-other', 'INV-OTHER', 2)`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoice_items_cn (id, receiving_invoice_id, part_no, received_qty, org_id, sub_inventory_code)
        VALUES ('cn-item-other', 'cn-inv-other', 'RK73H1JTTD4702F', 5, 2, 'STORE1')`
  );
  const wrongItem = await client.db
    .transaction(async (tx) =>
      completeCnPutAwayTx(tx, { taskId, items: [{ itemId: "cn-item-other", qty: 1, shelfCode: "A0103" }], actorId })
    )
    .catch((e) => e);
  assert.equal(wrongItem.status, 404);
});

test("route: POST complete commits and reports taskCompleted", async () => {
  await reseed(client);
  const { taskId } = await seedCnPutAwayWorld();
  const token = await operatorToken();
  _setCnReceivingForTests(true);
  try {
    const res = await app.request(`/put-away-cn/tasks/${taskId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ itemId: "cn-item-pa-1", qty: 100, shelfCode: "A0103" }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { taskCompleted: boolean };
    assert.equal(body.taskCompleted, true);
    const task = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM put_away_tasks_cn WHERE id = ${taskId}`);
    assert.equal(task!.status, "completed");
  } finally {
    _setCnReceivingForTests(false);
  }
});
