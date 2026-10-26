import { before, test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { captureAllocationSnapshot, restoreLatestAllocationSnapshot } from "./allocationSnapshot.js";
import { reseed, setupTestDb, type TestDb } from "./test-helper.js";

let client: TestDb;
let orderId: string;
let actorId: string;

const itemIds = {
  lot: "snap-item-lot",
  line: "snap-item-line",
  order: "snap-item-order",
};
const allocationIds = {
  lot: "snap-allocation-lot",
  line: "snap-allocation-line",
  order: "snap-allocation-order",
};
const lotId = "snap-lot";
const receivingOrderId = "snap-receiving-order";
const invoiceId = "snap-invoice";
const lineItemId = "snap-receiving-line";
const orderItemId = "snap-receiving-order-line";

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  const rows = await client.db.execute(query);
  return Number((rows[0] as any).value);
}

async function insertReceiving(order: string, invoice: string, line: string, orderLine: string): Promise<void> {
  await client.db.execute(sql`
    INSERT INTO receiving_orders (id, batch_no, org_id, status, created_date, last_update_date)
    VALUES (${order}, 'SNAP-BATCH', 2, 'in_hand', now(), now())`);
  await client.db.execute(sql`
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, org_id, created_date, last_update_date)
    VALUES (${invoice}, ${order}, 'SNAP-INVOICE', 2, now(), now())`);
  await client.db.execute(sql`
    INSERT INTO receiving_invoice_items
      (id, receiving_invoice_id, part_no, po_no, po_line, received_qty, ctn_no, org_id, sub_inventory_code, created_date, last_update_date)
    VALUES
      (${line}, ${invoice}, 'SNAP-PART-LINE', 'PO-1', '10', 100, 'SNAP-CTN', 2, 'STORE1', now(), now()),
      (${orderLine}, ${invoice}, 'SNAP-PART-ORDER', 'PO-1', '20', 100, NULL, 2, 'STORE1', now(), now())`);
}

async function insertLot(id: string): Promise<void> {
  await client.db.execute(sql`
    INSERT INTO inventory_lots
      (id, part_no, date_code, lot_code, coo, cow, box_id, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES (${id}, 'SNAP-PART-LOT', '2601', 'LOT-1', 'CN', 'TW', 'SNAP-LOT-BOX', 2, 'STORE1', 100, now(), now())`);
}

async function makeWorld(): Promise<void> {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM allocations`);
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${orderId}`);
  await client.db.execute(sql`DELETE FROM picking_items WHERE picking_order_id = ${orderId}`);
  await client.db.execute(sql`
    UPDATE picking_orders
    SET status = 'pending', allocation_status = 'unallocated', working_by = NULL, working_at = NULL
    WHERE id = ${orderId}`);
  await client.db.execute(sql`
    INSERT INTO picking_items (id, picking_order_id, part_no, qty, line_id, line_number, created_date, last_update_date)
    VALUES
      (${itemIds.lot}, ${orderId}, 'SNAP-PART-LOT', 10, 101, 1, now(), now()),
      (${itemIds.line}, ${orderId}, 'SNAP-PART-LINE', 10, 102, 2, now(), now()),
      (${itemIds.order}, ${orderId}, 'SNAP-PART-ORDER', 10, 103, 3, now(), now())`);
  await insertLot(lotId);
  await insertReceiving(receivingOrderId, invoiceId, lineItemId, orderItemId);
  await client.db.execute(sql`
    INSERT INTO allocations (id, picking_item_id, inventory_lot_id, receiving_invoice_item_id, receiving_order_id, qty, manual)
    VALUES
      (${allocationIds.lot}, ${itemIds.lot}, ${lotId}, NULL, NULL, 10, false),
      (${allocationIds.line}, ${itemIds.line}, NULL, ${lineItemId}, NULL, 10, true),
      (${allocationIds.order}, ${itemIds.order}, NULL, NULL, ${receivingOrderId}, 10, false)`);
}

async function captureLotOnly(): Promise<void> {
  await client.db.execute(sql`DELETE FROM allocations WHERE id <> ${allocationIds.lot}`);
  await captureAllocationSnapshot(client.db, actorId, new Date(2026, 9, 26, 17, 45));
}

before(async () => {
  client = await setupTestDb();
  orderId = (await client.db.execute(sql`SELECT id FROM picking_orders WHERE order_no = 'SO-DEMO-0001'`))[0].id as string;
  actorId = (await client.db.execute(sql`SELECT id FROM users WHERE username = 'admin'`))[0].id as string;
});

