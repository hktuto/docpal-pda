// Route-level tests for the admin "Reset order" actions (spec
// docs/superpowers/specs/2026-11-07-admin-order-reset-design.md):
//   POST /admin/picking-orders/:id/reset — wipe picked/boxed progress
//     (packages reversed like a scan removal, boxes deleted), order → pending,
//     allocations KEPT. 404 picking_order_not_found, 409 picking_order_shipped.
//   POST /admin/receiving-cn/orders/:batchNo/reset — scan columns cleared,
//     received/picked/put-away qty zeroed, scan events + CN put-away task
//     deleted, order → pending. 404 receiving_cn_order_not_found, 409
//     order_already_clear. Behind the cnReceiving() 404 guard.
// Same auth/fixture pattern as pickingStatusOverride.test.ts /
// receivingCn.test.ts.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";
import { queryAll, queryGet } from "../../db/query.js";
import { insertPickingOrder } from "../../db/test-fixtures.js";
import { allocateAll } from "../../db/allocate.js";
import { scanPickingItem } from "../../db/picking.js";
import { _setCnReceivingForTests, _resetFlowConfigForTests } from "../../config.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../../index.js"))["app"];
let token: string;
let operatorToken: string;

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
  _setCnReceivingForTests(true); // the CN route guard 404s the surface when the step is off
});

after(() => {
  _resetFlowConfigForTests();
});

beforeEach(async () => {
  await reseed(client);
});

function req(path: string, init?: RequestInit, useOperator = false) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${useOperator ? operatorToken : token}`, ...init?.headers },
  });
}

// --- picking reset --------------------------------------------------------------

/** One pending order with one item backed by one shelf lot (allocateAll
 *  reserves the full 100). Returns the order id. */
async function seedAllocatedOrder(tag: string): Promise<string> {
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, shelf_code, box_id, date_code, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES (${"LOT-RST-" + tag}, ${"PART-RST-" + tag}, 'A0101', ${"BOX-RST-" + tag}, '2601', 2, 'STORE1', 200, now(), now())
  `);
  const orderId = randomUUID();
  await insertPickingOrder(client.db, orderId, {
    order: { orderNo: "SO-RST-" + tag, customerCode: "ACME", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "PART-RST-" + tag, qty: 100 }],
  });
  await allocateAll(client.db);
  return orderId;
}

test("picking reset: 404 for an unknown order", async () => {
  const res = await req(`/admin/picking-orders/${randomUUID()}/reset`, { method: "POST" });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /picking_order_not_found/);
});

test("picking reset: 409 for a shipped order", async () => {
  const orderId = await seedAllocatedOrder("shipped");
  await client.db.execute(sql`UPDATE picking_orders SET status = 'shipped', shipped_at = now() WHERE id = ${orderId}`);
  const res = await req(`/admin/picking-orders/${orderId}/reset`, { method: "POST" });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /picking_order_shipped/);
});

