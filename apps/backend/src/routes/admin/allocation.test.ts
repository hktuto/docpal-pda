// Route-level tests for the admin manual allocation triggers (spec
// 2026-09-14-admin-allocation-buttons-design.md):
//   POST /admin/allocation/run                  — full-fleet recompute
//   POST /admin/picking-orders/:id/reallocate   — recompute scoped to the
//     order's part keys (404 unknown / 409 order_not_open / 409 lock_held)
//   POST /admin/receiving-orders/:id/reallocate — same scoped recompute for
//     a receiving order (404 unknown / 409 order_not_in_hand unless in_hand)
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

// --- POST /admin/receiving-orders/:id/reallocate -----------------------------

test("receiving-reallocate: 404 for an unknown receiving order", async () => {
  await reseed(client);
  const res = await req(`/admin/receiving-orders/${randomUUID()}/reallocate`, { method: "POST" });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /receiving_order_not_found/);
});

test("receiving-reallocate: 409 order_not_in_hand for a pending order", async () => {
  await reseed(client);
  const receivingOrderId = await insertReceivingOrder(client.db, "RA-PENDING-01", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-09-14" },
    invoices: [
      {
        invoiceNo: "INV-RA-P01",
        totalCtn: 1,
        items: [{ partNo: "REALLOC-P1", poNo: "PO-9", poLine: "1", lineQty: 10, orgId: 2, subInventoryCode: "STORE1" }],
      },
    ],
  });

  const res = await req(`/admin/receiving-orders/${receivingOrderId}/reallocate`, { method: "POST" });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /order_not_in_hand/);
});

test("receiving-reallocate: rebuilds the order's part scope for an in-hand order", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  const receivingOrderId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = 'RA-TEST-01'`)
  )!.id;

  // New shelf stock arrives after the last allocateAll — stale until the
  // scoped recompute runs.
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, date_code, shelf_code, box_id, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-REALLOC-R1', 'REALLOC-P1', '2001', 'A-04-05', 'REALLOCRBX1', 2, 'STORE1', 700, now(), now())
  `);
  assert.ok((await allocRows(orderA)).every((a) => a.receivingItemId !== null));

  const res = await req(`/admin/receiving-orders/${receivingOrderId}/reallocate`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.allocation.durationMs >= 0);

  // Order A (priority first) now holds 600 from the new lot.
  const a = await allocRows(orderA);
  assert.deepEqual(a.map((r) => [r.lotId, r.qty]), [["LOT-REALLOC-R1", 600]]);
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

// --- DELETE /admin/picking-orders/:id/items/:itemId/allocations/:allocationId

const itemIdOf = async (orderId: string) =>
  (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM picking_items WHERE picking_order_id = ${orderId}`))!.id;

test("remove-allocation: deletes one allocation row and recomputes state", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  const itemId = await itemIdOf(orderA);
  const before = await allocRows(orderA);
  assert.ok(before.length > 0);
  const target = before[0];
  const qtySum = before.reduce((s, a) => s + a.qty, 0);

  const res = await req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations/${target.id}`, { method: "DELETE" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.removed, 1);
  assert.equal(body.qty, target.qty);

  const after = await allocRows(orderA);
  assert.equal(after.length, before.length - 1);
  assert.ok(!after.some((a) => a.id === target.id));
  const item = await queryGet<{ allocatedQty: number; pickedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty", picked_qty AS "pickedQty" FROM picking_items WHERE id = ${itemId}`
  );
  assert.equal(item!.allocatedQty, qtySum - target.qty);
  const order = await queryGet<{ allocationStatus: string }>(
    client.db,
    sql`SELECT allocation_status AS "allocationStatus" FROM picking_orders WHERE id = ${orderA}`
  );
  assert.equal(order!.allocationStatus, after.length === 0 ? "unallocated" : "partial");
  const audit = await queryGet<{ metadata: { action?: string; allocationId?: string; itemId?: string; qty?: number } }>(
    client.db,
    sql`SELECT metadata FROM transaction_logs
        WHERE entity_type = 'picking_order' AND entity_id = ${orderA}
          AND metadata->>'action' = 'remove_allocation'`
  );
  assert.ok(audit);
  assert.equal(audit!.metadata.allocationId, target.id);
  assert.equal(audit!.metadata.itemId, itemId);
  assert.equal(audit!.metadata.qty, target.qty);
});