test("daily capture replaces the day and restores all source types by business keys with original allocation UUIDs", async () => {
  await makeWorld();
  const at = new Date(2026, 9, 26, 17, 45);
  const first = await captureAllocationSnapshot(client.db, actorId, at);
  const second = await captureAllocationSnapshot(client.db, actorId, new Date(2026, 9, 26, 17, 50));
  assert.notEqual(first.batchId, second.batchId);
  assert.equal(second.allocations, 3);
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM allocation_snapshot_batches`), 1);
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM allocation_snapshot_rows WHERE batch_id = ${second.batchId}`), 3);
  assert.equal(await scalar(sql`SELECT receiving_invoice_item_id = ${lineItemId} AS value FROM allocation_snapshot_rows WHERE batch_id = ${second.batchId} AND allocation_id = ${allocationIds.line}`), 1);

  await client.db.execute(sql`DELETE FROM allocations`);
  await client.db.execute(sql`DELETE FROM receiving_orders WHERE id = ${receivingOrderId}`);
  await client.db.execute(sql`DELETE FROM inventory_lots WHERE id = ${lotId}`);
  await insertLot("snap-lot-reseeded");
  await insertReceiving("snap-receiving-order-reseeded", "snap-invoice-reseeded", "snap-line-reseeded", "snap-order-line-reseeded");
  await client.db.execute(sql`
    UPDATE picking_items SET id = CASE id
      WHEN ${itemIds.lot} THEN 'snap-item-lot-reseeded'
      WHEN ${itemIds.line} THEN 'snap-item-line-reseeded'
      WHEN ${itemIds.order} THEN 'snap-item-order-reseeded'
    END`);

  const restored = await restoreLatestAllocationSnapshot(client.db, actorId);
  assert.equal(restored.batchId, second.batchId);
  assert.deepEqual(
    { total: restored.total, restored: restored.restored, existing: restored.existing, skipped: restored.skipped },
    { total: 3, restored: 3, existing: 0, skipped: 0 }
  );
  const rows = await client.db.execute(sql`
    SELECT id, picking_item_id AS item, inventory_lot_id AS lot,
           receiving_invoice_item_id AS line, receiving_order_id AS receiving_order, manual
    FROM allocations ORDER BY id`);
  assert.deepEqual(
    rows.map((row: any) => [row.id, row.item, row.lot, row.line, row.receiving_order, row.manual]),
    [
      [allocationIds.line, "snap-item-line-reseeded", null, "snap-line-reseeded", null, true],
      [allocationIds.lot, "snap-item-lot-reseeded", "snap-lot-reseeded", null, null, false],
      [allocationIds.order, "snap-item-order-reseeded", null, null, "snap-receiving-order-reseeded", false],
    ]
  );
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM inventory_transactions WHERE txn_reason = 'snapshot restore: reserve'`), 3);
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM transaction_logs WHERE metadata->>'action' = 'allocation_snapshot_restore'`), 1);
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM app_events WHERE type = 'allocation.finished' AND data->>'scope' = 'snapshot-restore'`), 1);
  const persisted = await client.db.execute(sql`
    SELECT restored_at IS NOT NULL AS restored, report->>'restored' AS count, report->'rows' AS rows
    FROM allocation_snapshot_batches WHERE id = ${second.batchId}`);
  assert.equal((persisted[0] as any).restored, true);
  assert.equal(Number((persisted[0] as any).count), 3);
  assert.equal((persisted[0] as any).rows.length, 3);

  await client.db.execute(sql`UPDATE inventory_lots SET allocated_qty = 77 WHERE id = 'snap-lot-reseeded'`);
  await client.db.execute(sql`UPDATE picking_items SET allocated_qty = 88 WHERE id = 'snap-item-lot-reseeded'`);
  const retry = await restoreLatestAllocationSnapshot(client.db, actorId);
  assert.equal(retry.existing, 3);
  assert.equal(retry.restored, 0);
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM inventory_transactions WHERE txn_reason = 'snapshot restore: reserve'`), 3);
  assert.equal(await scalar(sql`SELECT allocated_qty AS value FROM inventory_lots WHERE id = 'snap-lot-reseeded'`), 10);
  assert.equal(await scalar(sql`SELECT allocated_qty AS value FROM picking_items WHERE id = 'snap-item-lot-reseeded'`), 10);
  assert.equal(await scalar(sql`SELECT allocation_status = 'allocated' AS value FROM picking_orders WHERE id = ${orderId}`), 1);
});

