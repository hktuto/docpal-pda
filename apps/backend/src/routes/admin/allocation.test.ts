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
import { recomputeLot, recomputePickingItem } from "../../db/picking.js";
import { _setPickingAllocationForTests } from "../../config.js";

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
  receivingOrderId: string;
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
  return { orderA, orderB, orderC, receivingOrderId };
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
    VALUES ('LOT-REALLOC-1', 'REALLOC-P1', '2001', 'A0405', 'REALLOCBOX1', 2, 'STORE1', 700, now(), now())
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
    VALUES ('LOT-REALLOC-R1', 'REALLOC-P1', '2001', 'A0405', 'REALLOCRBX1', 2, 'STORE1', 700, now(), now())
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
    VALUES ('LOT-REMOVE-1', 'REALLOC-P1', '2001', 'A0405', 'REMOVEBOX1', 2, 'STORE1', 700, now(), now())
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
    VALUES (${id}, ${partNo}, '2001', 'A0405', ${id + "-BOX"}, 2, 'STORE1', ${qty}, now(), now())
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

// --- POST .../allocations with override: true (reclaim from other orders) ---

// seedScenario (orderA demand 600, orderB 400, REALLOC-P1 receiving 1000) + a
// shelf lot; allocateAll gives orderA the lot first (shelf before dock), B the
// receiving carton. Dropping orderB's rows leaves orderA holding the
// fully-reserved lot — the greyed-out case the override button unlocks.
async function seedStealScenario(lotId: string, lotQty: number) {
  const { orderA, orderB } = await seedScenario();
  await clearAllocations();
  await insertLot(lotId, "REALLOC-P1", lotQty);
  await allocateAll(client.db);
  const itemB = await itemIdOf(orderB);
  await client.db.execute(sql`DELETE FROM allocations WHERE picking_item_id = ${itemB}`);
  await client.db.execute(sql`UPDATE picking_items SET allocated_qty = 0 WHERE id = ${itemB}`);
  return { orderA, orderB };
}