test("remove-allocation: releases only the removed row's lot reservation", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, date_code, shelf_code, box_id, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-REMOVE-1', 'REALLOC-P1', '2001', 'A-04-05', 'REMOVEBOX1', 2, 'STORE1', 700, now(), now())
  `);
  await allocateAll(client.db);
  // Shelf lots are allocated before dock receiving: orderA takes 600 and
  // orderB the remaining 100 from the lot, so it is fully reserved.
  const lotBefore = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = 'LOT-REMOVE-1'`
  );
  assert.equal(lotBefore!.allocatedQty, 700);

  const itemId = await itemIdOf(orderA);
  const lotAlloc = (await allocRows(orderA)).find((a) => a.lotId === "LOT-REMOVE-1");
  assert.ok(lotAlloc);
  const res = await req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations/${lotAlloc!.id}`, { method: "DELETE" });
  assert.equal(res.status, 200);

  // orderA's 600 is released; orderB's 100 reservation on the lot remains.
  const lotAfter = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = 'LOT-REMOVE-1'`
  );
  assert.equal(lotAfter!.allocatedQty, 100);
});

test("remove-allocation: 404 unknown order / item / allocation", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  const itemId = await itemIdOf(orderA);
  const allocId = (await allocRows(orderA))[0].id;
  const res1 = await req(`/admin/picking-orders/${randomUUID()}/items/${randomUUID()}/allocations/${randomUUID()}`, { method: "DELETE" });
  assert.equal(res1.status, 404);
  const res2 = await req(`/admin/picking-orders/${orderA}/items/${randomUUID()}/allocations/${randomUUID()}`, { method: "DELETE" });
  assert.equal(res2.status, 404);
  assert.match(await res2.text(), /picking_item_not_found/);
  const res3 = await req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations/${randomUUID()}`, { method: "DELETE" });
  assert.equal(res3.status, 404);
  assert.match(await res3.text(), /allocation_not_found/);
  // An allocation belonging to a different item is also a 404.
  const res4 = await req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations/${allocId}`, { method: "DELETE" });
  assert.equal(res4.status, 200);
  const res5 = await req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations/${allocId}`, { method: "DELETE" });
  assert.equal(res5.status, 404);
});

test("remove-allocation: succeeds on a finished order (no status check)", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  const itemId = await itemIdOf(orderA);
  const allocId = (await allocRows(orderA))[0].id;
  await client.db.execute(sql`UPDATE picking_orders SET status = 'finished' WHERE id = ${orderA}`);

  const res = await req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations/${allocId}`, { method: "DELETE" });
  assert.equal(res.status, 200);
});

test("remove-allocation: 409 lock_held when a PDA holds the order's work lock", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  const itemId = await itemIdOf(orderA);
  const allocId = (await allocRows(orderA))[0].id;
  const operator = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`);
  await client.db.execute(
    sql`UPDATE picking_orders SET working_by = ${operator!.id}, working_at = now() WHERE id = ${orderA}`
  );

  const res = await req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations/${allocId}`, { method: "DELETE" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "lock_held");
  assert.equal(body.holderId, operator!.id);
});

// --- POST /admin/picking-orders/:id/items/:itemId/allocations (manual pin) --

