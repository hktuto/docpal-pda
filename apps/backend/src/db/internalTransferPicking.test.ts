// Internal transfer PDA flow (spec
// 2026-11-10-internal-transfer-pda-picking-design.md): queue gating, pick
// scans, package removal, finish branches, native shelving, admin
// confirm/unconfirm, work locks. Same fixture world as
// internalTransferAllocate.test.ts (demo reseed + direct transfer inserts).

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { HTTPException } from "hono/http-exception";
import { allocateForInternalTransferOrder } from "./internalTransferAllocate.js";
import { assignTransferPickingOrder } from "./internalTransfer.js";
import {
  listInternalTransferQueue,
  getInternalTransferPickingDetail,
  acquireInternalTransferWorkLock,
  releaseInternalTransferWorkLock,
  scanInternalTransferItem,
  removeInternalTransferPackage,
  reportInternalTransferIssue,
  finishInternalTransferOrder,
  shelveInternalTransferPackages,
  overrideInternalTransferStatus,
} from "./internalTransferPicking.js";

let client: TestDb;
let ACTOR: string;
let OTHER: string;
let LOT_18: string; // demo lot — part RK73H1JTTD1002F, 1000, org 2/STORE1, shelf A0101

async function idOf(q: ReturnType<typeof sql>): Promise<string> {
  const rows = await client.db.execute(q);
  return (rows[0] as any).id as string;
}

before(async () => {
  client = await setupTestDb();
  ACTOR = await idOf(sql`SELECT id FROM users WHERE username = 'operator'`);
  OTHER = await idOf(sql`SELECT id FROM users WHERE username <> 'operator' ORDER BY id LIMIT 1`);
  LOT_18 = await idOf(sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0001' AND part_no = 'RK73H1JTTD1002F'`);
});

beforeEach(async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM internal_transfer_allocations`);
  await client.db.execute(sql`DELETE FROM internal_transfer_packages`);
  await client.db.execute(sql`DELETE FROM internal_transfer_items`);
  await client.db.execute(sql`DELETE FROM internal_transfer_orders`);
  await client.db.execute(sql`DELETE FROM picking_orders`);
  // put_away_tasks rows cascade from their transfer order, but reseed may
  // leave orphan-free receiving tasks — clear ours only.
  await client.db.execute(sql`DELETE FROM put_away_tasks WHERE internal_transfer_order_id IS NOT NULL`);
});

async function insertTransfer(orderNo: string, opts: { toOrgId?: number } = {}): Promise<string> {
  const id = randomUUID();
  await client.db.execute(sql`
    INSERT INTO internal_transfer_orders (id, order_no, from_org_id, from_sub_inventory_code, to_org_id, status, priority_seq, created_date, last_update_date)
    VALUES (${id}, ${orderNo}, 2, 'STORE1', ${opts.toOrgId ?? 5}, 'pending', 1, now(), now())`);
  return id;
}

async function insertTransferItem(transferOrderId: string, partNo: string, qty: number): Promise<string> {
  const id = randomUUID();
  await client.db.execute(sql`
    INSERT INTO internal_transfer_items (id, transfer_order_id, part_no, qty, line_number, created_date, last_update_date)
    VALUES (${id}, ${transferOrderId}, ${partNo}, ${qty}, 1, now(), now())`);
  return id;
}

async function insertPickingOrder(
  orderNo: string,
  orgId: number,
  partNo: string,
  qty: number,
  sub = "STORE1"
): Promise<{ orderId: string; itemId: string }> {
  const orderId = randomUUID();
  const itemId = randomUUID();
  await client.db.execute(sql`
    INSERT INTO picking_orders (id, order_no, customer_code, org_id, sub_inventory_code, status, priority_seq, created_date, last_update_date)
    VALUES (${orderId}, ${orderNo}, 'ACME', ${orgId}, ${sub}, 'pending', 1, now(), now())`);
  await client.db.execute(sql`
    INSERT INTO picking_items (id, picking_order_id, part_no, qty, line_id, line_number, shipment_number, created_date, last_update_date)
    VALUES (${itemId}, ${orderId}, ${partNo}, ${qty}, 1, 1, 1, now(), now())`);
  return { orderId, itemId };
}

async function rejects(fn: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${err}`);
    assert.equal(err.message, message);
    return;
  }
  assert.fail(`expected HTTPException ${message}`);
}