test("manual-allocate override: steals the shortfall from another order's auto allocation", async () => {
  await reseed(client);
  // Lot 500: orderA takes 500 from the lot (+100 dock); orderB's 400 sit on
  // the dock carton. B pins 400 on the lot — 400 above its availability.
  const { orderA, orderB } = await seedStealScenario("LOT-OVR-1", 500);
  const itemA = await itemIdOf(orderA);
  const itemB = await itemIdOf(orderB);

  const res = await req(`/admin/picking-orders/${orderB}/items/${itemB}/allocations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qty: 400, inventoryLotId: "LOT-OVR-1", override: true }),
  });
  assert.equal(res.status, 200);

  // orderA's auto row is partially reclaimed (500 → 100).
  const aRows = await queryAll<{ qty: number; manual: boolean }>(
    client.db,
    sql`SELECT a.qty, a.manual FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderA} AND a.inventory_lot_id = 'LOT-OVR-1'`
  );
  assert.equal(aRows.reduce((s, r) => s + r.qty, 0), 100);
  assert.ok(aRows.every((r) => !r.manual));
  const bRows = await queryAll<{ qty: number; manual: boolean }>(
    client.db,
    sql`SELECT a.qty, a.manual FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderB} AND a.inventory_lot_id = 'LOT-OVR-1'`
  );
  assert.equal(bRows.length, 1);
  assert.equal(bRows[0].qty, 400);
  assert.equal(bRows[0].manual, true);

  const lot = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = 'LOT-OVR-1'`
  );
  assert.equal(lot!.allocatedQty, 500);
  // orderA: 100 lot + 100 dock = 200 allocated of its 600 open.
  const itemAState = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM picking_items WHERE id = ${itemA}`
  );
  assert.equal(itemAState!.allocatedQty, 200);

  // Victim-side audit + release ledger.
  const audit = await queryGet<{ metadata: { action?: string; qty?: number; thiefOrderId?: string } }>(
    client.db,
    sql`SELECT metadata FROM transaction_logs
        WHERE entity_type = 'picking_order' AND entity_id = ${orderA}
          AND metadata->>'action' = 'allocation_stolen'`
  );
  assert.ok(audit);
  assert.equal(audit!.metadata.qty, 400);
  assert.equal(audit!.metadata.thiefOrderId, orderB);
  const ledger = await queryGet<{ qtyDelta: number; txnReason: string }>(
    client.db,
    sql`SELECT qty_delta AS "qtyDelta", txn_reason AS "txnReason" FROM inventory_transactions
        WHERE txn_reason = 'admin: override steal' AND qty_delta = -400`
  );
  assert.ok(ledger);
});

test("manual-allocate override: a fully-covered victim row is deleted outright", async () => {
  await reseed(client);
  const { orderA, orderB } = await seedScenario();
  await clearAllocations();
  await insertLot("LOT-OVR-F", "REALLOC-P1", 60);
  const itemA = await itemIdOf(orderA);
  const itemB = await itemIdOf(orderB);
  // Craft a small auto allocation on orderB's item directly (the engine would
  // never create one this small here) so the steal consumes the whole row.
  await client.db.execute(sql`
    INSERT INTO allocations (id, picking_item_id, inventory_lot_id, qty, manual, created_date, last_update_date)
    VALUES ('ALLOC-VIC-RAW', ${itemB}, 'LOT-OVR-F', 60, false, now(), now())
  `);
  await recomputeLot(client.db, "LOT-OVR-F");
  await recomputePickingItem(client.db, itemB);

  const res = await req(`/admin/picking-orders/${orderA}/items/${itemA}/allocations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qty: 60, inventoryLotId: "LOT-OVR-F", override: true }),
  });
  assert.equal(res.status, 200);

  const raw = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM allocations WHERE id = 'ALLOC-VIC-RAW'`);
  assert.ok(!raw);
  const pin = await queryGet<{ qty: number; manual: boolean }>(
    client.db,
    sql`SELECT qty, manual FROM allocations WHERE picking_item_id = ${itemA} AND inventory_lot_id = 'LOT-OVR-F'`
  );
  assert.ok(pin);
  assert.equal(pin!.qty, 60);
  assert.equal(pin!.manual, true);
});

test("manual-allocate override: manual pins are never stolen (409 insufficient_available)", async () => {
  await reseed(client);
  const { orderA, orderB } = await seedStealScenario("LOT-OVR-2", 600);
  const itemA = await itemIdOf(orderA);
  const itemB = await itemIdOf(orderB);
  // Reset the lot completely so orderA's hold is purely a manual pin.
  await client.db.execute(sql`DELETE FROM allocations WHERE picking_item_id = ${itemA}`);
  await client.db.execute(sql`UPDATE picking_items SET allocated_qty = 0 WHERE id = ${itemA}`);
  await client.db.execute(sql`UPDATE inventory_lots SET allocated_qty = 0 WHERE id = 'LOT-OVR-2'`);

  // orderA's 600 on the lot is a manual pin now.
  const pin = await req(`/admin/picking-orders/${orderA}/items/${itemA}/allocations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qty: 600, inventoryLotId: "LOT-OVR-2" }),
  });
  assert.equal(pin.status, 200);

  const res = await req(`/admin/picking-orders/${orderB}/items/${itemB}/allocations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qty: 100, inventoryLotId: "LOT-OVR-2", override: true }),
  });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /insufficient_available/);

  const aRows = await queryAll<{ qty: number; manual: boolean }>(
    client.db,
    sql`SELECT a.qty, a.manual FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderA} AND a.inventory_lot_id = 'LOT-OVR-2'`
  );
  assert.equal(aRows.reduce((s, r) => s + r.qty, 0), 600);
  assert.ok(aRows.every((r) => r.manual));
});

test("manual-allocate override: skips a locked victim order and 409s on the leftover shortfall", async () => {
  await reseed(client);
  const { orderA, orderB } = await seedStealScenario("LOT-OVR-3", 500);
  const itemB = await itemIdOf(orderB);
  const operator = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`);
  await client.db.execute(
    sql`UPDATE picking_orders SET working_by = ${operator!.id}, working_at = now() WHERE id = ${orderA}`
  );

  const res = await req(`/admin/picking-orders/${orderB}/items/${itemB}/allocations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qty: 400, inventoryLotId: "LOT-OVR-3", override: true }),
  });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /insufficient_available/);

  // Nothing was stolen and no allocation was pinned.
  const lot = await queryGet<{ allocatedQty: number }>(
    client.db,
    sql`SELECT allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = 'LOT-OVR-3'`
  );
  assert.equal(lot!.allocatedQty, 500);
});

// --- GET /admin/part-availability ------------------------------------------

test("part-availability: returns stock and receiving rows for the part", async () => {
  await reseed(client);
  await seedScenario();
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, date_code, shelf_code, box_id, org_id, sub_inventory_code, coo, cow, total_qty, created_date, last_update_date)
    VALUES ('LOT-AVAIL-1', 'REALLOC-P1', '2001', 'A0405', 'AVAILBOX1', 2, 'STORE1', 'JP', 'CN', 50, now(), now())
  `);

  const res = await req(`/admin/part-availability?partNo=REALLOC-P1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.stock.length, 1);
  assert.equal(body.stock[0].lotId, "LOT-AVAIL-1");
  assert.equal(body.stock[0].totalQty, 50);
  assert.equal(body.stock[0].availableQty, 50);
  assert.equal(body.stock[0].coo, "JP");
  assert.equal(body.stock[0].cow, "CN");
  assert.equal(body.receiving.length, 1);
  assert.equal(body.receiving[0].batchNo, "RA-TEST-01");
  assert.equal(body.receiving[0].ctnNo, "9001");
  assert.equal(body.receiving[0].lineQty, 1000);
});

test("part-availability: `matched` flags the order's location and its share group", async () => {
  await reseed(client);
  await seedScenario();
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, date_code, shelf_code, box_id, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-MATCH-1', 'REALLOC-P1', '2001', 'A0405', 'MBOX1', 2, 'STORE1', 10, now(), now()),
           ('LOT-MATCH-2', 'REALLOC-P1', '2001', 'A0405', 'MBOX2', 2, 'WSTORE1', 10, now(), now()),
           ('LOT-MATCH-3', 'REALLOC-P1', '2001', 'A0405', 'MBOX3', 2, 'ZTE', 10, now(), now()),
           ('LOT-MATCH-4', 'REALLOC-P1', '2001', 'A0405', 'MBOX4', 7, 'STORE1', 10, now(), now())
  `);

  const body = await (await req(`/admin/part-availability?partNo=REALLOC-P1&orgId=2&subInventoryCode=STORE1`)).json();
  const byLot = Object.fromEntries(body.stock.map((s: any) => [s.lotId, s.matched]));
  // STORE1 itself and WSTORE1 (same "HK" share group, org 2) match;
  // another org-2 sub-inventory and STORE1 under org 7 do not.
  assert.equal(byLot["LOT-MATCH-1"], true);
  assert.equal(byLot["LOT-MATCH-2"], true);
  assert.equal(byLot["LOT-MATCH-3"], false);
  assert.equal(byLot["LOT-MATCH-4"], false);
  // The receiving line is stamped org 2 / STORE1 → matches too.
  assert.equal(body.receiving.every((r: any) => r.matched), true);

  // No context → nothing is cut (every row is "applicable").
  const all = await (await req(`/admin/part-availability?partNo=REALLOC-P1`)).json();
  assert.equal(all.stock.every((s: any) => s.matched), true);
});

