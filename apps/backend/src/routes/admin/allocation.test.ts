// Route-level tests for the admin manual allocation triggers (spec
// 2026-09-14-admin-allocation-buttons-design.md):
//   POST /admin/allocation/run                  — full-fleet recompute
//   POST /admin/picking-orders/:id/reallocate   — recompute scoped to the
//     order's part keys (404 unknown / 409 order_not_open / 409 lock_held)
// Dynamic app import so DATABASE_URL points at the test DB first (same
// pattern as src/routes/admin/receivingShipper.test.ts).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";
import { queryAll, queryGet } from "../../db/query.js";
import { confirmReceivingArrival } from "../../db/receiving.js";
import { insertReceivingOrder, insertPickingOrder } from "../../db/test-fixtures.js";
import { allocateAll } from "../../db/allocate.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../../index.js"))["app"];
let token: string;

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../../index.js"));
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "DocPalAdmin2026!" }),
  });
  token = (await res.json()).token;
});

function req(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
}

interface Scenario {
  orderA: string; // picking order ids
  orderB: string;
  orderC: string;
}

// Hermetic scenario on parts the demo seed never uses:
//   receiving REALLOC-P1 ×1000 (ctn 9001), REALLOC-P2 ×500 (no ctn), in_hand
//   SO-RA-001: REALLOC-P1 ×600   SO-RA-002: REALLOC-P1 ×400   SO-RC-003: REALLOC-P2 ×100
// (insertPickingOrder appends to the priority queue in call order → seq A<B<C)
async function seedScenario(): Promise<Scenario> {
  await client.db.execute(sql`DELETE FROM picking_orders`);
  const receivingOrderId = await insertReceivingOrder(client.db, "RA-TEST-01", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-09-14" },
    invoices: [
      {
        invoiceNo: "INV-RA-01",
        totalCtn: 1,
        items: [
          { partNo: "REALLOC-P1", poNo: "PO-1", poLine: "1", lineQty: 1000, ctnNo: "9001", orgId: 2, subInventoryCode: "STORE1" },
          { partNo: "REALLOC-P2", poNo: "PO-2", poLine: "1", lineQty: 500, orgId: 2, subInventoryCode: "STORE1" },
        ],
      },
    ],
  });
  const actorId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`)
  )!.id;
  await confirmReceivingArrival(client.db, receivingOrderId, actorId);

  const orderA = randomUUID();
  const orderB = randomUUID();
  const orderC = randomUUID();
  await insertPickingOrder(client.db, orderA, {
    order: { orderNo: "SO-RA-001", customerCode: "ACME", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "REALLOC-P1", qty: 600 }],
  });
  await insertPickingOrder(client.db, orderB, {
    order: { orderNo: "SO-RA-002", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "REALLOC-P1", qty: 400 }],
  });
  await insertPickingOrder(client.db, orderC, {
    order: { orderNo: "SO-RC-003", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "REALLOC-P2", qty: 100 }],
  });
  await allocateAll(client.db);
  return { orderA, orderB, orderC };
}

const allocRows = (orderId: string) =>
  queryAll<{ id: string; lotId: string | null; receivingItemId: string | null; receivingOrderId: string | null; qty: number }>(
    client.db,
    sql`SELECT a.id, a.inventory_lot_id AS "lotId", a.receiving_invoice_item_id AS "receivingItemId",
               a.receiving_order_id AS "receivingOrderId", a.qty
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderId}
        ORDER BY a.qty DESC`
  );

test("reallocate: 404 for an unknown picking order", async () => {
  await reseed(client);
  const res = await req(`/admin/picking-orders/${randomUUID()}/reallocate`, { method: "POST" });
  assert.equal(res.status, 404);
});

test("reallocate: rebuilds the order's part scope (same-part orders too, other parts untouched)", async () => {
  await reseed(client);
  const { orderA, orderB, orderC } = await seedScenario();

  // Baseline: no lots for REALLOC-P1 — both orders draw on the receiving ctn.
  assert.ok((await allocRows(orderA)).every((a) => a.receivingItemId !== null));
  const orderCBefore = (await allocRows(orderC)).map((a) => a.id).sort();

  // New shelf stock arrives (lot, FIFO before receiving sources) — nobody has
  // recomputed yet, so allocations still point at the receiving carton.
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, date_code, shelf_code, box_id, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-REALLOC-1', 'REALLOC-P1', '2001', 'A-04-05', 'REALLOCBOX1', 2, 'STORE1', 700, now(), now())
  `);

  const res = await req(`/admin/picking-orders/${orderA}/reallocate`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.allocation.durationMs >= 0);
  assert.deepEqual(body.allocation.partKeys, ["REALLOC-P1"]);

  // Order A (priority first) now holds 600 from the new lot.
  const a = await allocRows(orderA);
  assert.deepEqual(a.map((r) => [r.lotId, r.qty]), [["LOT-REALLOC-1", 600]]);

  // Same-part order B was rebuilt too: 100 lot remainder + 300 receiving ctn.
  const b = await allocRows(orderB);
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { id: b[0]!.id, lotId: null, receivingItemId: b[0]!.receivingItemId, receivingOrderId: null, qty: 300 });
  assert.equal(b[1]!.lotId, "LOT-REALLOC-1");
  assert.equal(b[1]!.qty, 100);

  // Order C (different part) was not in scope — allocation rows untouched.
  const orderCAfter = (await allocRows(orderC)).map((x) => x.id).sort();
  assert.deepEqual(orderCAfter, orderCBefore);
});

test("reallocate: 409 lock_held when a PDA holds the order's work lock", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  const operator = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`);
  await client.db.execute(
    sql`UPDATE picking_orders SET working_by = ${operator!.id}, working_at = now() WHERE id = ${orderA}`
  );

  const res = await req(`/admin/picking-orders/${orderA}/reallocate`, { method: "POST" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "lock_held");
  assert.equal(body.holderId, operator!.id);
});

test("reallocate: 409 order_not_open for a finished order", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  await client.db.execute(sql`UPDATE picking_orders SET status = 'finished' WHERE id = ${orderA}`);

  const res = await req(`/admin/picking-orders/${orderA}/reallocate`, { method: "POST" });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /order_not_open/);
});

test("allocate-all: full recompute returns the summary and rebuilds allocations", async () => {
  await reseed(client);
  await seedScenario();
  await client.db.execute(sql`DELETE FROM allocations`);

  const res = await req(`/admin/allocation/run`, { method: "POST" });
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.ok(summary.demands > 0);
  assert.ok(summary.allocationsCreated > 0);

  const count = await queryGet<{ n: number }>(client.db, sql`SELECT count(*)::int AS n FROM allocations`);
  assert.ok(count!.n > 0);
});