/** Fully pick one transfer item off its (single) allocation. */
async function pickFully(transferOrderId: string, itemId: string): Promise<string[]> {
  const alloc = await idOf(
    sql`SELECT ita.id AS id FROM internal_transfer_allocations ita WHERE ita.transfer_item_id = ${itemId} LIMIT 1`
  );
  const qty = (await client.db.execute(sql`SELECT qty FROM internal_transfer_items WHERE id = ${itemId}`))[0] as any;
  const res = await scanInternalTransferItem(client.db, itemId, {
    actorId: ACTOR,
    allocationId: alloc,
    qty: Number(qty.qty),
  });
  return res.packageIds;
}

test("queue + confirm gate: pending stays admin-only, confirm/unconfirm moves the order in and out", async () => {
  const transferId = await insertTransfer("ITO-Q1");
  await insertTransferItem(transferId, "RK73H1JTTD1002F", 100);

  let queue = await listInternalTransferQueue(client.db);
  assert.equal(queue.some((r) => r.id === transferId), false); // unconfirmed → not pickable

  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "allocated", actorId: ACTOR });
  queue = await listInternalTransferQueue(client.db);
  assert.ok(queue.some((r) => r.id === transferId));

  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "pending", actorId: ACTOR });
  queue = await listInternalTransferQueue(client.db);
  assert.equal(queue.some((r) => r.id === transferId), false);

  // the override is deliberately narrow: from `picking` neither direction moves
  await client.db.execute(sql`UPDATE internal_transfer_orders SET status = 'picking' WHERE id = ${transferId}`);
  await rejects(
    () => overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "allocated", actorId: ACTOR }),
    "transfer_not_pending"
  );
  await rejects(
    () => overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "pending", actorId: ACTOR }),
    "transfer_not_allocated"
  );
});

test("scan: allocation-capped pick, package + PICK ledger pair, lot decremented, status transitions", async () => {
  const transferId = await insertTransfer("ITO-SCAN");
  const itemId = await insertTransferItem(transferId, "RK73H1JTTD1002F", 100);
  await allocateForInternalTransferOrder(client.db, transferId);
  const allocId = await idOf(
    sql`SELECT ita.id AS id FROM internal_transfer_allocations ita WHERE ita.transfer_item_id = ${itemId} LIMIT 1`
  );

  // unconfirmed orders refuse scans
  await rejects(
    () => scanInternalTransferItem(client.db, itemId, { actorId: ACTOR, allocationId: allocId, qty: 10 }),
    "transfer_not_confirmed"
  );
  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "allocated", actorId: ACTOR });

  const res = await scanInternalTransferItem(client.db, itemId, { actorId: ACTOR, allocationId: allocId, qty: 60 });
  assert.equal(res.packageIds.length, 1);
  let lot = await client.db.execute(sql`SELECT total_qty, allocated_qty FROM inventory_lots WHERE id = ${LOT_18}`);
  assert.equal(Number((lot[0] as any).total_qty), 940);
  assert.equal(Number((lot[0] as any).allocated_qty), 40); // union recompute after the shrink
  let item = await client.db.execute(sql`SELECT picked_qty, allocated_qty, status FROM internal_transfer_items WHERE id = ${itemId}`);
  assert.deepEqual(
    { picked: Number((item[0] as any).picked_qty), alloc: Number((item[0] as any).allocated_qty), status: (item[0] as any).status },
    { picked: 60, alloc: 40, status: "pending" }
  );
  let order = await client.db.execute(sql`SELECT status FROM internal_transfer_orders WHERE id = ${transferId}`);
  assert.equal((order[0] as any).status, "picking");
  const ledger = await client.db.execute(sql`
    SELECT qty_type, qty_delta FROM inventory_transactions
    WHERE reference_type = 'internal_transfer_item' AND txn_reason = 'internal transfer: pick'`);
  assert.deepEqual(
    ledger.map((r: any) => [r.qty_type, Number(r.qty_delta)]),
    [
      ["reserved", -60],
      ["on_hand", -60],
    ]
  );

  // caps: over the (shrunk) allocation, and over the item qty
  await rejects(
    () => scanInternalTransferItem(client.db, itemId, { actorId: ACTOR, allocationId: allocId, qty: 41 }),
    "scanned_qty_exceeds_allocation"
  );
  const res2 = await scanInternalTransferItem(client.db, itemId, { actorId: ACTOR, allocationId: allocId, qty: 40 });
  assert.equal(res2.packageIds.length, 1);
  item = await client.db.execute(sql`SELECT picked_qty, status FROM internal_transfer_items WHERE id = ${itemId}`);
  assert.deepEqual({ picked: Number((item[0] as any).picked_qty), status: (item[0] as any).status }, { picked: 100, status: "picked" });
  lot = await client.db.execute(sql`SELECT total_qty, allocated_qty FROM inventory_lots WHERE id = ${LOT_18}`);
  assert.equal(Number((lot[0] as any).total_qty), 900);
  assert.equal(Number((lot[0] as any).allocated_qty), 0);
  void order;
});