test("part-availability: no receiving rows when dock-stock allocation is off", async () => {
  await reseed(client);
  await seedScenario();
  _setPickingAllocationForTests({ allowDockStock: false });
  try {
    const res = await req(`/admin/part-availability?partNo=REALLOC-P1&orgId=2&subInventoryCode=STORE1`);
    const body = await res.json();
    assert.equal(body.dockStockAllowed, false);
    assert.deepEqual(body.receiving, []);
  } finally {
    _setPickingAllocationForTests({ allowDockStock: true });
  }
});

test("part-availability: empty arrays for an unknown part; 400 without partNo", async () => {
  await reseed(client);
  const res = await req(`/admin/part-availability?partNo=NO-SUCH-PART`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.stock, []);
  assert.deepEqual(body.receiving, []);
  assert.equal(body.dockStockAllowed, true);

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
  // Both orders sit in org 2 / STORE1 — the demand context they are read with.
  assert.equal(body.demand.every((d: any) => d.matched), true);
  const scoped = await (
    await req(`/admin/part-demand?partNo=REALLOC-P1&orgId=7&subInventoryCode=STORE1`)
  ).json();
  assert.equal(scoped.demand.every((d: any) => d.matched === false), true);

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

// --- POST /admin/receiving-orders/:id/items/:itemId/reallocate-demand -------
// Final-state redistribution of one receiving item's dock stock across open
// picking demand (spec 2026-10-12-admin-receiving-reallocate-form-design.md):
// release the rows that shrink first, then grow the rows that grow, in one
// all-or-nothing transaction.

/** Per-order allocation ROW count (not qty) — one row per order, never two. */
const rowsFromItem = async (itemId: string) => {
  const rows = await queryAll<{ orderNo: string; n: number }>(
    client.db,
    sql`SELECT po.order_no AS "orderNo", COUNT(*)::int AS n
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE a.receiving_invoice_item_id = ${itemId}
        GROUP BY po.order_no ORDER BY po.order_no`
  );
  return Object.fromEntries(rows.map((r) => [r.orderNo, r.n]));
};

const reallocItemId = async (receivingOrderId: string) =>
  (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${receivingOrderId} AND rii.part_no = 'REALLOC-P1'`
  ))!.id;

const postRealloc = (receivingOrderId: string, itemId: string, rows: { pickingItemId: string; qty: number }[]) =>
  req(`/admin/receiving-orders/${receivingOrderId}/items/${itemId}/reallocate-demand`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });

/** Holdings of `itemId` on each picking item, straight from allocations. */
const fromItem = async (itemId: string) => {
  const rows = await queryAll<{ orderNo: string; qty: number }>(
    client.db,
    sql`SELECT po.order_no AS "orderNo", SUM(a.qty)::int AS qty
        FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE a.receiving_invoice_item_id = ${itemId}
        GROUP BY po.order_no ORDER BY po.order_no`
  );
  return Object.fromEntries(rows.map((r) => [r.orderNo, r.qty]));
};

/**
 * seedScenario receives 1000 of REALLOC-P1 and creates SO-RA-001 (600, priority
 * 1) + SO-RA-002 (400, priority 2). We add SO-RA-003 (200, priority 3) so the
 * form has three rows totalling 1200 of demand against a 1000 pool — enough
 * headroom to prove the form can place the pool differently from the engine's
 * greedy priority fill.
 */
async function reallocFixture() {
  await reseed(client);
  const { orderA, orderB, receivingOrderId } = await seedScenario();
  const orderC = randomUUID();
  await insertPickingOrder(client.db, orderC, {
    order: { orderNo: "SO-RA-003", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "REALLOC-P1", qty: 200 }],
  });
  await clearAllocations();
  return {
    orderA,
    orderB,
    receivingOrderId,
    itemId: await reallocItemId(receivingOrderId),
    itemA: await itemIdOf(orderA),
    itemB: await itemIdOf(orderB),
    itemC: await itemIdOf(orderC),
  };
}

test("reallocate-demand: places the pool differently from the engine's priority fill", async () => {
  const { receivingOrderId, itemId, itemA, itemB, itemC } = await reallocFixture();

  // The engine's greedy fill would give priority-1 SO-RA-001 its full 600.
  // The admin places the whole 1000 pool as 400/400/200 instead, and it sticks:
  // a manual pin is preserved by the wipe/rebuild and nothing is left over for
  // the engine to re-distribute.
  const res = await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 400 },
    { pickingItemId: itemB, qty: 400 },
    { pickingItemId: itemC, qty: 200 },
  ]);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, 1000); // receivedQty - pickedQty
  assert.equal(body.fromItemQty, 1000);
  assert.equal(body.changed.length, 3);

  assert.deepEqual(await fromItem(itemId), { "SO-RA-001": 400, "SO-RA-002": 400, "SO-RA-003": 200 });
  const item = await queryGet<{ qty: number }>(
    client.db,
    sql`SELECT allocated_qty AS qty FROM picking_items WHERE id = ${itemA}`
  );
  assert.equal(item!.qty, 400);
});

test("reallocate-demand: raising an already-allocated row above its old remaining", async () => {
  const { receivingOrderId, itemId, itemA, itemB, itemC } = await reallocFixture();

  // SO-RA-001 is fully allocated by the engine — the case the old per-row form
  // could not act on (its input was capped at remainingQty and disabled at 0).
  await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 600 },
    { pickingItemId: itemB, qty: 400 },
  ]);
  assert.deepEqual(await fromItem(itemId), { "SO-RA-001": 600, "SO-RA-002": 400 });

  // Take 200 from SO-RA-001 (down to its 400) and give it to SO-RA-003, which
  // only the admin can satisfy that way: the engine's priority order would
  // never hand SO-RA-003 stock while SO-RA-001 is short.
  const res = await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 400 },
    { pickingItemId: itemB, qty: 400 },
    { pickingItemId: itemC, qty: 200 },
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(await fromItem(itemId), { "SO-RA-001": 400, "SO-RA-002": 400, "SO-RA-003": 200 });
});

test("reallocate-demand: raising a row amends its allocation line instead of adding one", async () => {
  const { receivingOrderId, itemId, itemA, itemB, itemC } = await reallocFixture();
  await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 400 },
    { pickingItemId: itemB, qty: 400 },
    { pickingItemId: itemC, qty: 200 },
  ]);
  assert.deepEqual(await rowsFromItem(itemId), { "SO-RA-001": 1, "SO-RA-002": 1, "SO-RA-003": 1 });

  // Raise SO-RA-001 by 200, taking 200 off SO-RA-003. Each order must still be
  // exactly ONE allocation line — a duplicate row would render as a second
  // line in the per-allocation list on the receiving/picking detail pages.
  await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 600 },
    { pickingItemId: itemB, qty: 400 },
    { pickingItemId: itemC, qty: 0 },
  ]);
  assert.deepEqual(await fromItem(itemId), { "SO-RA-001": 600, "SO-RA-002": 400 });
  assert.deepEqual(await rowsFromItem(itemId), { "SO-RA-001": 1, "SO-RA-002": 1 });

  // Move again — still one line per order, every time.
  await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 600 },
    { pickingItemId: itemB, qty: 200 },
    { pickingItemId: itemC, qty: 200 },
  ]);
  assert.deepEqual(await fromItem(itemId), { "SO-RA-001": 600, "SO-RA-002": 200, "SO-RA-003": 200 });
  assert.deepEqual(await rowsFromItem(itemId), { "SO-RA-001": 1, "SO-RA-002": 1, "SO-RA-003": 1 });

  // Every surviving row is a pin, so a recompute keeps them.
  const nonManual = await queryAll<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM allocations WHERE receiving_invoice_item_id = ${itemId} AND manual = false`
  );
  assert.equal(nonManual[0].n, 0);
});

