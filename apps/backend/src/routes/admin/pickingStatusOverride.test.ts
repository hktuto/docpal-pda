// Route-level tests for PATCH /admin/picking-orders/:id/status (spec
// 2026-09-17-admin-picking-status-override-design.md): admin override of a
// picking order's status to any of pending/picking/issue/finished/shipped —
// no transition guards, work lock force-cleared, leaving open releases the
// order's allocations with RESERVE-release ledger rows, audit transition log,
// picking_order.updated SSE event, and a background recompute scheduled on
// change. Same auth/fixture pattern as pickingList.test.ts.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";
import { queryAll, queryGet } from "../../db/query.js";
import { insertPickingOrder } from "../../db/test-fixtures.js";
import { allocateAll, getAllocationRunStatus } from "../../db/allocate.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../../index.js"))["app"];
let token: string;
let operatorToken: string;

// A status change schedules the background allocateAll; its row locks can
// deadlock the next reseed's TRUNCATE, so wait for the runner to settle first.
async function waitForAllocationIdle(): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const s = getAllocationRunStatus();
    if (!s.running && !s.queued) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("allocation runner did not settle");
}

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../../index.js"));
  const login = async (username: string, password: string) => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    return (await res.json()).token as string;
  };
  token = await login("admin", "DocPalAdmin2026!");
  operatorToken = await login("operator", "DocPal2026!");
});

beforeEach(async () => {
  await waitForAllocationIdle();
  await reseed(client);
});

function req(path: string, init?: RequestInit, useOperator = false) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${useOperator ? operatorToken : token}`, ...init?.headers },
  });
}

function patchStatus(orderId: string, status: string, reason?: string) {
  return req(`/admin/picking-orders/${orderId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, ...(reason !== undefined ? { reason } : {}) }),
  });
}

async function getOrder(id: string) {
  return (
    await queryGet<{
      status: string;
      workingBy: string | null;
      shippedAt: Date | null;
      shippedBy: string | null;
    }>(
      client.db,
      sql`SELECT status, working_by AS "workingBy", shipped_at AS "shippedAt", shipped_by AS "shippedBy"
          FROM picking_orders WHERE id = ${id}`
    )
  )!;
}

/** One pending order with one item, backed by one shelf lot so allocateAll
 *  reserves stock for it. Returns the order id. */
async function seedAllocatedOrder(tag: string): Promise<string> {
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, shelf_code, box_id, date_code, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES (${"LOT-SO-" + tag}, ${"PART-" + tag}, 'A-01-01', ${"BOX-" + tag}, '2601', 2, 'STORE1', 200, now(), now())
  `);
  const orderId = randomUUID();
  await insertPickingOrder(client.db, orderId, {
    order: { orderNo: "SO-SO-" + tag, customerCode: "ACME", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "PART-" + tag, qty: 100 }],
  });
  await allocateAll(client.db);
  return orderId;
}

test("status override: 404 for an unknown picking order", async () => {
  const res = await patchStatus(randomUUID(), "finished");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /picking_order_not_found/);
});

test("status override: 400 for an invalid status value", async () => {
  const orderId = await seedAllocatedOrder("badstatus");
  const res = await patchStatus(orderId, "cancelled");
  assert.equal(res.status, 400);
  assert.match(await res.text(), /invalid_status/);
});

test("status override: pending → finished releases allocations with ledger rows", async () => {
  const orderId = await seedAllocatedOrder("close");

  const before = await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderId} AND a.qty > 0`
  );
  assert.ok((before?.n ?? 0) > 0, "seeded order has an allocation");

  const res = await patchStatus(orderId, "finished", "all picked on paper");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    { status: body.status, previousStatus: body.previousStatus, changed: body.changed },
    { status: "finished", previousStatus: "pending", changed: true }
  );

  const order = await getOrder(orderId);
  assert.equal(order.status, "finished");
  assert.equal(order.workingBy, null);

  // Allocations wiped, picking item allocated_qty zeroed, lot freed.
  const after = await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderId}`
  );
  assert.equal(after!.n, 0);
  const item = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM picking_items WHERE picking_order_id = ${orderId}`
  );
  assert.equal(item!.allocatedQty, 0);
  const lot = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = 'LOT-SO-close'`
  );
  assert.equal(lot!.allocatedQty, 0);

  // RESERVE-release ledger rows + the admin override audit transition.
  const txns = await queryAll<{ qtyDelta: number; txnReason: string }>(
    client.db,
    sql`SELECT qty_delta AS "qtyDelta", txn_reason AS "txnReason" FROM inventory_transactions
        WHERE txn_reason = 'status override: release'`
  );
  assert.ok(txns.length > 0, "release ledger rows written");
  assert.ok(txns.every((t) => t.qtyDelta < 0), "release rows are negative deltas");

  const log = await queryGet<{ fromState: string | null; toState: string; override: unknown }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", metadata->>'override' AS "override"
        FROM transaction_logs
        WHERE entity_type = 'picking_order' AND entity_id = ${orderId}
        ORDER BY created_date DESC LIMIT 1`
  );
  assert.equal(log!.fromState, "pending");
  assert.equal(log!.toState, "finished");
  assert.equal(log!.override, "true");
});

test("status override: shipped stamps set on entry and cleared on exit", async () => {
  const orderId = await seedAllocatedOrder("ship");

  const toShipped = await patchStatus(orderId, "shipped");
  assert.equal(toShipped.status, 200);
  let order = await getOrder(orderId);
  assert.equal(order.status, "shipped");
  assert.ok(order.shippedAt, "shipped_at stamped");
  const adminId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'admin'`)
  )!.id;
  assert.equal(order.shippedBy, adminId);

  const toPending = await patchStatus(orderId, "pending");
  assert.equal(toPending.status, 200);
  order = await getOrder(orderId);
  assert.equal(order.status, "pending");
  assert.equal(order.shippedAt, null);
  assert.equal(order.shippedBy, null);
});

test("status override: force-clears a live PDA work lock", async () => {
  const orderId = await seedAllocatedOrder("lock");

  const lock = await req(`/picking-orders/${orderId}/work-lock`, { method: "POST" }, true);
  assert.equal(lock.status, 200);
  assert.ok((await getOrder(orderId)).workingBy, "operator holds the lock");

  const res = await patchStatus(orderId, "finished");
  assert.equal(res.status, 200);
  assert.equal((await getOrder(orderId)).workingBy, null);
});

test("status override: same-status call is a no-op without an audit row", async () => {
  const orderId = await seedAllocatedOrder("noop");

  const res = await patchStatus(orderId, "pending");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changed, false);

  const log = await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM transaction_logs
        WHERE entity_type = 'picking_order' AND entity_id = ${orderId}`
  );
  assert.equal(log!.n, 0);
});

test("status override: sequential calls cover the batch (client-side loop) shape", async () => {
  const first = await seedAllocatedOrder("batch1");
  const second = await seedAllocatedOrder("batch2");

  for (const orderId of [first, second]) {
    const res = await patchStatus(orderId, "finished");
    assert.equal(res.status, 200);
  }
  assert.equal((await getOrder(first)).status, "finished");
  assert.equal((await getOrder(second)).status, "finished");
});