test("package removal: restores the lot + allocation, un-picks", async () => {
  const transferId = await insertTransfer("ITO-UNPICK");
  const itemId = await insertTransferItem(transferId, "RK73H1JTTD1002F", 100);
  await allocateForInternalTransferOrder(client.db, transferId);
  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "allocated", actorId: ACTOR });
  const packageIds = await pickFully(transferId, itemId);

  await removeInternalTransferPackage(client.db, { packageId: packageIds[0], actorId: ACTOR });
  const lot = await client.db.execute(sql`SELECT total_qty, allocated_qty FROM inventory_lots WHERE id = ${LOT_18}`);
  assert.equal(Number((lot[0] as any).total_qty), 1000);
  assert.equal(Number((lot[0] as any).allocated_qty), 100); // bumped back as a manual pin
  const item = await client.db.execute(sql`SELECT picked_qty, allocated_qty FROM internal_transfer_items WHERE id = ${itemId}`);
  assert.deepEqual({ picked: Number((item[0] as any).picked_qty), alloc: Number((item[0] as any).allocated_qty) }, { picked: 0, alloc: 100 });
  const pkgs = await client.db.execute(sql`SELECT COUNT(*)::int AS n FROM internal_transfer_packages WHERE transfer_order_id = ${transferId}`);
  assert.equal(Number((pkgs[0] as any).n), 0);
});

test("finish linked: unshelved lots land at the delegated order's pair and feed its allocation", async () => {
  const transferId = await insertTransfer("ITO-FINISH-LINKED");
  const itemId = await insertTransferItem(transferId, "RK73H1JTTD1002F", 100);
  await allocateForInternalTransferOrder(client.db, transferId);
  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "allocated", actorId: ACTOR });
  const delegated = await insertPickingOrder("SO-FEED", 5, "RK73H1JTTD1002F", 50, "CHECKING");
  await assignTransferPickingOrder(client.db, transferId, delegated.orderId, ACTOR);

  // finish guard: not everything picked and no issue recorded
  await rejects(() => finishInternalTransferOrder(client.db, transferId, ACTOR), "not_all_items_picked");

  await pickFully(transferId, itemId);
  const result = await finishInternalTransferOrder(client.db, transferId, ACTOR);
  assert.equal(result.status, "finished");
  assert.ok(result.allocation, "the delegated re-allocation should have run");
  assert.equal(result.allocation!.fullyAllocated, 1);

  // the stock materialized at the DELEGATED order's pair (5/CHECKING),
  // unshelved, and the delegated item reserved it
  const lots = await client.db.execute(sql`
    SELECT total_qty, shelf_code, org_id, sub_inventory_code FROM inventory_lots
    WHERE part_no = 'RK73H1JTTD1002F' AND org_id = 5`);
  assert.equal(lots.length, 1);
  assert.equal(Number((lots[0] as any).total_qty), 100);
  assert.equal((lots[0] as any).shelf_code, null);
  assert.equal((lots[0] as any).sub_inventory_code, "CHECKING");
  const delegatedAlloc = await client.db.execute(sql`
    SELECT a.inventory_lot_id AS lot, a.qty FROM allocations a WHERE a.picking_item_id = ${delegated.itemId}`);
  assert.equal(delegatedAlloc.length, 1);
  assert.equal(Number((delegatedAlloc[0] as any).qty), 50);

  const arrive = await client.db.execute(sql`
    SELECT COUNT(*)::int AS n FROM inventory_transactions
    WHERE txn_type = 'ADJUST' AND txn_reason = 'internal transfer: arrive'`);
  assert.equal(Number((arrive[0] as any).n), 1);
});