test("reallocate-demand: leaving qty unplaced lets the engine redistribute it", async () => {
  const { receivingOrderId, itemId, itemA, itemB } = await reallocFixture();

  // Only 400 of the 1000 pool is placed. SO-RA-001 still has uncovered demand,
  // so the post-commit recompute hands it the 600 that was left over — this is
  // why the form's real power is placing the whole pool, not starving a row.
  const res = await postRealloc(receivingOrderId, itemId, [{ pickingItemId: itemB, qty: 400 }]);
  assert.equal(res.status, 200);
  const after = await fromItem(itemId);
  assert.equal(after["SO-RA-002"], 400);
  assert.equal(after["SO-RA-001"], 600);
});

test("reallocate-demand: qty 0 releases the row entirely", async () => {
  const { receivingOrderId, itemId, itemA, itemB, itemC } = await reallocFixture();
  await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 400 },
    { pickingItemId: itemB, qty: 400 },
    { pickingItemId: itemC, qty: 200 },
  ]);

  // Release SO-RA-003 and give its 200 to SO-RA-001 — still the whole pool, so
  // the result holds after the recompute.
  await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 600 },
    { pickingItemId: itemB, qty: 400 },
    { pickingItemId: itemC, qty: 0 },
  ]);
  assert.deepEqual(await fromItem(itemId), { "SO-RA-001": 600, "SO-RA-002": 400 });
  const ledger = await queryAll<{ qtyDelta: number }>(
    client.db,
    sql`SELECT qty_delta AS "qtyDelta" FROM inventory_transactions
        WHERE receiving_invoice_item_id = ${itemId} AND txn_reason = 'admin: reallocate'
        ORDER BY txn_at, id`
  );
  // 200 released from SO-RA-003 and 200 taken by SO-RA-001 — both signed.
  assert.ok(ledger.some((l) => l.qtyDelta === -200), "release row");
  assert.ok(ledger.some((l) => l.qtyDelta === 200), "add row");
});