const insertLot = (id: string, partNo: string, qty: number) =>
  client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, date_code, shelf_code, box_id, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES (${id}, ${partNo}, '2001', 'A-04-05', ${id + "-BOX"}, 2, 'STORE1', ${qty}, now(), now())
  `);

// seedScenario's confirm-arrival already auto-allocates the orders; manual
// allocation tests start from a clean slate so the over_allocation guard
// doesn't reject the pin.
const clearAllocations = async () => {
  await client.db.execute(sql`DELETE FROM allocations`);
  await client.db.execute(sql`UPDATE picking_items SET allocated_qty = 0`);
};

test("manual-allocate: pins a lot allocation that survives allocate-all", async () => {
  await reseed(client);
  const { orderA, orderB } = await seedScenario();
  await clearAllocations();
  await insertLot("LOT-MAN-1", "REALLOC-P1", 1000);
  const itemId = await itemIdOf(orderA);

  const res = await req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qty: 200, inventoryLotId: "LOT-MAN-1" }),
  });
  assert.equal(res.status, 200);
  const { allocationId } = await res.json();
  assert.ok(allocationId);

  const lotMid = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = 'LOT-MAN-1'`
  );
  assert.equal(lotMid!.allocatedQty, 200);
  const audit = await queryGet<{ metadata: { action?: string } }>(
    client.db,
    sql`SELECT metadata FROM transaction_logs
        WHERE entity_type = 'picking_order' AND entity_id = ${orderA}
          AND metadata->>'action' = 'manual_allocation'`
  );
  assert.ok(audit);

  // Full-fleet recompute must preserve the pinned row and auto-allocate only
  // the remaining demand around it (orderA 600-200=400, orderB 400 → lot).
  const run = await req(`/admin/allocation/run`, { method: "POST" });
  assert.equal(run.status, 200);

  const manual = await queryGet<{ id: string; qty: number }>(
    client.db,
    sql`SELECT id, qty FROM allocations WHERE id = ${allocationId} AND manual`
  );
  assert.ok(manual);
  assert.equal(manual!.qty, 200);

  const item = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM picking_items WHERE id = ${itemId}`
  );
  assert.equal(item!.allocatedQty, 600);
  const lotAfter = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = 'LOT-MAN-1'`
  );
  assert.equal(lotAfter!.allocatedQty, 1000); // 200 manual + 400 orderA + 400 orderB
  assert.equal((await allocRows(orderB)).reduce((s, a) => s + a.qty, 0), 400);
});

test("manual-allocate: pinned row survives order-scoped reallocate", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  await clearAllocations();
  await insertLot("LOT-MAN-2", "REALLOC-P1", 100);
  const itemId = await itemIdOf(orderA);

  const res = await req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qty: 50, inventoryLotId: "LOT-MAN-2" }),
  });
  assert.equal(res.status, 200);
  const { allocationId } = await res.json();

  const re = await req(`/admin/picking-orders/${orderA}/reallocate`, { method: "POST" });
  assert.equal(re.status, 200);
  const manual = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM allocations WHERE id = ${allocationId} AND manual`
  );
  assert.ok(manual);
  const item = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM picking_items WHERE id = ${itemId}`
  );
  assert.equal(item!.allocatedQty, 600);
});