test("finish unlinked: put-away task + native shelving to the last package", async () => {
  const transferId = await insertTransfer("ITO-FINISH-UNLINKED");
  const itemId = await insertTransferItem(transferId, "RK73H1JTTD1002F", 100);
  await allocateForInternalTransferOrder(client.db, transferId);
  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "allocated", actorId: ACTOR });
  await pickFully(transferId, itemId);

  const result = await finishInternalTransferOrder(client.db, transferId, ACTOR);
  assert.equal(result.allocation, null);
  let task = await client.db.execute(sql`
    SELECT id, status, org_id FROM put_away_tasks WHERE internal_transfer_order_id = ${transferId}`);
  assert.equal(task.length, 1);
  assert.equal((task[0] as any).status, "pending");
  assert.equal((task[0] as any).org_id, 5);

  // queue lists the finished order as put-away pending
  let queue = await listInternalTransferQueue(client.db);
  const row = queue.find((r) => r.id === transferId);
  assert.ok(row);
  assert.equal(row!.unshelvedQty, 100);

  // shelving before finish / unknown shelf guards
  await rejects(
    () => shelveInternalTransferPackages(client.db, transferId, { actorId: ACTOR, partNo: "RK73H1JTTD1002F", shelfCode: "NO-SUCH-SHELF" }),
    "shelf_not_found"
  );
  await rejects(
    () => shelveInternalTransferPackages(client.db, transferId, { actorId: ACTOR, partNo: "NO-SUCH-PART", shelfCode: "A0101" }),
    "no_unshelved_packages_for_part"
  );

  const shelved = await shelveInternalTransferPackages(client.db, transferId, {
    actorId: ACTOR,
    partNo: "RK73H1JTTD1002F",
    shelfCode: "A0101",
  });
  assert.deepEqual(shelved, { shelved: 100, taskCompleted: true });

  const lots = await client.db.execute(sql`
    SELECT total_qty, shelf_code, org_id FROM inventory_lots
    WHERE part_no = 'RK73H1JTTD1002F' AND org_id = 5 AND shelf_code = 'A0101'`);
  assert.equal(lots.length, 1);
  assert.equal(Number((lots[0] as any).total_qty), 100);
  const pkg = await client.db.execute(sql`
    SELECT shelf_code FROM internal_transfer_packages WHERE transfer_order_id = ${transferId}`);
  assert.equal((pkg[0] as any).shelf_code, "A0101");
  task = await client.db.execute(sql`
    SELECT status FROM put_away_tasks WHERE internal_transfer_order_id = ${transferId}`);
  assert.equal((task[0] as any).status, "completed");
  const putAway = await client.db.execute(sql`
    SELECT COUNT(*)::int AS n FROM inventory_transactions WHERE txn_type = 'PUT_AWAY' AND txn_reason = 'internal transfer: shelve'`);
  assert.equal(Number((putAway[0] as any).n), 1);

  queue = await listInternalTransferQueue(client.db);
  assert.equal(queue.some((r) => r.id === transferId), false); // nothing left to shelve
});