test("reallocate-demand: rejecting the pool changes nothing (all-or-nothing)", async () => {
  const { receivingOrderId, itemId, itemA, itemB, itemC } = await reallocFixture();
  // Deterministic setup: place the whole pool so the recompute can't shift it.
  await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 600 },
    { pickingItemId: itemB, qty: 400 },
    { pickingItemId: itemC, qty: 0 },
  ]);

  // 600 + 400 + 200 = 1200 > the item's 1000.
  const res = await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 600 },
    { pickingItemId: itemB, qty: 400 },
    { pickingItemId: itemC, qty: 200 },
  ]);
  assert.equal(res.status, 409);
  const body = JSON.parse(await res.text());
  assert.equal(body.error, "insufficient_available");
  assert.equal(body.plannedTotal, 1200);
  assert.equal(body.available, 1000);
  // Nothing moved — not even the valid rows in the same batch.
  assert.deepEqual(await fromItem(itemId), { "SO-RA-001": 600, "SO-RA-002": 400 });
});

test("reallocate-demand: a row over its own requirement rejects the whole batch", async () => {
  const { receivingOrderId, itemId, itemA, itemB } = await reallocFixture();

  // SO-RA-001 only needs 600.
  const res = await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 601 },
    { pickingItemId: itemB, qty: 100 },
  ]);
  assert.equal(res.status, 409);
  const body = JSON.parse(await res.text());
  assert.equal(body.error, "reallocate_rejected");
  assert.deepEqual(body.rows, [{ pickingItemId: itemA, orderNo: "SO-RA-001", reason: "over_allocation" }]);
  assert.deepEqual(await fromItem(itemId), {});
});

