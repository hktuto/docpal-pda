// Route-level tests for PATCH /admin/receiving-orders/:id/status: admin
// override of a receiving order's status to any of
// pending/provisional_received/in_hand/clear — no transition guards, a status
// stamp only (arrived_at/arrived_by follow the status), audit transition log,
// receiving_order.upserted SSE event, and an awaited scoped allocation
// recompute on change (allocateForReceivingOrder — spec
// 2026-09-22-allocation-perfect-match-design.md). Same auth/fixture pattern
// as pickingStatusOverride.test.ts.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";
import { queryGet } from "../../db/query.js";
import { insertReceivingOrder } from "../../db/test-fixtures.js";
import { getAllocationRunStatus } from "../../db/allocate.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../../index.js"))["app"];
let token: string;

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
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "DocPalAdmin2026!" }),
  });
  token = (await res.json()).token as string;
});

beforeEach(async () => {
  await waitForAllocationIdle();
  await reseed(client);
});

function patchStatus(orderId: string, status: string, reason?: string) {
  return app.request(`/admin/receiving-orders/${orderId}/status`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status, ...(reason !== undefined ? { reason } : {}) }),
  });
}

async function getOrder(id: string) {
  return (
    await queryGet<{
      status: string;
      arrivedAt: Date | null;
      arrivedBy: string | null;
    }>(
      client.db,
      sql`SELECT status, arrived_at AS "arrivedAt", arrived_by AS "arrivedBy"
          FROM receiving_orders WHERE id = ${id}`
    )
  )!;
}

/** One pending receiving order with one invoice + item. Returns the order id. */
async function seedOrder(tag: string): Promise<string> {
  return insertReceivingOrder(client.db, "BATCH-SO-" + tag, {
    order: { supplierCode: null },
    invoices: [{ invoiceNo: "INV-SO-" + tag, items: [{ partNo: "PART-SO-" + tag, lineQty: 100 }] }],
  });
}

test("status override: 400 for an invalid status value", async () => {
  const orderId = await seedOrder("badstatus");
  const res = await patchStatus(orderId, "cancelled");
  assert.equal(res.status, 400);
  assert.match(await res.text(), /invalid_status/);
});

test("status override: 404 for an unknown receiving order", async () => {
  const res = await patchStatus(randomUUID(), "in_hand");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /receiving_order_not_found/);
});

test("status override: same-status call is a no-op without an audit row", async () => {
  const orderId = await seedOrder("noop");

  const res = await patchStatus(orderId, "pending");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changed, false);

  const log = await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM transaction_logs
        WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}`
  );
  assert.equal(log!.n, 0);
});

test("status override: pending → in_hand stamps arrival and writes the audit log", async () => {
  const orderId = await seedOrder("arrive");

  const res = await patchStatus(orderId, "in_hand", "arrived while system down");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    { status: body.status, previousStatus: body.previousStatus, changed: body.changed },
    { status: "in_hand", previousStatus: "pending", changed: true }
  );

  const order = await getOrder(orderId);
  assert.equal(order.status, "in_hand");
  assert.ok(order.arrivedAt, "arrived_at stamped");
  const adminId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'admin'`)
  )!.id;
  assert.equal(order.arrivedBy, adminId);

  const log = await queryGet<{ fromState: string | null; toState: string; override: unknown }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", metadata->>'override' AS "override"
        FROM transaction_logs
        WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}
        ORDER BY created_date DESC LIMIT 1`
  );
  assert.equal(log!.fromState, "pending");
  assert.equal(log!.toState, "in_hand");
  assert.equal(log!.override, "true");
});

test("status override: in_hand → pending clears the arrival stamps", async () => {
  const orderId = await seedOrder("revert");
  assert.equal((await patchStatus(orderId, "in_hand")).status, 200);

  const res = await patchStatus(orderId, "pending");
  assert.equal(res.status, 200);
  const order = await getOrder(orderId);
  assert.equal(order.status, "pending");
  assert.equal(order.arrivedAt, null);
  assert.equal(order.arrivedBy, null);
});

test("status override: in_hand → clear preserves the arrival stamps", async () => {
  const orderId = await seedOrder("clear");
  assert.equal((await patchStatus(orderId, "in_hand")).status, 200);
  const before = await getOrder(orderId);

  const res = await patchStatus(orderId, "clear");
  assert.equal(res.status, 200);
  const order = await getOrder(orderId);
  assert.equal(order.status, "clear");
  assert.ok(order.arrivedAt, "arrived_at preserved");
  assert.equal(order.arrivedBy, before.arrivedBy);
});