test("issue reporting: informational — satisfies the finish guard for a short transfer", async () => {
  const transferId = await insertTransfer("ITO-ISSUE");
  const itemId = await insertTransferItem(transferId, "RK73H1JTTD1002F", 100);
  await allocateForInternalTransferOrder(client.db, transferId);
  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "allocated", actorId: ACTOR });

  // partial pick, then report the shortage
  const allocId = await idOf(
    sql`SELECT ita.id AS id FROM internal_transfer_allocations ita WHERE ita.transfer_item_id = ${itemId} LIMIT 1`
  );
  await scanInternalTransferItem(client.db, itemId, { actorId: ACTOR, allocationId: allocId, qty: 60 });
  await rejects(
    () => reportInternalTransferIssue(client.db, transferId, { actorId: ACTOR, reason: "insufficient_stock" }),
    "actual_quantity_required"
  );
  await reportInternalTransferIssue(client.db, transferId, {
    actorId: ACTOR,
    reason: "insufficient_stock",
    qty: 60,
    note: "shelf short",
  });
  const order = await client.db.execute(sql`SELECT status, issue_reason, issue_qty FROM internal_transfer_orders WHERE id = ${transferId}`);
  assert.deepEqual(
    { status: (order[0] as any).status, reason: (order[0] as any).issue_reason, qty: (order[0] as any).issue_qty },
    { status: "issue", reason: "insufficient_stock", qty: 60 }
  );

  // issue is informational: picking continues and finish is allowed short
  const res = await finishInternalTransferOrder(client.db, transferId, ACTOR);
  assert.equal(res.status, "finished");
});

test("work lock: conditional claim, holder wins, confirm steals", async () => {
  const transferId = await insertTransfer("ITO-LOCK");
  await insertTransferItem(transferId, "RK73H1JTTD1002F", 10);
  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "allocated", actorId: ACTOR });

  await acquireInternalTransferWorkLock(client.db, { orderId: transferId, actorId: ACTOR });
  await rejects(
    () => acquireInternalTransferWorkLock(client.db, { orderId: transferId, actorId: OTHER }),
    "lock_held"
  );
  await releaseInternalTransferWorkLock(client.db, { orderId: transferId, actorId: OTHER }); // no-op for non-holder
  let lock = await client.db.execute(sql`SELECT working_by FROM internal_transfer_orders WHERE id = ${transferId}`);
  assert.equal((lock[0] as any).working_by, ACTOR);
  await releaseInternalTransferWorkLock(client.db, { orderId: transferId, actorId: ACTOR });
  lock = await client.db.execute(sql`SELECT working_by FROM internal_transfer_orders WHERE id = ${transferId}`);
  assert.equal((lock[0] as any).working_by, null);

  // confirm steals a stale-but-live lock (pending → allocated path re-steals)
  await acquireInternalTransferWorkLock(client.db, { orderId: transferId, actorId: OTHER });
  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "pending", actorId: ACTOR });
  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "allocated", actorId: ACTOR });
  lock = await client.db.execute(sql`SELECT working_by FROM internal_transfer_orders WHERE id = ${transferId}`);
  assert.equal((lock[0] as any).working_by, null);
});

test("PDA detail: items embed allocation guidance + packages", async () => {
  const transferId = await insertTransfer("ITO-DETAIL");
  const itemId = await insertTransferItem(transferId, "RK73H1JTTD1002F", 100);
  await allocateForInternalTransferOrder(client.db, transferId);
  await overrideInternalTransferStatus(client.db, { transferOrderId: transferId, status: "allocated", actorId: ACTOR });
  const allocId = await idOf(
    sql`SELECT ita.id AS id FROM internal_transfer_allocations ita WHERE ita.transfer_item_id = ${itemId} LIMIT 1`
  );
  await scanInternalTransferItem(client.db, itemId, { actorId: ACTOR, allocationId: allocId, qty: 40 });

  const detail = await getInternalTransferPickingDetail(client.db, transferId);
  assert.ok(detail);
  const items = detail.items as any[];
  assert.equal(items.length, 1);
  // guidance rows carry remaining qty > 0; the consumed part of the row is gone
  assert.equal(items[0].allocations.length, 1);
  assert.equal(items[0].allocations[0].qty, 60);
  const packages = detail.packages as any[];
  assert.equal(packages.length, 1);
  assert.equal(packages[0].partNo, "RK73H1JTTD1002F");
  assert.equal(packages[0].qty, 40);
});