test("picking reset: in-progress order back to pending — packages/boxes deleted, picked_qty zeroed, allocations kept", async () => {
  const orderId = await seedAllocatedOrder("happy");
  const operatorId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`)
  )!.id;
  const item = (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_items WHERE picking_order_id = ${orderId}`
  ))!;
  const alloc = (await queryGet<{ id: string; qty: number }>(
    client.db,
    sql`SELECT a.id, a.qty FROM allocations a WHERE a.picking_item_id = ${item.id}`
  ))!;
  assert.equal(alloc.qty, 100, "allocateAll reserved the full qty");

  // Lock + scan 50 into a package, then box it (with a verify task on the box).
  assert.equal((await req(`/picking-orders/${orderId}/work-lock`, { method: "POST" }, true)).status, 200);
  await scanPickingItem(client.db, item.id, { actorId: operatorId, allocationId: alloc.id, qty: 50 });
  const boxId = "BOX-S-RST-happy";
  await client.db.execute(sql`INSERT INTO shipping_boxes (id, picking_order_id, status) VALUES (${boxId}, ${orderId}, 'closed')`);
  await client.db.execute(sql`UPDATE picking_packages SET shipping_box_id = ${boxId} WHERE picking_order_id = ${orderId}`);
  await client.db.execute(sql`INSERT INTO verify_tasks (id, shipping_box_id, status) VALUES ('VT-RST-happy', ${boxId}, 'pending')`);
  await client.db.execute(sql`UPDATE picking_orders SET status = 'picking_finished', labeling_pending = true WHERE id = ${orderId}`);
  const beforeLot = await queryGet<{ totalQty: number }>(
    client.db,
    sql`SELECT total_qty AS "totalQty" FROM inventory_lots WHERE id = 'LOT-RST-happy'`
  );
  assert.equal(beforeLot!.totalQty, 150, "the scan consumed 50 of the lot");

  const res = await req(`/admin/picking-orders/${orderId}/reset`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    { status: body.status, previousStatus: body.previousStatus, packagesRemoved: body.packagesRemoved, boxesRemoved: body.boxesRemoved },
    { status: "pending", previousStatus: "picking_finished", packagesRemoved: 1, boxesRemoved: 1 }
  );

  const order = (await queryGet<{ status: string; workingBy: string | null; labelingPending: boolean }>(
    client.db,
    sql`SELECT status, working_by AS "workingBy", labeling_pending AS "labelingPending" FROM picking_orders WHERE id = ${orderId}`
  ))!;
  assert.equal(order.status, "pending");
  assert.equal(order.workingBy, null, "work lock cleared");
  assert.equal(order.labelingPending, false, "labeling stage flag cleared");

  const afterItem = (await queryGet<{ pickedQty: number; allocatedQty: number; status: string }>(
    client.db,
    sql`SELECT picked_qty AS "pickedQty", allocated_qty AS "allocatedQty", status FROM picking_items WHERE id = ${item.id}`
  ))!;
  assert.equal(afterItem.pickedQty, 0);
  assert.equal(afterItem.status, "pending");
  assert.equal(afterItem.allocatedQty, 100, "allocations kept (restored to the pre-scan qty)");

  const allocAfter = (await queryGet<{ qty: number }>(
    client.db,
    sql`SELECT qty FROM allocations WHERE picking_item_id = ${item.id}`
  ))!;
  assert.equal(allocAfter.qty, 100, "the consumed 50 was bumped back onto the allocation row");

  const pkgCount = (await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM picking_packages WHERE picking_order_id = ${orderId}`
  ))!.n;
  assert.equal(pkgCount, 0, "packages deleted");
  const boxCount = (await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM shipping_boxes WHERE id = ${boxId}`
  ))!.n;
  assert.equal(boxCount, 0, "box deleted");
  const vtCount = (await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM verify_tasks WHERE id = 'VT-RST-happy'`
  ))!.n;
  assert.equal(vtCount, 0, "verify task cascaded");

  const lot = (await queryGet<{ totalQty: number; allocatedQty: number }>(
    client.db,
    sql`SELECT total_qty AS "totalQty", allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = 'LOT-RST-happy'`
  ))!;
  assert.equal(lot.totalQty, 200, "lot stock restored");
  assert.equal(lot.allocatedQty, 100, "lot allocated qty matches the kept allocation");

  const ledger = await queryAll<{ txnReason: string; qtyDelta: number }>(
    client.db,
    sql`SELECT txn_reason AS "txnReason", qty_delta AS "qtyDelta" FROM inventory_transactions
        WHERE txn_reason = 'admin order reset'`
  );
  assert.equal(ledger.length, 2, "reverse PICK ledger rows (reserved + on_hand)");
  assert.ok(ledger.every((l) => l.qtyDelta === 50));

  const log = (await queryGet<{ fromState: string; toState: string; reset: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", metadata->>'reset' AS "reset"
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId}
        ORDER BY created_date DESC LIMIT 1`
  ))!;
  assert.equal(log.fromState, "picking_finished");
  assert.equal(log.toState, "pending");
  assert.equal(log.reset, "true");
});

// --- CN receiving reset ---------------------------------------------------------

/** Simulate an in-progress CN order: `scanning`, one item with scan state +
 *  progress columns set, one scan event, one pending put-away task. */