test("restore preserves new manual conflicts and persists the structured failure", async () => {
  await makeWorld();
  await captureLotOnly();
  await client.db.execute(sql`DELETE FROM allocations`);
  await client.db.execute(sql`
    INSERT INTO allocations (id, picking_item_id, inventory_lot_id, qty, manual)
    VALUES ('snap-new-manual', ${itemIds.lot}, ${lotId}, 10, true)`);

  const result = await restoreLatestAllocationSnapshot(client.db, actorId);
  assert.equal(result.restored, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.manualConflicts, 1);
  assert.equal(result.rows[0].reason, "manual_conflict");
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM allocations WHERE id = 'snap-new-manual' AND manual`), 1);
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM allocations WHERE id = ${allocationIds.lot}`), 0);
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM inventory_transactions WHERE txn_reason LIKE 'snapshot restore:%'`), 0);
  assert.equal(await scalar(sql`SELECT report->>'manualConflicts' = '1' AS value FROM allocation_snapshot_batches`), 1);
  assert.equal(await scalar(sql`SELECT allocated_qty AS value FROM inventory_lots WHERE id = ${lotId}`), 10);
});

test("restore releases conflicting automatic rows with ledger and restores the original UUID", async () => {
  await makeWorld();
  await captureLotOnly();
  await client.db.execute(sql`DELETE FROM allocations`);
  await client.db.execute(sql`
    INSERT INTO allocations (id, picking_item_id, inventory_lot_id, qty, manual)
    VALUES ('snap-new-automatic', ${itemIds.lot}, ${lotId}, 10, false)`);

  const result = await restoreLatestAllocationSnapshot(client.db, actorId);
  assert.equal(result.restored, 1);
  assert.equal(result.releasedRows, 1);
  assert.equal(result.releasedQty, 10);
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM allocations WHERE id = 'snap-new-automatic'`), 0);
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM allocations WHERE id = ${allocationIds.lot}`), 1);
  assert.equal(await scalar(sql`SELECT qty_delta AS value FROM inventory_transactions WHERE txn_reason = 'snapshot restore: release'`), -10);
  assert.equal(await scalar(sql`SELECT qty_delta AS value FROM inventory_transactions WHERE txn_reason = 'snapshot restore: reserve'`), 10);
  assert.equal(await scalar(sql`SELECT count(*) AS value FROM transaction_logs WHERE metadata->>'action' = 'allocation_snapshot_release'`), 1);
});

test("restore rejects closed or locked orders, excessive open quantity, and unavailable sources", async (t) => {
  const cases = [
    {
      name: "closed order",
      change: async () => client.db.execute(sql`UPDATE picking_orders SET status = 'shipped' WHERE id = ${orderId}`),
      reason: "order_not_open",
    },
    {
      name: "live work lock",
      change: async () => client.db.execute(sql`UPDATE picking_orders SET working_by = ${actorId}, working_at = now() WHERE id = ${orderId}`),
      reason: "lock_held",
    },
    {
      name: "open quantity",
      change: async () => client.db.execute(sql`UPDATE picking_items SET qty = 5 WHERE id = ${itemIds.lot}`),
      reason: "open_qty_exceeded",
    },
    {
      name: "source availability",
      change: async () => client.db.execute(sql`UPDATE inventory_lots SET total_qty = 5 WHERE id = ${lotId}`),
      reason: "insufficient_source_availability",
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      await makeWorld();
      await captureLotOnly();
      await client.db.execute(sql`DELETE FROM allocations`);
      await entry.change();
      const result = await restoreLatestAllocationSnapshot(client.db, actorId);
      assert.equal(result.skipped, 1);
      assert.equal(result.rows[0].reason, entry.reason);
      assert.equal(await scalar(sql`SELECT count(*) AS value FROM allocations`), 0);
    });
  }
});

test("restore globally resets stale counters when an allocation cannot be restored", async () => {
  await makeWorld();
  await captureLotOnly();
  await client.db.execute(sql`DELETE FROM allocations`);
  await client.db.execute(sql`UPDATE inventory_lots SET total_qty = 5, allocated_qty = 77 WHERE id = ${lotId}`);
  await client.db.execute(sql`UPDATE picking_items SET allocated_qty = 88 WHERE id = ${itemIds.lot}`);

  const result = await restoreLatestAllocationSnapshot(client.db, actorId);
  assert.equal(result.skipped, 1);
  assert.equal(result.rows[0].reason, "insufficient_source_availability");
  assert.equal(await scalar(sql`SELECT allocated_qty AS value FROM inventory_lots WHERE id = ${lotId}`), 0);
  assert.equal(await scalar(sql`SELECT allocated_qty AS value FROM picking_items WHERE id = ${itemIds.lot}`), 0);
  assert.equal(await scalar(sql`SELECT allocation_status = 'unallocated' AS value FROM picking_orders WHERE id = ${orderId}`), 1);
});

test("split rows from the same snapshot do not release each other", async () => {
  await makeWorld();
  await captureLotOnly();
  await client.db.execute(sql`UPDATE inventory_lots SET total_qty = 10 WHERE id = ${lotId}`);
  await client.db.execute(sql`UPDATE allocations SET qty = 5 WHERE id = ${allocationIds.lot}`);
  await client.db.execute(sql`
    INSERT INTO allocations (id, picking_item_id, inventory_lot_id, qty, manual)
    VALUES ('snap-allocation-lot-second', ${itemIds.lot}, ${lotId}, 5, false)`);
  await captureAllocationSnapshot(client.db, actorId, new Date(2026, 9, 26, 17, 45));
  await client.db.execute(sql`DELETE FROM allocations`);

  const result = await restoreLatestAllocationSnapshot(client.db, actorId);
  assert.equal(result.restored, 2);
  assert.equal(result.skipped, 0);
  assert.equal(await scalar(sql`SELECT sum(qty) AS value FROM allocations WHERE picking_item_id = ${itemIds.lot}`), 10);
  const retry = await restoreLatestAllocationSnapshot(client.db, actorId);
  assert.equal(retry.existing, 2);
  assert.equal(retry.restored, 0);
});

test("restore requires a snapshot", async () => {
  await reseed(client);
  await assert.rejects(restoreLatestAllocationSnapshot(client.db), /allocation_snapshot_not_found/);
});
