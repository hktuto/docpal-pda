// Internal transfer allocation engine + assignment (spec
// 2026-11-10-internal-transfer-admin-allocate-design.md). Fixtures build on
// the demo world (reseed per test) + direct inserts into the
// internal_transfer_* tables (created by migration 0017; not in the seed
// ALL_TABLES wipe, so they are cleared per test — same pattern as
// internalTransfer.test.ts).

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { HTTPException } from "hono/http-exception";
import {
  allocateForInternalTransferOrder,
  addManualInternalTransferAllocation,
  addManualInternalTransferAllocations,
  removeInternalTransferAllocation,
} from "./internalTransferAllocate.js";
import { assignTransferPickingOrder } from "./internalTransfer.js";
import { allocateForPickingOrder, removePickingAllocation } from "./allocate.js";
import { confirmReceivingArrival } from "./receiving.js";
import {
  _setPickingFromSubinventoryOrgsForTests,
  _setReceivingSubInventoryRulesForTests,
  _resetFlowConfigForTests,
} from "../config.js";

let client: TestDb;
let ACTOR: string;
let LOT_18: string; // demo lot — part RK73H1JTTD1002F, dc 2603, 1000, org 2/STORE1

async function idOf(q: ReturnType<typeof sql>): Promise<string> {
  const rows = await client.db.execute(q);
  return (rows[0] as any).id as string;
}

before(async () => {
  client = await setupTestDb();
  ACTOR = await idOf(sql`SELECT id FROM users WHERE username = 'operator'`);
  LOT_18 = await idOf(sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0001' AND part_no = 'RK73H1JTTD1002F'`);
});

beforeEach(async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM internal_transfer_allocations`);
  await client.db.execute(sql`DELETE FROM internal_transfer_items`);
  await client.db.execute(sql`DELETE FROM internal_transfer_orders`);
  // hermetic world: no demo picking demand competing for the lots
  await client.db.execute(sql`DELETE FROM picking_orders`);
});

async function insertTransfer(
  orderNo: string,
  opts: { fromOrgId?: number; fromSub?: string; toOrgId?: number; status?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await client.db.execute(sql`
    INSERT INTO internal_transfer_orders (id, order_no, from_org_id, from_sub_inventory_code, to_org_id, status, priority_seq, created_date, last_update_date)
    VALUES (${id}, ${orderNo}, ${opts.fromOrgId ?? 2}, ${opts.fromSub ?? "STORE1"}, ${opts.toOrgId ?? 5}, ${opts.status ?? "pending"}, 1, now(), now())`);
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
  status = "pending",
  sub = "STORE1"
): Promise<{ orderId: string; itemId: string }> {
  const orderId = randomUUID();
  const itemId = randomUUID();
  await client.db.execute(sql`
    INSERT INTO picking_orders (id, order_no, customer_code, org_id, sub_inventory_code, status, priority_seq, created_date, last_update_date)
    VALUES (${orderId}, ${orderNo}, 'ACME', ${orgId}, ${sub}, ${status}, 1, now(), now())`);
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

test("reallocate: shelf FIFO from the from_ partition, counters + status maintained, idempotent", async () => {
  const transferId = await insertTransfer("ITO-A1");
  const item1 = await insertTransferItem(transferId, "RK73H1JTTD1002F", 600);
  const item2 = await insertTransferItem(transferId, "RK73H1JTTD4702F", 250); // only 200 on shelf (LOT_29)

  const s = await allocateForInternalTransferOrder(client.db, transferId);
  assert.equal(s.demands, 2);
  assert.equal(s.fullyAllocated, 1);
  assert.equal(s.partiallyAllocated, 1);
  assert.equal(s.allocationsCreated, 2);
  assert.equal(s.changed, true);

  const rows = await client.db.execute(sql`
    SELECT transfer_item_id AS item, inventory_lot_id AS lot, qty FROM internal_transfer_allocations
    WHERE transfer_item_id IN (${item1}, ${item2}) ORDER BY qty DESC`);
  assert.deepEqual(
    rows.map((r: any) => [r.item, r.lot, Number(r.qty)]),
    [
      [item1, LOT_18, 600],
      [item2, await idOf(sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0002' AND part_no = 'RK73H1JTTD4702F'`), 200],
    ]
  );

  const lot = await client.db.execute(sql`SELECT allocated_qty FROM inventory_lots WHERE id = ${LOT_18}`);
  assert.equal(Number((lot[0] as any).allocated_qty), 600);

  const items = await client.db.execute(sql`
    SELECT id, allocated_qty FROM internal_transfer_items WHERE transfer_order_id = ${transferId}`);
  const byId = new Map(items.map((r: any) => [r.id, Number(r.allocated_qty)]));
  assert.equal(byId.get(item1), 600);
  assert.equal(byId.get(item2), 200);

  const order = await client.db.execute(sql`
    SELECT status, allocation_status FROM internal_transfer_orders WHERE id = ${transferId}`);
  assert.equal((order[0] as any).status, "pending"); // stage 1 never touches order status
  assert.equal((order[0] as any).allocation_status, "partial");

  const ledger = await client.db.execute(sql`
    SELECT COUNT(*)::int AS n FROM inventory_transactions WHERE reference_type = 'internal_transfer_allocation' AND txn_reason = 'recompute: reserve'`);
  assert.equal(Number((ledger[0] as any).n), 2);

  // idempotent re-run: same auto rows rebuilt → changed = false
  const s2 = await allocateForInternalTransferOrder(client.db, transferId);
  assert.equal(s2.changed, false);
  assert.equal(s2.allocationsRemoved, 2);
  assert.equal(s2.allocationsCreated, 2);
});