test("manual-allocate: receiving source is pinned and netted out of dock availability", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  await clearAllocations();
  const itemId = await itemIdOf(orderA);
  const rii = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM receiving_invoice_items WHERE part_no = 'REALLOC-P1'`
  );
  assert.ok(rii);

  const res = await req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qty: 100, receivingInvoiceItemId: rii!.id }),
  });
  assert.equal(res.status, 200);
  const { allocationId } = await res.json();

  const run = await req(`/admin/allocation/run`, { method: "POST" });
  assert.equal(run.status, 200);

  const manual = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM allocations WHERE id = ${allocationId} AND manual`
  );
  assert.ok(manual);
  // Total held against the receiving line = 100 manual + 900 auto (orderA
  // 500 remaining + orderB 400) — never more than the received 1000.
  const held = await queryGet<{ s: number }>(
    client.db,
    sql`SELECT COALESCE(SUM(qty), 0)::int AS s FROM allocations WHERE receiving_invoice_item_id = ${rii!.id}`
  );
  assert.equal(held!.s, 1000);
  const item = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM picking_items WHERE id = ${itemId}`
  );
  assert.equal(item!.allocatedQty, 600);
});

test("manual-allocate: validation and guard errors", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  await clearAllocations();
  await insertLot("LOT-MAN-3", "REALLOC-P1", 1000);
  const itemId = await itemIdOf(orderA);
  const post = (body: unknown) =>
    req(`/admin/picking-orders/${orderA}/items/${itemId}/allocations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await post({ qty: 0, inventoryLotId: "LOT-MAN-3" })).status, 400); // invalid_qty
  assert.equal((await post({ qty: 1.5, inventoryLotId: "LOT-MAN-3" })).status, 400);
  assert.equal((await post({ qty: 10 })).status, 400); // source_required
  assert.equal((await post({ qty: 10, inventoryLotId: "LOT-MAN-3", receivingInvoiceItemId: "x" })).status, 400);
  const notFound = await post({ qty: 10, inventoryLotId: "NO-SUCH-LOT" });
  assert.equal(notFound.status, 404);
  assert.match(await notFound.text(), /inventory_lot_not_found/);
  const insufficient = await post({ qty: 5000, inventoryLotId: "LOT-MAN-3" });
  assert.equal(insufficient.status, 409);
  assert.match(await insufficient.text(), /insufficient_available/);
  const over = await post({ qty: 700, inventoryLotId: "LOT-MAN-3" }); // open qty is 600
  assert.equal(over.status, 409);
  assert.match(await over.text(), /over_allocation/);

  const ok = await post({ qty: 600, inventoryLotId: "LOT-MAN-3" });
  assert.equal(ok.status, 200);
  const over2 = await post({ qty: 1, inventoryLotId: "LOT-MAN-3" }); // fully allocated now
  assert.equal(over2.status, 409);
  assert.match(await over2.text(), /over_allocation/);

  const operator = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`);
  await client.db.execute(
    sql`UPDATE picking_orders SET working_by = ${operator!.id}, working_at = now() WHERE id = ${orderA}`
  );
  assert.equal((await post({ qty: 1, inventoryLotId: "LOT-MAN-3" })).status, 409); // lock_held
});

// --- GET /admin/part-availability ------------------------------------------

test("part-availability: returns stock and receiving rows for the part", async () => {
  await reseed(client);
  await seedScenario();
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, date_code, shelf_code, box_id, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-AVAIL-1', 'REALLOC-P1', '2001', 'A-04-05', 'AVAILBOX1', 2, 'STORE1', 50, now(), now())
  `);

  const res = await req(`/admin/part-availability?partNo=REALLOC-P1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stock.length, 1);
  assert.equal(body.stock[0].lotId, "LOT-AVAIL-1");
  assert.equal(body.stock[0].totalQty, 50);
  assert.equal(body.stock[0].availableQty, 50);
  assert.equal(body.receiving.length, 1);
  assert.equal(body.receiving[0].batchNo, "RA-TEST-01");
  assert.equal(body.receiving[0].ctnNo, "9001");
  assert.equal(body.receiving[0].lineQty, 1000);
});

test("part-availability: empty arrays for an unknown part; 400 without partNo", async () => {
  await reseed(client);
  const res = await req(`/admin/part-availability?partNo=NO-SUCH-PART`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { stock: [], receiving: [] });

  const res400 = await req(`/admin/part-availability`);
  assert.equal(res400.status, 400);
  assert.match(await res400.text(), /part_no_required/);
});

// --- GET /admin/part-demand -------------------------------------------------

test("part-demand: lists open picking items with remaining uncovered qty", async () => {
  await reseed(client);
  const { orderA, orderB } = await seedScenario();
  await clearAllocations(); // scenario confirm-arrival fully allocates; start clean
  await insertLot("LOT-DEM-1", "REALLOC-P1", 1000);

  const res = await req(`/admin/part-demand?partNo=REALLOC-P1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.demand.length, 2);
  const rowA = body.demand.find((d: any) => d.pickingOrderId === orderA);
  const rowB = body.demand.find((d: any) => d.pickingOrderId === orderB);
  assert.equal(rowA.remainingQty, 600);
  assert.equal(rowB.remainingQty, 400);
  assert.ok(rowA.pickingItemId);

  // Pin 200 to orderA's item — the demand list reflects it immediately.
  const pin = await req(`/admin/picking-orders/${orderA}/items/${rowA.pickingItemId}/allocations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qty: 200, inventoryLotId: "LOT-DEM-1" }),
  });
  assert.equal(pin.status, 200);
  const res2 = await req(`/admin/part-demand?partNo=REALLOC-P1`);
  const body2 = await res2.json();
  assert.equal(body2.demand.find((d: any) => d.pickingOrderId === orderA).remainingQty, 400);

  // orderC (REALLOC-P2) was also un-covered by clearAllocations.
  const res3 = await req(`/admin/part-demand?partNo=REALLOC-P2`);
  const p2 = (await res3.json()).demand;
  assert.equal(p2.length, 1);
  assert.equal(p2[0].remainingQty, 100);

  // Fully-allocated parts drop off the list entirely.
  const run = await req(`/admin/allocation/run`, { method: "POST" });
  assert.equal(run.status, 200);
  const res4 = await req(`/admin/part-demand?partNo=REALLOC-P1`);
  assert.deepEqual((await res4.json()).demand, []);

  const res400 = await req(`/admin/part-demand`);
  assert.equal(res400.status, 400);
});
