import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { confirmReceivingArrival } from "./receiving.js";
import { upsertReceivingOrder } from "./ingest.js";
import { addAllUnboxedToBox, createShelfBox, recordPutAwayScan } from "./putaway.js";
import { createPutAwayTaskTx, getPutAwayTaskDetail, listPutAwayTasks } from "./putawaytasks.js";
import { _setPutAwayConfigForTests } from "../config.js";

// Put-away tasks (spec 2026-08-10-put-away-tasks-design.md).

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

after(() => {
  _setPutAwayConfigForTests({ autoCreateTasks: false, suggestShelf: "existing-stock" });
});

// --- helpers (business-key lookups, never hardcoded seed UUIDs) ---------------

async function actorIdOf(username: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

async function orderIdOf(batchNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = ${batchNo}`);
  return row!.id;
}

async function itemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId} AND rii.part_no = ${partNo}`
  );
  return row!.id;
}

async function taskOf(orderId: string): Promise<{ id: string; status: string } | undefined> {
  return queryGet<{ id: string; status: string }>(
    client.db,
    sql`SELECT id, status FROM put_away_tasks WHERE receiving_order_id = ${orderId}`
  );
}

async function daitoInHand(): Promise<{ orderId: string; actorId: string }> {
  const actorId = await actorIdOf("operator");
  await upsertReceivingOrder(client.db, "04958210", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-07-29", dateCode: "2610", subInventoryCode: "STORE1" },
    invoices: [
      {
        invoiceNo: "INV-04958210-01",
        wclCompanyName: "WCL Components Ltd",
        totalQty: 8000,
        totalCtn: 2,
        items: [
          { partNo: "RK73B1JTTD181G", poNo: "PO-DAI-301", poLine: "1", lineQty: 5000, dateCode: "2610", coo: "JP", cow: "JP" },
          { partNo: "RK73H1JTTD4702F", poNo: "PO-DAI-301", poLine: "2", lineQty: 3000, dateCode: "2610", coo: "JP", cow: "JP" },
        ],
      },
    ],
  });
  const orderId = await orderIdOf("04958210");
  await confirmReceivingArrival(client.db, orderId, actorId);
  return { orderId, actorId };
}

// --- creation -----------------------------------------------------------------

test("autoCreateTasks on: confirm arrival creates a pending task in the same tx", async () => {
  await reseed(client);
  _setPutAwayConfigForTests({ autoCreateTasks: true });
  try {
    const { orderId } = await daitoInHand();
    const task = await taskOf(orderId);
    assert.ok(task);
    assert.equal(task!.status, "pending");

    const logs = await queryAll<{ toState: string }>(
      client.db,
      sql`SELECT to_state AS "toState" FROM transaction_logs
          WHERE entity_type = 'put_away_task' AND entity_id = ${task!.id}`
    );
    assert.deepEqual(logs.map((l) => l.toState), ["pending"]);
  } finally {
    _setPutAwayConfigForTests({ autoCreateTasks: false });
  }
});

test("autoCreateTasks off (default): confirm arrival creates no task", async () => {
  await reseed(client);
  const { orderId } = await daitoInHand();
  assert.equal(await taskOf(orderId), undefined);
});

test("createPutAwayTaskTx is idempotent (receiving_order_id unique index)", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHand();
  await client.db.transaction(async (tx) => {
    await createPutAwayTaskTx(tx, { receivingOrderId: orderId, actorId });
    await createPutAwayTaskTx(tx, { receivingOrderId: orderId, actorId });
  });
  const rows = await queryAll<{ id: string }>(
    client.db,
    sql`SELECT id FROM put_away_tasks WHERE receiving_order_id = ${orderId}`
  );
  assert.equal(rows.length, 1);
});

// --- list ---------------------------------------------------------------------

test("list: queue rows carry order + item counts, oldest first, status filter", async () => {
  await reseed(client);
  _setPutAwayConfigForTests({ autoCreateTasks: true });
  try {
    const { orderId } = await daitoInHand();
    const rows = await listPutAwayTasks(client.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].receivingOrderId, orderId);
    assert.equal(rows[0].batchNo, "04958210");
    assert.equal(rows[0].supplierCode, "DAITO");
    assert.equal(rows[0].receivedItems, 2);
    assert.equal(rows[0].unboxedItems, 2);
    assert.equal((await listPutAwayTasks(client.db, "completed")).length, 0);
    assert.equal((await listPutAwayTasks(client.db, "pending")).length, 1);
  } finally {
    _setPutAwayConfigForTests({ autoCreateTasks: false });
  }
});