test("reallocate-demand: a work-locked order rejects the whole batch with per-row reasons", async () => {
  const { orderB, receivingOrderId, itemId, itemA, itemB } = await reallocFixture();
  await req(`/picking-orders/${orderB}/work-lock`, { method: "POST" });

  const res = await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 200 },
    { pickingItemId: itemB, qty: 200 },
  ]);
  assert.equal(res.status, 409);
  const body = JSON.parse(await res.text());
  assert.equal(body.error, "reallocate_rejected");
  assert.deepEqual(body.rows, [{ pickingItemId: itemB, orderNo: "SO-RA-002", reason: "lock_held" }]);

  // The unlocked row in the same batch did not commit.
  assert.deepEqual(await fromItem(itemId), {});

  // part-demand surfaces the lock so the form can grey the row up front.
  const demand = await (
    await req(`/admin/part-demand?partNo=REALLOC-P1&fromReceivingItemId=${itemId}`)
  ).json();
  const rowB = demand.demand.find((d: any) => d.pickingItemId === itemB);
  assert.equal(rowB.locked, true);
  assert.ok(rowB.workingByName);
});

test("reallocate-demand: untouched rows keep their qty and still consume the pool", async () => {
  const { receivingOrderId, itemId, itemA, itemB, itemC } = await reallocFixture();
  // Deterministic setup: the whole 1000 pool placed on two rows.
  await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 600 },
    { pickingItemId: itemB, qty: 400 },
    { pickingItemId: itemC, qty: 0 },
  ]);
  assert.deepEqual(await fromItem(itemId), { "SO-RA-001": 600, "SO-RA-002": 400 });

  // A call naming ONLY SO-RA-003: if the untouched rows were ignored the pool
  // would look empty and this would succeed. They are counted, so it is 1100
  // against 1000 and the whole batch is refused.
  const res = await postRealloc(receivingOrderId, itemId, [{ pickingItemId: itemC, qty: 100 }]);
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(await res.text()).error, "insufficient_available");
  assert.deepEqual(await fromItem(itemId), { "SO-RA-001": 600, "SO-RA-002": 400 });
});