test("reallocate: FIFO prefers the oldest date code, partial across lots", async () => {
  // a second lot of the same part, older than LOT_18's 0326 (lexicographic FIFO)
  const oldLot = randomUUID();
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, org_id, sub_inventory_code, date_code, total_qty, allocated_qty, created_date, last_update_date)
    VALUES (${oldLot}, 'RK73H1JTTD1002F', 2, 'STORE1', '0111', 300, 0, now(), now())`);

  const transferId = await insertTransfer("ITO-FIFO");
  const item = await insertTransferItem(transferId, "RK73H1JTTD1002F", 700);

  await allocateForInternalTransferOrder(client.db, transferId);
  const rows = await client.db.execute(sql`
    SELECT inventory_lot_id AS lot, qty FROM internal_transfer_allocations
    WHERE transfer_item_id = ${item} ORDER BY created_date, id`);
  assert.deepEqual(
    rows.map((r: any) => [r.lot, Number(r.qty)]),
    [
      [oldLot, 300],
      [LOT_18, 400],
    ]
  );
});

test("reallocate: sources outside the from_ partition are never used", async () => {
  // from_ at a partition where RK73H1JTTD1002F has no stock (org 5/CHECKING
  // exists in org_info; the only lot sits at org 2/STORE1)
  const transferId = await insertTransfer("ITO-OTHER-ORG", { fromOrgId: 5, fromSub: "CHECKING" });
  const item = await insertTransferItem(transferId, "RK73H1JTTD1002F", 100);

  const s = await allocateForInternalTransferOrder(client.db, transferId);
  assert.equal(s.demands, 1);
  assert.equal(s.allocationsCreated, 0);
  assert.equal(s.fullyAllocated, 0);
  const rows = await client.db.execute(sql`SELECT allocated_qty FROM internal_transfer_items WHERE id = ${item}`);
  assert.equal(Number((rows[0] as any).allocated_qty), 0);
  const order = await client.db.execute(sql`SELECT allocation_status FROM internal_transfer_orders WHERE id = ${transferId}`);
  assert.equal((order[0] as any).allocation_status, "unallocated");
});

test("reallocate: manual pins survive the wipe and pre-cover demand", async () => {
  const transferId = await insertTransfer("ITO-PIN");
  const item = await insertTransferItem(transferId, "RK73H1JTTD1002F", 600);
  const pinId = randomUUID();
  await client.db.execute(sql`
    INSERT INTO internal_transfer_allocations (id, transfer_item_id, inventory_lot_id, qty, manual, created_date, last_update_date)
    VALUES (${pinId}, ${item}, ${LOT_18}, 100, true, now(), now())`);

  const s = await allocateForInternalTransferOrder(client.db, transferId);
  assert.equal(s.allocationsRemoved, 0); // the manual row is never wiped
  const rows = await client.db.execute(sql`
    SELECT id, qty, manual FROM internal_transfer_allocations WHERE transfer_item_id = ${item}`);
  assert.equal(rows.length, 2);
  const pinRow = rows.find((r: any) => r.id === pinId) as any;
  const autoRow = rows.find((r: any) => r.id !== pinId) as any;
  assert.equal(Number(pinRow.qty), 100);
  assert.equal(pinRow.manual, true);
  assert.equal(Number(autoRow.qty), 500); // demand pre-covered by the pin (600 − 100)
  assert.equal(autoRow.manual, false);
  const it = await client.db.execute(sql`SELECT allocated_qty FROM internal_transfer_items WHERE id = ${item}`);
  assert.equal(Number((it[0] as any).allocated_qty), 600);
});

test("reallocate: guards — unknown order, closed status, live work lock", async () => {
  await rejects(() => allocateForInternalTransferOrder(client.db, randomUUID()), "transfer_order_not_found");

  const closed = await insertTransfer("ITO-CLOSED", { status: "finished" });
  await insertTransferItem(closed, "RK73H1JTTD1002F", 10);
  await rejects(() => allocateForInternalTransferOrder(client.db, closed), "order_not_open");

  const locked = await insertTransfer("ITO-LOCKED");
  await insertTransferItem(locked, "RK73H1JTTD1002F", 10);
  await client.db.execute(sql`
    UPDATE internal_transfer_orders SET working_by = ${ACTOR}, working_at = now() WHERE id = ${locked}`);
  await rejects(() => allocateForInternalTransferOrder(client.db, locked), "lock_held");
});

test("shared pool: transfer reservations reduce picking availability and survive picking runs", async () => {
  const transferId = await insertTransfer("ITO-SHARED");
  const item = await insertTransferItem(transferId, "RK73H1JTTD1002F", 600);
  await allocateForInternalTransferOrder(client.db, transferId);

  // picking demand for the same part/partition: only 400 remain on the lot
  const p = await insertPickingOrder("SO-SHARED", 2, "RK73H1JTTD1002F", 1000);
  const s = await allocateForPickingOrder(client.db, p.orderId);
  assert.equal(s.fullyAllocated, 0);
  assert.equal(s.partiallyAllocated, 1);
  const pk = await client.db.execute(sql`
    SELECT COALESCE(SUM(qty), 0)::int AS q FROM allocations WHERE picking_item_id = ${p.itemId}`);
  assert.equal(Number((pk[0] as any).q), 400);
  // the transfer's rows were untouched by the picking run (separate table)
  const tr = await client.db.execute(sql`
    SELECT COALESCE(SUM(qty), 0)::int AS q FROM internal_transfer_allocations WHERE transfer_item_id = ${item}`);
  assert.equal(Number((tr[0] as any).q), 600);
});

test("shared pool: recomputeLot keeps the transfer's share after a picking-side remove", async () => {
  const p = await insertPickingOrder("SO-RM", 2, "RK73H1JTTD1002F", 400);
  await allocateForPickingOrder(client.db, p.orderId);

  const transferId = await insertTransfer("ITO-RM");
  const item = await insertTransferItem(transferId, "RK73H1JTTD1002F", 600);
  await allocateForInternalTransferOrder(client.db, transferId);

  let lot = await client.db.execute(sql`SELECT allocated_qty FROM inventory_lots WHERE id = ${LOT_18}`);
  assert.equal(Number((lot[0] as any).allocated_qty), 1000);

  const allocId = await idOf(sql`SELECT id FROM allocations WHERE picking_item_id = ${p.itemId}`);
  await removePickingAllocation(client.db, p.orderId, p.itemId, allocId, ACTOR);

  // the picking release recomputed the lot counter from BOTH tables — the
  // transfer's 600 must survive (was a Σ allocations-only recompute before)
  lot = await client.db.execute(sql`SELECT allocated_qty FROM inventory_lots WHERE id = ${LOT_18}`);
  assert.equal(Number((lot[0] as any).allocated_qty), 600);
});

test("shared pool: dock stock is never double-booked across the two engines", async () => {
  const receivingOrderId = await idOf(sql`SELECT id FROM receiving_orders WHERE batch_no = '100003'`);
  const invoiceId = await idOf(sql`SELECT id FROM receiving_invoices WHERE receiving_order_id = ${receivingOrderId}`);
  for (let i = 1; i <= 2; i++) {
    await client.db.execute(sql`
      INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_no, wcl_item_no, po_no, po_line, line_qty, ctn_no, date_code, org_id, sub_inventory_code)
      VALUES (${randomUUID()}, ${invoiceId}, 'IT-DOCK-PART', 'IT-DOCK-PART', 'PO-IT-1', ${String(i)}, 1000, ${`IT-B${i}`}, '2610', 2, 'STORE1')`);
  }
  // confirm with no picking demand alive → the dock stays free (the scoped
  // run only knows picking demand; transfer demand is not its concern)
  await confirmReceivingArrival(client.db, receivingOrderId, ACTOR);

  const transferId = await insertTransfer("ITO-DOCK");
  const item = await insertTransferItem(transferId, "IT-DOCK-PART", 1500);
  await allocateForInternalTransferOrder(client.db, transferId);
  const tr = await client.db.execute(sql`
    SELECT COALESCE(SUM(qty), 0)::int AS q, COUNT(*)::int AS n
    FROM internal_transfer_allocations WHERE transfer_item_id = ${item}`);
  assert.equal(Number((tr[0] as any).q), 1500);
  assert.equal(Number((tr[0] as any).n), 2); // box-level rows: 1000 + 500

  // picking demand on the same dock: only 500 remain — the picking run nets
  // the transfer's rows out of dock availability (loadReceivingSources union)
  const p = await insertPickingOrder("SO-DOCK", 2, "IT-DOCK-PART", 500);
  const s = await allocateForPickingOrder(client.db, p.orderId);
  assert.equal(s.fullyAllocated, 1);
  const perBox = await client.db.execute(sql`
    SELECT rii.ctn_no AS box,
           COALESCE((SELECT SUM(qty) FROM allocations a WHERE a.receiving_invoice_item_id = rii.id), 0)::int
             + COALESCE((SELECT SUM(qty) FROM internal_transfer_allocations ita WHERE ita.receiving_invoice_item_id = rii.id), 0)::int AS held
    FROM receiving_invoice_items rii WHERE rii.part_no = 'IT-DOCK-PART' ORDER BY rii.ctn_no`);
  assert.deepEqual(
    perBox.map((r: any) => [r.box, Number(r.held)]),
    [
      ["IT-B1", 1000],
      ["IT-B2", 1000],
    ]
  );
});

test("manual add/remove: pins, caps, ledger — and availability nets both engines", async () => {
  const transferId = await insertTransfer("ITO-MANUAL");
  const item = await insertTransferItem(transferId, "RK73H1JTTD1002F", 600);
  const item2 = await insertTransferItem(transferId, "RK73H1JTTD1002F", 600);

  const added = await addManualInternalTransferAllocation(client.db, transferId, item, { qty: 200, inventoryLotId: LOT_18 }, ACTOR);
  assert.equal(added.qty, 200);
  let it = await client.db.execute(sql`SELECT allocated_qty FROM internal_transfer_items WHERE id = ${item}`);
  assert.equal(Number((it[0] as any).allocated_qty), 200);
  let lot = await client.db.execute(sql`SELECT allocated_qty FROM inventory_lots WHERE id = ${LOT_18}`);
  assert.equal(Number((lot[0] as any).allocated_qty), 200);

  // over_allocation: Σ allocations would exceed the item's open qty (200 + 500 > 600)
  await rejects(
    () => addManualInternalTransferAllocation(client.db, transferId, item, { qty: 500, inventoryLotId: LOT_18 }, ACTOR),
    "over_allocation"
  );
  // insufficient_available: the lot only has 800 left, the pin asks 900
  await rejects(
    () => addManualInternalTransferAllocation(client.db, transferId, item2, { qty: 900, inventoryLotId: LOT_18 }, ACTOR),
    "insufficient_available"
  );
  // 400 / source_required mirror the picking action
  await rejects(
    () => addManualInternalTransferAllocation(client.db, transferId, item, { qty: 0, inventoryLotId: LOT_18 }, ACTOR),
    "invalid_qty"
  );

  const removed = await removeInternalTransferAllocation(client.db, transferId, item, added.allocationId, ACTOR);
  assert.deepEqual(removed, { removed: 1, qty: 200 });
  it = await client.db.execute(sql`SELECT allocated_qty FROM internal_transfer_items WHERE id = ${item}`);
  assert.equal(Number((it[0] as any).allocated_qty), 0);
  lot = await client.db.execute(sql`SELECT allocated_qty FROM inventory_lots WHERE id = ${LOT_18}`);
  assert.equal(Number((lot[0] as any).allocated_qty), 0);
  const ledger = await client.db.execute(sql`
    SELECT COUNT(*)::int AS n FROM inventory_transactions
    WHERE reference_type = 'internal_transfer_allocation' AND txn_reason = 'admin: manual allocation'`);
  assert.equal(Number((ledger[0] as any).n), 1);
});

test("manual batch: two pins succeed; over remaining rolls the whole set back", async () => {
  const transferId = await insertTransfer("ITO-BATCH");
  const item = await insertTransferItem(transferId, "RK73H1JTTD1002F", 600);

  const ok = await addManualInternalTransferAllocations(
    client.db,
    transferId,
    item,
    [
      { qty: 100, inventoryLotId: LOT_18 },
      { qty: 200, inventoryLotId: LOT_18 },
    ],
    ACTOR
  );
  assert.equal(ok.totalQty, 300);
  assert.equal(ok.allocations.length, 2);
  let it = await client.db.execute(sql`SELECT allocated_qty FROM internal_transfer_items WHERE id = ${item}`);
  assert.equal(Number((it[0] as any).allocated_qty), 300);
  let rows = await client.db.execute(sql`
    SELECT qty FROM internal_transfer_allocations WHERE transfer_item_id = ${item} ORDER BY qty`);
  assert.deepEqual(
    rows.map((r: any) => Number(r.qty)),
    [100, 200]
  );

  // wipe and prove all-or-nothing: second row would push past open qty
  await client.db.execute(sql`DELETE FROM internal_transfer_allocations WHERE transfer_item_id = ${item}`);
  await client.db.execute(sql`UPDATE internal_transfer_items SET allocated_qty = 0 WHERE id = ${item}`);
  await client.db.execute(sql`UPDATE inventory_lots SET allocated_qty = 0 WHERE id = ${LOT_18}`);

  await rejects(
    () =>
      addManualInternalTransferAllocations(
        client.db,
        transferId,
        item,
        [
          { qty: 400, inventoryLotId: LOT_18 },
          { qty: 400, inventoryLotId: LOT_18 },
        ],
        ACTOR
      ),
    "over_allocation"
  );
  it = await client.db.execute(sql`SELECT allocated_qty FROM internal_transfer_items WHERE id = ${item}`);
  assert.equal(Number((it[0] as any).allocated_qty), 0);
  rows = await client.db.execute(sql`
    SELECT COUNT(*)::int AS n FROM internal_transfer_allocations WHERE transfer_item_id = ${item}`);
  assert.equal(Number((rows[0] as any).n), 0);
});

test("assign delegated picking order: org match, open window, editable window, clear", async () => {
  const transferId = await insertTransfer("ITO-ASSIGN", { toOrgId: 5 });
  const sameOrg = await insertPickingOrder("SO-TO5", 5, "RK73H1JTTD1002F", 10, "pending", "CHECKING");
  const otherOrg = await insertPickingOrder("SO-TO2", 2, "RK73H1JTTD1002F", 10);
  const shipped = await insertPickingOrder("SO-SHIP", 5, "RK73H1JTTD1002F", 10, "shipped", "CHECKING");

  await rejects(
    () => assignTransferPickingOrder(client.db, transferId, otherOrg.orderId, ACTOR),
    "org_mismatch"
  );
  await rejects(
    () => assignTransferPickingOrder(client.db, transferId, shipped.orderId, ACTOR),
    "picking_order_not_open"
  );
  await rejects(() => assignTransferPickingOrder(client.db, randomUUID(), sameOrg.orderId, ACTOR), "transfer_order_not_found");
  await rejects(() => assignTransferPickingOrder(client.db, transferId, randomUUID(), ACTOR), "picking_order_not_found");

  const res = await assignTransferPickingOrder(client.db, transferId, sameOrg.orderId, ACTOR);
  assert.deepEqual(res, { pickingOrderId: sameOrg.orderId, pickingOrderNo: "SO-TO5" });
  let order = await client.db.execute(sql`SELECT picking_order_id FROM internal_transfer_orders WHERE id = ${transferId}`);
  assert.equal((order[0] as any).picking_order_id, sameOrg.orderId);

  const cleared = await assignTransferPickingOrder(client.db, transferId, null, ACTOR);
  assert.deepEqual(cleared, { pickingOrderId: null, pickingOrderNo: null });
  order = await client.db.execute(sql`SELECT picking_order_id FROM internal_transfer_orders WHERE id = ${transferId}`);
  assert.equal((order[0] as any).picking_order_id, null);

  // a transfer past pending/allocated is frozen
  await client.db.execute(sql`UPDATE internal_transfer_orders SET status = 'picking' WHERE id = ${transferId}`);
  await rejects(
    () => assignTransferPickingOrder(client.db, transferId, sameOrg.orderId, ACTOR),
    "transfer_not_editable"
  );
});

test("detail payload embeds item allocations and the assigned picking order", async () => {
  const transferId = await insertTransfer("ITO-DETAIL");
  const item = await insertTransferItem(transferId, "RK73H1JTTD1002F", 100);
  await client.db.execute(sql`
    INSERT INTO internal_transfer_allocations (id, transfer_item_id, inventory_lot_id, qty, created_date, last_update_date)
    VALUES (${randomUUID()}, ${item}, ${LOT_18}, 100, now(), now())`);
  const p = await insertPickingOrder("SO-DET", 5, "RK73H1JTTD1002F", 10, "pending", "CHECKING");
  await assignTransferPickingOrder(client.db, transferId, p.orderId, ACTOR);

  const { getInternalTransferOrder } = await import("./internalTransfer.js");
  const detail = await getInternalTransferOrder(client.db, transferId);
  assert.ok(detail);
  assert.equal((detail.order as any).pickingOrderNo, "SO-DET");
  const items = detail.items as any[];
  assert.equal(items.length, 1);
  assert.equal(items[0].allocations.length, 1);
  const a = items[0].allocations[0];
  assert.equal(a.qty, 100);
  assert.equal(a.sourceType, "lot");
  // picking-shaped embeds: the items table reuses the shared Allocations*Row
  // + AllocationDetail components on these fields
  assert.equal(a.lot.totalQty, 1000);
  assert.equal(a.lot.shelfCode, "A0101");
  assert.equal(a.receiving, null);
  assert.equal(a.outdated, true); // LOT_18's dc 0326 is far past the 2-year threshold
});

test("source scope: a foreign from_org_id converts via the from_subinventory → Org rule (tn parity)", async () => {
  // The synced pair (7, SZHK2) holds no stock; SZHK2 is listed under the
  // org-143 group and org 143's receiving rule defaults to STORE1 — the
  // demand must search (143, STORE1), mirroring the picking-side tn lines
  // (resolveDemandLocation).
  _setPickingFromSubinventoryOrgsForTests([{ orgId: 143, fromSubinventories: ["SZHK2"] }]);
  _setReceivingSubInventoryRulesForTests([{ orgIds: [143], patterns: [], default: "STORE1" }]);
  try {
    await client.db.execute(sql`
      INSERT INTO org_info (id, org_id, secondary_inventory_name, creation_date, last_update_date)
      VALUES ('ORGINFO-7-SZHK2', 7, 'SZHK2', now(), now()),
             ('ORGINFO-143-STORE1', 143, 'STORE1', now(), now())
      ON CONFLICT (org_id, secondary_inventory_name) DO NOTHING`);
    const srcLot = randomUUID();
    await client.db.execute(sql`
      INSERT INTO inventory_lots (id, part_no, org_id, sub_inventory_code, date_code, total_qty, allocated_qty, created_date, last_update_date)
      VALUES (${srcLot}, 'RK73H1JTTD1002F', 143, 'STORE1', '0326', 400, 0, now(), now())`);
    const rawLot = randomUUID();
    await client.db.execute(sql`
      INSERT INTO inventory_lots (id, part_no, org_id, sub_inventory_code, date_code, total_qty, allocated_qty, created_date, last_update_date)
      VALUES (${rawLot}, 'RK73H1JTTD1002F', 7, 'SZHK2', '0111', 400, 0, now(), now())`);
    const transferId = await insertTransfer("ITO-SCOPE", { fromOrgId: 7, fromSub: "SZHK2" });
    const itemId = await insertTransferItem(transferId, "RK73H1JTTD1002F", 300);

    const res = await allocateForInternalTransferOrder(client.db, transferId);
    assert.equal(res.allocationsCreated, 1);
    const rows = await client.db.execute(sql`
      SELECT inventory_lot_id AS lot FROM internal_transfer_allocations WHERE transfer_item_id = ${itemId}`);
    assert.equal((rows[0] as any).lot, srcLot); // converted partition, not the raw synced pair
  } finally {
    _resetFlowConfigForTests();
  }
});

test("source scope: a pair already at the rule's own org stays raw (local orders unaffected)", async () => {
  // (2, STORE1) is HK's own partition and STORE1 is listed under the org-2
  // group — the org matches, so the pair must stay raw even though the
  // receiving rule would say DEFAULT (the tn conversion applies to foreign
  // offices only; local synced orders keep working with zero config care).
  _setPickingFromSubinventoryOrgsForTests([{ orgId: 2, fromSubinventories: ["STORE1"] }]);
  _setReceivingSubInventoryRulesForTests([{ orgIds: [2], patterns: [], default: "DEFAULT" }]);
  try {
    const transferId = await insertTransfer("ITO-LOCAL", { fromOrgId: 2, fromSub: "STORE1" });
    const itemId = await insertTransferItem(transferId, "RK73H1JTTD1002F", 300);
    const res = await allocateForInternalTransferOrder(client.db, transferId);
    assert.equal(res.allocationsCreated, 1);
    const rows = await client.db.execute(sql`
      SELECT inventory_lot_id AS lot FROM internal_transfer_allocations WHERE transfer_item_id = ${itemId}`);
    assert.equal((rows[0] as any).lot, LOT_18);
  } finally {
    _resetFlowConfigForTests();
  }
});