// --- completion ---------------------------------------------------------------

test("full put-away clears the order and completes the task", async () => {
  await reseed(client);
  _setPutAwayConfigForTests({ autoCreateTasks: true });
  try {
    const { orderId, actorId } = await daitoInHand();
    await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: await itemIdOf(orderId, "RK73B1JTTD181G"), qty: 5000 });
    await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: await itemIdOf(orderId, "RK73H1JTTD4702F"), qty: 3000 });
    const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
    await addAllUnboxedToBox(client.db, { shelfBoxId: box.id, actorId });

    const task = await taskOf(orderId);
    assert.equal(task!.status, "completed");
    const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_orders WHERE id = ${orderId}`);
    assert.equal(order!.status, "clear");
    assert.equal((await listPutAwayTasks(client.db, "pending")).length, 0);
  } finally {
    _setPutAwayConfigForTests({ autoCreateTasks: false });
  }
});

test("partial put-away: task stays pending, unboxedItems decreases", async () => {
  await reseed(client);
  _setPutAwayConfigForTests({ autoCreateTasks: true });
  try {
    const { orderId, actorId } = await daitoInHand();
    await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: await itemIdOf(orderId, "RK73B1JTTD181G"), qty: 5000 });
    const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
    await addAllUnboxedToBox(client.db, { shelfBoxId: box.id, actorId });

    const task = await taskOf(orderId);
    assert.equal(task!.status, "pending");
    const rows = await listPutAwayTasks(client.db, "pending");
    assert.equal(rows[0].unboxedItems, 1);
  } finally {
    _setPutAwayConfigForTests({ autoCreateTasks: false });
  }
});

// --- detail + shelf suggestion ------------------------------------------------

test("detail: aggregate + suggestedShelfCode from existing stock", async () => {
  await reseed(client);
  _setPutAwayConfigForTests({ autoCreateTasks: true });
  try {
    const { orderId, actorId } = await daitoInHand();
    // put away only the 181G line → its fresh lot at A-01-03 wins over the
    // seed's older A-01-02 lot (both parts have seed history at A-01-02)
    await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: await itemIdOf(orderId, "RK73B1JTTD181G"), qty: 5000 });
    const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
    await addAllUnboxedToBox(client.db, { shelfBoxId: box.id, actorId });

    const task = await taskOf(orderId);
    const detail = await getPutAwayTaskDetail(client.db, task!.id);
    assert.equal(detail.task.receivingOrderId, orderId);
    assert.equal(detail.task.status, "pending");
    const byPart = new Map(detail.items.map((it) => [it.partNo, it.suggestedShelfCode]));
    assert.equal(byPart.get("RK73B1JTTD181G"), "A-01-03"); // most recent stocking wins
    assert.equal(byPart.get("RK73H1JTTD4702F"), "A-01-02"); // seed history
  } finally {
    _setPutAwayConfigForTests({ autoCreateTasks: false });
  }
});

test("detail: suggestShelf=off suppresses the hint", async () => {
  await reseed(client);
  _setPutAwayConfigForTests({ autoCreateTasks: true, suggestShelf: "off" });
  try {
    const { orderId, actorId } = await daitoInHand();
    await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: await itemIdOf(orderId, "RK73B1JTTD181G"), qty: 5000 });
    const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
    await addAllUnboxedToBox(client.db, { shelfBoxId: box.id, actorId });

    const task = await taskOf(orderId);
    const detail = await getPutAwayTaskDetail(client.db, task!.id);
    for (const it of detail.items) assert.equal(it.suggestedShelfCode, null);
  } finally {
    _setPutAwayConfigForTests({ autoCreateTasks: false, suggestShelf: "existing-stock" });
  }
});

test("detail: unknown task id → 404", async () => {
  await reseed(client);
  const err = await getPutAwayTaskDetail(client.db, "00000000-0000-4000-8000-000000000000").catch((e) => e);
  assert.equal(err.status, 404);
  assert.equal(err.message, "put_away_task_not_found");
});