test("reallocate-demand: 404 for an item that isn't on the order, 400 for a bad qty", async () => {
  const { receivingOrderId, itemId, itemA } = await reallocFixture();
  const other = await req(`/admin/receiving-orders/${randomUUID()}/items/${itemA}/reallocate-demand`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows: [{ pickingItemId: itemA, qty: 10 }] }),
  });
  assert.equal(other.status, 404);

  const bad = await postRealloc(receivingOrderId, itemId, [{ pickingItemId: itemA, qty: -1 }]);
  assert.equal(bad.status, 400);
  const dup = await postRealloc(receivingOrderId, itemId, [
    { pickingItemId: itemA, qty: 10 },
    { pickingItemId: itemA, qty: 20 },
  ]);
  assert.equal(dup.status, 400);
});

// --- POST .../allocate-form: ONE Confirm for the whole availability form ---

const postForm = (orderId: string, itemId: string, rows: unknown[]) =>
  req(`/admin/picking-orders/${orderId}/items/${itemId}/allocate-form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });

/** Allocation rows for one picking item: one line per source, never two. */
const formRows = (itemId: string) =>
  queryAll<{ lotId: string | null; qty: number; manual: boolean }>(
    client.db,
    sql`SELECT inventory_lot_id AS "lotId", qty, manual FROM allocations
        WHERE picking_item_id = ${itemId} ORDER BY inventory_lot_id`
  );

const lotAllocated = async (lotId: string) =>
  (await queryGet<{ qty: number }>(
    client.db,
    sql`SELECT allocated_qty AS qty FROM inventory_lots WHERE id = ${lotId}`
  ))!.qty;

test("allocate-form: applies every row at once and amends rather than duplicates", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  await clearAllocations();
  await insertLot("LOT-FORM-1", "REALLOC-P1", 1000);
  await insertLot("LOT-FORM-2", "REALLOC-P1", 1000);
  const itemId = await itemIdOf(orderA);

  const split = await postForm(orderA, itemId, [
    { inventoryLotId: "LOT-FORM-1", qty: 300 },
    { inventoryLotId: "LOT-FORM-2", qty: 300 },
  ]);
  assert.equal(split.status, 200);
  assert.equal((await formRows(itemId)).reduce((s, r) => s + r.qty, 0), 600);
  assert.equal(await lotAllocated("LOT-FORM-1"), 300);
  assert.equal(await lotAllocated("LOT-FORM-2"), 300);

  // Move everything onto LOT-FORM-1: grown in place, never a second line.
  const move = await postForm(orderA, itemId, [
    { inventoryLotId: "LOT-FORM-1", qty: 600 },
    { inventoryLotId: "LOT-FORM-2", qty: 0 },
  ]);
  assert.equal(move.status, 200);
  const after = await formRows(itemId);
  assert.deepEqual(
    after.map((r) => [r.lotId, r.qty]),
    [["LOT-FORM-1", 600]]
  );
  assert.equal(await lotAllocated("LOT-FORM-1"), 600);
  assert.equal(await lotAllocated("LOT-FORM-2"), 0);
  // Every surviving row is a pin, so a recompute keeps it.
  assert.ok(after.every((r) => r.manual));
});

test("allocate-form: rows left out of the payload keep their current qty", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  await clearAllocations();
  await insertLot("LOT-FORM-3", "REALLOC-P1", 1000);
  await insertLot("LOT-FORM-4", "REALLOC-P1", 1000);
  const itemId = await itemIdOf(orderA);

  assert.equal((await postForm(orderA, itemId, [{ inventoryLotId: "LOT-FORM-3", qty: 250 }])).status, 200);
  assert.equal((await postForm(orderA, itemId, [{ inventoryLotId: "LOT-FORM-4", qty: 150 }])).status, 200);
  assert.deepEqual(
    (await formRows(itemId)).map((r) => [r.lotId, r.qty]),
    [["LOT-FORM-3", 250], ["LOT-FORM-4", 150]]
  );

  // The date-code / match filters can hide a source — they must never release it.
  assert.equal((await postForm(orderA, itemId, [])).status, 200);
  assert.equal((await formRows(itemId)).reduce((s, r) => s + r.qty, 0), 400);
});

test("allocate-form: a rejected row rolls the whole batch back", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  await clearAllocations();
  await insertLot("LOT-FORM-5", "REALLOC-P1", 1000);
  await insertLot("LOT-FORM-6", "REALLOC-P1", 1000);
  const itemId = await itemIdOf(orderA);

  // 600 is the item's whole open qty; the extra 1 invalidates the batch, so
  // the 600 that was valid must NOT be applied either.
  const over = await postForm(orderA, itemId, [
    { inventoryLotId: "LOT-FORM-5", qty: 600 },
    { inventoryLotId: "LOT-FORM-6", qty: 1 },
  ]);
  assert.equal(over.status, 409);
  const body = await over.json();
  assert.equal(body.error, "over_allocation");
  assert.equal(body.openQty, 600);
  assert.equal(await lotAllocated("LOT-FORM-5"), 0);
  assert.equal(await lotAllocated("LOT-FORM-6"), 0);
  assert.equal((await formRows(itemId)).length, 0);
});

test("allocate-form: validation and per-row rejection reasons", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  await clearAllocations();
  await insertLot("LOT-FORM-7", "REALLOC-P1", 1000);
  await insertLot("LOT-FORM-8", "REALLOC-P1", 100); // short source
  const itemId = await itemIdOf(orderA);

  assert.equal((await postForm(orderA, itemId, [{ qty: 10 }])).status, 400); // source_required
  assert.equal(
    (
      await postForm(orderA, itemId, [
        { inventoryLotId: "LOT-FORM-7", receivingInvoiceItemId: "x", qty: 10 },
      ])
    ).status,
    400
  );
  assert.equal((await postForm(orderA, itemId, [{ inventoryLotId: "LOT-FORM-7", qty: -1 }])).status, 400);
  assert.equal(
    (
      await postForm(orderA, itemId, [
        { inventoryLotId: "LOT-FORM-7", qty: 1 },
        { inventoryLotId: "LOT-FORM-7", qty: 2 },
      ])
    ).status,
    400
  ); // duplicate_source
  assert.equal((await postForm(orderA, itemId, [{ inventoryLotId: "NO-SUCH-LOT", qty: 1 }])).status, 404);

  // A row past its source's availability, without override, rejects the batch
  // with a key the form can hang on the offending row.
  const rejected = await postForm(orderA, itemId, [
    { inventoryLotId: "LOT-FORM-7", qty: 100 },
    { inventoryLotId: "LOT-FORM-8", qty: 500 },
  ]);
  assert.equal(rejected.status, 409);
  const body = await rejected.json();
  assert.equal(body.error, "allocate_rejected");
  assert.deepEqual(body.rows, [{ key: "l:LOT-FORM-8", reason: "insufficient_available" }]);
  assert.equal((await formRows(itemId)).length, 0);
});

test("allocate-form: an override row reclaims other orders' stock in the same call", async () => {
  await reseed(client);
  const { orderA, orderB } = await seedStealScenario("LOT-FORM-9", 500);
  const itemB = await itemIdOf(orderB);

  const res = await postForm(orderB, itemB, [
    { inventoryLotId: "LOT-FORM-9", qty: 400, override: true },
  ]);
  assert.equal(res.status, 200);

  assert.deepEqual(
    (await formRows(itemB)).map((r) => [r.lotId, r.qty, r.manual]),
    [["LOT-FORM-9", 400, true]]
  );
  const aRows = await queryAll<{ qty: number }>(
    client.db,
    sql`SELECT a.qty FROM allocations a
        JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderA} AND a.inventory_lot_id = 'LOT-FORM-9'`
  );
  assert.equal(aRows.reduce((s, r) => s + r.qty, 0), 100);
  assert.equal(await lotAllocated("LOT-FORM-9"), 500);
});

test("allocate-form: 404 for an unknown order or item, 409 when a PDA holds the lock", async () => {
  await reseed(client);
  const { orderA } = await seedScenario();
  await clearAllocations();
  await insertLot("LOT-FORM-10", "REALLOC-P1", 1000);
  const itemId = await itemIdOf(orderA);
  const row = [{ inventoryLotId: "LOT-FORM-10", qty: 1 }];

  assert.equal((await postForm(randomUUID(), itemId, row)).status, 404);
  assert.equal((await postForm(orderA, randomUUID(), row)).status, 404);

  const operator = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`);
  await client.db.execute(
    sql`UPDATE picking_orders SET working_by = ${operator!.id}, working_at = now() WHERE id = ${orderA}`
  );
  const locked = await postForm(orderA, itemId, row);
  assert.equal(locked.status, 409);
  assert.match(await locked.text(), /lock_held/);
});