async function seedCnOrder(batchNo: string, status = "scanning"): Promise<string> {
  const orderId = `cn-rst-${batchNo}`;
  await client.db.execute(
    sql`INSERT INTO receiving_orders_cn (id, batch_no, status, delivery_date, org_id, arrived_at, arrived_by)
        VALUES (${orderId}, ${batchNo}, ${status}, '2026-10-10', 2, now(), (SELECT id FROM users WHERE username = 'operator'))`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoices_cn (id, receiving_order_id, invoice_no, total_qty, total_ctn, org_id)
        VALUES (${`cn-rst-inv-${batchNo}`}, ${orderId}, 'INV-RST-1', 100, 2, 2)`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoice_items_cn (id, receiving_invoice_id, part_no, wcl_item_no, po_no, line_qty,
                received_qty, picked_qty, put_away_qty, date_code, org_id, sub_inventory_code,
                scan_status, scan_qty, scanned_by, scanned_at)
        VALUES (${`cn-rst-item-${batchNo}`}, ${`cn-rst-inv-${batchNo}`}, 'RK73B1JTTD181G', 'WCL/181G', 'PO-1', 100,
                100, 10, 20, '2641', 2, 'STORE1',
                'ok', 100, (SELECT id FROM users WHERE username = 'operator'), now())`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_cn_scan_events (id, order_id, qty, takes, scanned_by, scanned_at)
        VALUES (${`cn-rst-evt-${batchNo}`}, ${orderId}, 100,
                ${JSON.stringify([{ itemId: `cn-rst-item-${batchNo}`, qty: 100 }])}::jsonb,
                (SELECT id FROM users WHERE username = 'operator'), now())`
  );
  await client.db.execute(
    sql`INSERT INTO put_away_tasks_cn (id, receiving_order_cn_id, org_id, sub_inventory_code, status)
        VALUES (${`cn-rst-task-${batchNo}`}, ${orderId}, 2, 'STORE1', 'pending')`
  );
  return orderId;
}

test("cn reset: 404 for an unknown batchNo", async () => {
  const res = await req(`/admin/receiving-cn/orders/NO-SUCH-BATCH/reset`, { method: "POST" });
  assert.equal(res.status, 404);
  assert.match(await res.text(), /receiving_cn_order_not_found/);
});

test("cn reset: 409 for a clear order", async () => {
  const batchNo = "TE-RST-CLEAR";
  await seedCnOrder(batchNo, "clear");
  const res = await req(`/admin/receiving-cn/orders/${batchNo}/reset`, { method: "POST" });
  assert.equal(res.status, 409);
  assert.match(await res.text(), /order_already_clear/);
});

test("cn reset: scanning order back to pending — scan columns cleared, events + put-away task deleted", async () => {
  const batchNo = "TE-RST-HAPPY";
  const orderId = await seedCnOrder(batchNo);

  const res = await req(`/admin/receiving-cn/orders/${batchNo}/reset`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    { id: body.id, batchNo: body.batchNo, previousStatus: body.previousStatus },
    { id: orderId, batchNo, previousStatus: "scanning" }
  );

  const order = (await queryGet<{ status: string; arrivedAt: Date | null; arrivedBy: string | null }>(
    client.db,
    sql`SELECT status, arrived_at AS "arrivedAt", arrived_by AS "arrivedBy" FROM receiving_orders_cn WHERE id = ${orderId}`
  ))!;
  assert.equal(order.status, "pending");
  assert.equal(order.arrivedAt, null);
  assert.equal(order.arrivedBy, null);

  const item = (await queryGet<{
    scanStatus: string | null;
    scanQty: number | null;
    scannedBy: string | null;
    receivedQty: number;
    pickedQty: number;
    putAwayQty: number;
  }>(
    client.db,
    sql`SELECT scan_status AS "scanStatus", scan_qty AS "scanQty", scanned_by AS "scannedBy",
               received_qty AS "receivedQty", picked_qty AS "pickedQty", put_away_qty AS "putAwayQty"
        FROM receiving_invoice_items_cn WHERE id = ${`cn-rst-item-${batchNo}`}`
  ))!;
  assert.equal(item.scanStatus, null);
  assert.equal(item.scanQty, null);
  assert.equal(item.scannedBy, null);
  assert.equal(item.receivedQty, 0);
  assert.equal(item.pickedQty, 0);
  assert.equal(item.putAwayQty, 0);

  const events = (await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM receiving_cn_scan_events WHERE order_id = ${orderId}`
  ))!.n;
  assert.equal(events, 0, "scan events deleted");
  const tasks = (await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM put_away_tasks_cn WHERE receiving_order_cn_id = ${orderId}`
  ))!.n;
  assert.equal(tasks, 0, "put-away task deleted");

  const log = (await queryGet<{ fromState: string; toState: string; reset: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", metadata->>'reset' AS "reset"
        FROM transaction_logs WHERE entity_type = 'receiving_order_cn' AND entity_id = ${orderId}
        ORDER BY created_date DESC LIMIT 1`
  ))!;
  assert.equal(log.fromState, "scanning");
  assert.equal(log.toState, "pending");
  assert.equal(log.reset, "true");
});

test("cn reset: in_hand order resets too (only clear is guarded)", async () => {
  const batchNo = "TE-RST-INHAND";
  await seedCnOrder(batchNo, "in_hand");
  const res = await req(`/admin/receiving-cn/orders/${batchNo}/reset`, { method: "POST" });
  assert.equal(res.status, 200);
  const order = (await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM receiving_orders_cn WHERE id = ${`cn-rst-${batchNo}`}`
  ))!;
  assert.equal(order.status, "pending");
});
