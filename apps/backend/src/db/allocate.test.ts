import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { allocateAll, parseDateCodeRule } from "./allocate.js";

let client: TestDb;

// Seed ids (see seed-demo-scenario.ts — resolved by business key, never a
// hardcoded UUID; the seed's deterministic ids keep them valid across reseeds)
let PO_22: string; // picking order SO-DEMO-0001 (ACME, org 2 / STORE1)
let ITEM_23: string; // SO-DEMO-0001 item — part RK73H1JTTD1002F, qty 1000
let ITEM_24: string; // SO-DEMO-0001 item — part RK73H1JTTD2202F, qty 500
let ITEM_25: string; // SO-DEMO-0001 item — part RK73B1JTTD181G, qty 300
let LOT_18: string; // BOX-H-20260701-0001 lot — part RK73H1JTTD1002F, dc 2603, 1000
let LOT_19: string; // BOX-H-20260701-0001 lot — part RK73H1JTTD2202F, dc 2603, 500
let LOT_28: string; // BOX-H-20260701-0002 lot — part RK73B1JTTD181G, dc 2604, 700
let LOT_29: string; // BOX-H-20260701-0002 lot — part RK73H1JTTD4702F, dc 2604, 200
let LOT_30: string; // BOX-H-20260701-0003 lot — part RK73H1JTTD5602F, dc 2609, 1000
let LOT_31: string; // BOX-H-20260701-0003 lot — part RK73H2ATTD2212F, dc 2609, 400

async function idOf(q: ReturnType<typeof sql>): Promise<string> {
  const rows = await client.db.execute(q);
  return (rows[0] as any).id as string;
}

before(async () => {
  client = await setupTestDb();
  PO_22 = await idOf(sql`SELECT id FROM picking_orders WHERE order_no = 'SO-DEMO-0001'`);
  ITEM_23 = await idOf(sql`SELECT id FROM picking_items WHERE picking_order_id = ${PO_22} AND part_no = 'RK73H1JTTD1002F'`);
  ITEM_24 = await idOf(sql`SELECT id FROM picking_items WHERE picking_order_id = ${PO_22} AND part_no = 'RK73H1JTTD2202F'`);
  ITEM_25 = await idOf(sql`SELECT id FROM picking_items WHERE picking_order_id = ${PO_22} AND part_no = 'RK73B1JTTD181G'`);
  LOT_18 = await idOf(sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0001' AND part_no = 'RK73H1JTTD1002F'`);
  LOT_19 = await idOf(sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0001' AND part_no = 'RK73H1JTTD2202F'`);
  LOT_28 = await idOf(sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0002' AND part_no = 'RK73B1JTTD181G'`);
  LOT_29 = await idOf(sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0002' AND part_no = 'RK73H1JTTD4702F'`);
  LOT_30 = await idOf(sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0003' AND part_no = 'RK73H1JTTD5602F'`);
  LOT_31 = await idOf(sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0003' AND part_no = 'RK73H2ATTD2212F'`);
});

test("parseDateCodeRule: exact / + / - / year-relative", () => {
  const ref = new Date("2026-07-17T00:00:00Z");
  assert.equal(parseDateCodeRule("2601")!("2601"), true);
  assert.equal(parseDateCodeRule("2601")!("2602"), false);
  assert.equal(parseDateCodeRule("DC 2601+")!("2602"), true);
  assert.equal(parseDateCodeRule("DC 2601+")!("2512"), false);
  assert.equal(parseDateCodeRule("2601-")!("2512"), true);
  assert.equal(parseDateCodeRule("2601-")!("2602"), false);
  // within 2 years of 2026-07 → threshold 2407
  assert.equal(parseDateCodeRule("less than 2 years", ref)!("2407"), true);
  assert.equal(parseDateCodeRule("less than 2 years", ref)!("2406"), false);
  assert.equal(parseDateCodeRule("more than 2 years", ref)!("2406"), true);
  assert.equal(parseDateCodeRule("more than 2 years", ref)!("2407"), false);
  assert.equal(parseDateCodeRule(null), null);
  assert.equal(parseDateCodeRule("no rule here"), null);
});

test("allocateAll: FIFO from shelf lots, updates lots + picking items", async () => {
  await reseed(client);
  // keep the demo world hermetic: drop the second demo order (SO-DEMO-0002)
  // so allocateAll only sees SO-DEMO-0001's three demands
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  const s = await allocateAll(client.db);
  assert.equal(s.demands, 3);
  assert.equal(s.fullyAllocated, 3);
  assert.equal(s.allocationsCreated, 3);

  const rows = await client.db.execute(sql`
    SELECT a.picking_item_id AS item, a.inventory_lot_id AS lot, a.qty
    FROM allocations a ORDER BY a.picking_item_id`);
  assert.deepEqual(
    rows.map((r: any) => [r.item, r.lot, r.qty]),
    [
      [ITEM_23, LOT_18, 1000],
      [ITEM_24, LOT_19, 500],
      [ITEM_25, LOT_28, 300],
    ]
  );

  const lots = await client.db.execute(sql`
    SELECT id, allocated_qty, available_qty FROM inventory_lots ORDER BY id`);
  assert.deepEqual(
    lots.map((r: any) => [r.id, r.allocated_qty, r.available_qty]),
    [
      [LOT_18, 1000, 0],
      [LOT_19, 500, 0],
      [LOT_28, 300, 400],
      [LOT_29, 0, 200],
      [LOT_30, 0, 1000],
      [LOT_31, 0, 400],
    ]
  );

  const items = await client.db.execute(sql`
    SELECT id, allocated_qty FROM picking_items ORDER BY id`);
  assert.deepEqual(
    items.map((r: any) => [r.id, r.allocated_qty]),
    [
      [ITEM_23, 1000],
      [ITEM_24, 500],
      [ITEM_25, 300],
    ]
  );
});

test("allocateAll: pair-less demand is org-agnostic — lots in any org match by part_no", async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  // strip the demand's location pair and move lot 18 into a different org —
  // allocation must still find it (a demand without the pair matches anything)
  await client.db.execute(sql`UPDATE picking_orders SET org_id = NULL, sub_inventory_code = NULL WHERE id = ${PO_22}`);
  await client.db.execute(sql`UPDATE inventory_lots SET org_id = 3, sub_inventory_code = NULL WHERE id = ${LOT_18}`);
  const s = await allocateAll(client.db);
  assert.equal(s.fullyAllocated, 3);
  const a23 = await client.db.execute(sql`SELECT qty FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(Number((a23[0] as any).qty), 1000);
});

test("allocateAll: sources must match the picking order's location pair", async () => {
  await reseed(client);
  // hermetic world: only SO-DEMO-0001 demands (SO-DEMO-0002 would still
  // allocate from the seeded STORE1 shelf lots)
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  // seeded demand is (org 2, STORE1); a sub-inventory outside its share
  // group finds nothing (STORE1/WSTORE1 share via the demo group — see the
  // share-group test below — so the mismatch case uses OSWF (HK))
  await client.db.execute(sql`UPDATE picking_orders SET sub_inventory_code = 'OSWF (HK)' WHERE id = ${PO_22}`);
  let s = await allocateAll(client.db);
  assert.equal(s.allocationsCreated, 0);
  let c = await client.db.execute(sql`SELECT count(*)::int AS c FROM allocations`);
  assert.equal(Number((c[0] as any).c), 0);

  // a different org finds nothing either
  await client.db.execute(sql`UPDATE picking_orders SET sub_inventory_code = 'store1', org_id = 143 WHERE id = ${PO_22}`);
  s = await allocateAll(client.db);
  assert.equal(s.allocationsCreated, 0);
  c = await client.db.execute(sql`SELECT count(*)::int AS c FROM allocations`);
  assert.equal(Number((c[0] as any).c), 0);
});

test("allocateAll: share group widens the sub-inventory match", async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  // demo seed puts org-2 STORE1 + WSTORE1 in share group HK; the lots live in
  // STORE1. A WSTORE1 demand allocates from the shared STORE1 stock.
  await client.db.execute(sql`UPDATE picking_orders SET sub_inventory_code = 'WSTORE1' WHERE id = ${PO_22}`);
  let s = await allocateAll(client.db);
  assert.equal(s.fullyAllocated, 3);
  let rows = await client.db.execute(sql`
    SELECT picking_item_id AS item, inventory_lot_id AS lot, qty FROM allocations ORDER BY picking_item_id`);
  assert.deepEqual(
    rows.map((r: any) => [r.item, r.lot, Number(r.qty)]),
    [
      [ITEM_23, LOT_18, 1000],
      [ITEM_24, LOT_19, 500],
      [ITEM_25, LOT_28, 300],
    ]
  );

  // removing WSTORE1 from the group cuts the sharing off again
  await client.db.execute(sql`DELETE FROM sub_inventory_share_members WHERE org_id = 2 AND code = 'WSTORE1'`);
  s = await allocateAll(client.db);
  assert.equal(s.allocationsCreated, 0);
  const c = await client.db.execute(sql`SELECT count(*)::int AS c FROM allocations`);
  assert.equal(Number((c[0] as any).c), 0);
});

test("allocateAll: sharing does not lift customer segregation", async () => {
  await reseed(client);
  // move lot 18 into the ACME-segregated store and add that store to the
  // same share group as the demand's WSTORE1
  await client.db.execute(sql`UPDATE inventory_lots SET sub_inventory_code = 'ACME-S1' WHERE id = ${LOT_18}`);
  await client.db.execute(sql`INSERT INTO sub_inventory_share_members (org_id, code, share_group, created_date, last_update_date) VALUES (2, 'ACME-S1', 'HK', now(), now())`);
  await client.db.execute(sql`UPDATE picking_orders SET sub_inventory_code = 'WSTORE1', customer_code = NULL WHERE id = ${PO_22}`);

  // the segregated lot stays off-limits (customer mismatch) even though it
  // shares the group; item 24's plain STORE1 lot still allocates via sharing
  await allocateAll(client.db);
  const c23 = await client.db.execute(sql`SELECT count(*)::int AS c FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(Number((c23[0] as any).c), 0);
  const a24 = await client.db.execute(sql`SELECT inventory_lot_id AS lot, qty FROM allocations WHERE picking_item_id = ${ITEM_24}`);
  assert.equal((a24[0] as any).lot, LOT_19);
  assert.equal(Number((a24[0] as any).qty), 500);
});

test("allocateAll: customer-segregated sub-inventory only serves its customer", async () => {
  await reseed(client);
  // move lot 18 into the ACME-segregated store; keep the demand pair-less so
  // the pair match cannot mask the segregation rule
  await client.db.execute(sql`UPDATE inventory_lots SET sub_inventory_code = 'ACME-S1' WHERE id = ${LOT_18}`);
  await client.db.execute(sql`UPDATE picking_orders SET org_id = NULL, sub_inventory_code = NULL WHERE id = ${PO_22}`);

  // seeded demand is customer ACME → the segregated lot serves it
  let s = await allocateAll(client.db);
  assert.equal(s.fullyAllocated, 3);
  const a23 = await client.db.execute(sql`SELECT qty, inventory_lot_id AS lot FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(a23.length, 1);
  assert.equal(Number((a23[0] as any).qty), 1000);
  assert.equal((a23[0] as any).lot, LOT_18);

  // the same demand without a customer cannot touch the segregated lot, but
  // item 24's STORE1 lot (not segregated) still allocates
  await client.db.execute(sql`UPDATE picking_orders SET customer_code = NULL WHERE id = ${PO_22}`);
  await allocateAll(client.db);
  const c = await client.db.execute(sql`SELECT count(*)::int AS c FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(Number((c[0] as any).c), 0);
  const a24 = await client.db.execute(sql`SELECT qty FROM allocations WHERE picking_item_id = ${ITEM_24}`);
  assert.equal(Number((a24[0] as any).qty), 500);
});

test("allocateAll: idempotent recompute, ledger stays consistent", async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  await allocateAll(client.db);
  const second = await allocateAll(client.db);
  assert.equal(second.allocationsRemoved, 3);
  assert.equal(second.allocationsCreated, 3);

  const lots = await client.db.execute(sql`
    SELECT id, allocated_qty FROM inventory_lots ORDER BY id`);
  assert.deepEqual(
    lots.map((r: any) => [r.id, r.allocated_qty]),
    [
      [LOT_18, 1000],
      [LOT_19, 500],
      [LOT_28, 300],
      [LOT_29, 0],
      [LOT_30, 0],
      [LOT_31, 0],
    ]
  );

  // Σ reserved deltas per lot equals the lot's allocated_qty
  const deltas = await client.db.execute(sql`
    SELECT inventory_lot_id AS lot, COALESCE(SUM(qty_delta), 0)::int AS delta
    FROM inventory_transactions
    WHERE txn_type = 'RESERVE' AND inventory_lot_id IS NOT NULL
    GROUP BY inventory_lot_id ORDER BY inventory_lot_id`);
  assert.deepEqual(
    deltas.map((r: any) => [r.lot, r.delta]),
    [
      [LOT_18, 1000],
      [LOT_19, 500],
      [LOT_28, 300],
    ]
  );
});

test("allocateAll: priority_seq decides who wins scarce stock", async () => {
  await reseed(client);
  // the seeded lot holds only 1000 (SO-DEMO-0001's full 1002F demand) — restock
  // it to 10000 so the scarcity split leaves something for both orders
  await client.db.execute(sql`UPDATE inventory_lots SET total_qty = 10000 WHERE id = ${LOT_18}`);
  // order B wants 9000 of the same part as ITEM_23; lot 18 holds 10000.
  const ORDER_B = "00000000-0000-4000-8000-0000000000b1";
  const ITEM_B = "00000000-0000-4000-8000-0000000000b2";
  await client.db.execute(sql`
    INSERT INTO picking_orders (id, order_no, customer_code, org_id, sub_inventory_code, status, priority_seq, created_date, last_update_date)
    VALUES (${ORDER_B}, 'TEST-PRIO', 'ACME', 2, 'STORE1', 'pending', 1, now(), now())`);
  await client.db.execute(sql`
    INSERT INTO picking_items (id, picking_order_id, part_no, qty, line_id, line_number, shipment_number, created_date, last_update_date)
    VALUES (${ITEM_B}, ${ORDER_B}, 'RK73H1JTTD1002F', 9000, 9001, 1, 1, now(), now())`);
  await client.db.execute(sql`UPDATE picking_orders SET priority_seq = 2 WHERE id = ${PO_22}`);

  // B (seq 1) takes 9000 first; ITEM_23 gets the remaining 1000.
  await allocateAll(client.db);
  let rows = await client.db.execute(sql`
    SELECT picking_item_id AS item, qty FROM allocations WHERE inventory_lot_id = ${LOT_18}`);
  const byItem = new Map(rows.map((r: any) => [r.item, Number(r.qty)]));
  assert.equal(byItem.get(ITEM_B), 9000);
  assert.equal(byItem.get(ITEM_23), 1000);

  // swap priorities → the recompute flips the split
  await client.db.execute(sql`UPDATE picking_orders SET priority_seq = 1 WHERE id = ${PO_22}`);
  await client.db.execute(sql`UPDATE picking_orders SET priority_seq = 2 WHERE id = ${ORDER_B}`);
  await allocateAll(client.db);
  rows = await client.db.execute(sql`
    SELECT picking_item_id AS item, qty FROM allocations WHERE inventory_lot_id = ${LOT_18}`);
  const flipped = new Map(rows.map((r: any) => [r.item, Number(r.qty)]));
  assert.equal(flipped.get(ITEM_23), 1000);
  assert.equal(flipped.get(ITEM_B), 9000);
});

test("allocateAll: live work lock protects the order; expired lock is rebuilt", async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  const first = await allocateAll(client.db);
  assert.equal(first.allocationsCreated, 3);

  const operator = await client.db.execute(sql`SELECT id FROM users WHERE username = 'operator'`);
  const operatorId = (operator[0] as any).id as string;
  await client.db.execute(
    sql`UPDATE picking_orders SET working_by = ${operatorId}, working_at = now() WHERE id = ${PO_22}`
  );

  // live lock → the order is not a demand and its allocations stay
  const locked = await allocateAll(client.db);
  assert.equal(locked.demands, 0);
  assert.equal(locked.allocationsRemoved, 0);
  const kept = await client.db.execute(sql`SELECT count(*)::int AS c FROM allocations`);
  assert.equal(Number((kept[0] as any).c), 3);

  // expired lock (> 10 min) → wiped and rebuilt like any other order
  await client.db.execute(
    sql`UPDATE picking_orders SET working_at = now() - interval '20 minutes' WHERE id = ${PO_22}`
  );
  const expired = await allocateAll(client.db);
  assert.equal(expired.demands, 3);
  assert.equal(expired.allocationsRemoved, 3);
  assert.equal(expired.allocationsCreated, 3);
});

test("allocateAll: open qty subtracts unboxed packages (no double reserve)", async () => {
  await reseed(client);
  await allocateAll(client.db);
  // simulate a scan: 500 of ITEM_23's 1000 consumed into an UNBOXED package
  // (picked_qty stays 0 — the old picked_qty-based guard would re-reserve it)
  await client.db.execute(sql`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, created_date, last_update_date)
    VALUES ('00000000-0000-4000-8000-0000000000c1', ${ITEM_23}, ${PO_22}, 'inventory_lot', ${LOT_18}, 500, now(), now())`);
  await client.db.execute(sql`UPDATE allocations SET qty = 500 WHERE picking_item_id = ${ITEM_23}`);

  await allocateAll(client.db);
  const a = await client.db.execute(sql`SELECT qty FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(a.length, 1);
  assert.equal(Number((a[0] as any).qty), 500);
});

// --- allocation_status (maintained by allocateAll's aggregate refresh) ----------

async function allocationStatusOf(db: TestDb["db"], orderId: string): Promise<string> {
  const rows = await db.execute(sql`SELECT allocation_status AS s FROM picking_orders WHERE id = ${orderId}`);
  return (rows[0] as any).s as string;
}

test("allocation_status: unallocated until allocateAll, then allocated", async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  // fresh seed leaves the column at its default
  assert.equal(await allocationStatusOf(client.db, PO_22), "unallocated");

  await allocateAll(client.db);
  assert.equal(await allocationStatusOf(client.db, PO_22), "allocated");
});

test("allocation_status: scarce stock — priority winner allocated, loser partial; more stock → both allocated", async () => {
  await reseed(client);
  // the seeded lot holds only 1000 (SO-DEMO-0001's full 1002F demand) — restock
  // it to 10000 so the scarcity split leaves PO_22 short of its 1000
  await client.db.execute(sql`UPDATE inventory_lots SET total_qty = 10000 WHERE id = ${LOT_18}`);
  const ORDER_B = "00000000-0000-4000-8000-0000000000b1";
  const ITEM_B = "00000000-0000-4000-8000-0000000000b2";
  await client.db.execute(sql`
    INSERT INTO picking_orders (id, order_no, customer_code, org_id, sub_inventory_code, status, priority_seq, created_date, last_update_date)
    VALUES (${ORDER_B}, 'TEST-PRIO', 'ACME', 2, 'STORE1', 'pending', 1, now(), now())`);
  await client.db.execute(sql`
    INSERT INTO picking_items (id, picking_order_id, part_no, qty, line_id, line_number, shipment_number, created_date, last_update_date)
    VALUES (${ITEM_B}, ${ORDER_B}, 'RK73H1JTTD1002F', 9500, 9002, 1, 1, now(), now())`);
  await client.db.execute(sql`UPDATE picking_orders SET priority_seq = 2 WHERE id = ${PO_22}`);

  // lot 18 holds 10000: B takes 9500 first, PO_22 gets 500 of its 1000 (the
  // other items fully cover) → allocated vs partial
  await allocateAll(client.db);
  assert.equal(await allocationStatusOf(client.db, ORDER_B), "allocated");
  assert.equal(await allocationStatusOf(client.db, PO_22), "partial");

  // restock the lot → the recompute covers both orders fully
  await client.db.execute(sql`UPDATE inventory_lots SET total_qty = total_qty + 8000 WHERE id = ${LOT_18}`);
  await allocateAll(client.db);
  assert.equal(await allocationStatusOf(client.db, ORDER_B), "allocated");
  assert.equal(await allocationStatusOf(client.db, PO_22), "allocated");
});

test("allocation_status: an order with zero allocation coverage reads unallocated", async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  // no source can match this pair → nothing allocates
  await client.db.execute(sql`UPDATE picking_orders SET sub_inventory_code = 'OSWF (HK)' WHERE id = ${PO_22}`);
  await allocateAll(client.db);
  assert.equal(await allocationStatusOf(client.db, PO_22), "unallocated");
});

test("allocation_status: work-locked order keeps its status while locked", async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  await allocateAll(client.db);
  assert.equal(await allocationStatusOf(client.db, PO_22), "allocated");

  const operator = await client.db.execute(sql`SELECT id FROM users WHERE username = 'operator'`);
  const operatorId = (operator[0] as any).id as string;
  await client.db.execute(sql`UPDATE picking_orders SET working_by = ${operatorId}, working_at = now() WHERE id = ${PO_22}`);

  // move the lots out of reach: an unlocked recompute would wipe the
  // allocations (→ unallocated), but the live lock keeps the order out of the
  // demand set so its rows — and its status — survive
  await client.db.execute(sql`UPDATE inventory_lots SET org_id = 3, sub_inventory_code = NULL`);
  const s = await allocateAll(client.db);
  assert.equal(s.demands, 0);
  assert.equal(await allocationStatusOf(client.db, PO_22), "allocated");

  // lock expires → the recompute wipes the allocations and the status follows
  await client.db.execute(sql`UPDATE picking_orders SET working_at = now() - interval '20 minutes' WHERE id = ${PO_22}`);
  await allocateAll(client.db);
  assert.equal(await allocationStatusOf(client.db, PO_22), "unallocated");
});

test("allocation_status: fully-picked (Σ open = 0) order reads allocated", async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  await allocateAll(client.db);

  // simulate all three items fully scanned (unboxed packages): the demand
  // filter sees no open qty, allocations are consumed down to 0
  await client.db.execute(sql`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, created_date, last_update_date)
    VALUES ('00000000-0000-4000-8000-0000000000d1', ${ITEM_23}, ${PO_22}, 'inventory_lot', ${LOT_18}, 1000, now(), now()),
           ('00000000-0000-4000-8000-0000000000d2', ${ITEM_24}, ${PO_22}, 'inventory_lot', ${LOT_19}, 500, now(), now()),
           ('00000000-0000-4000-8000-0000000000d3', ${ITEM_25}, ${PO_22}, 'inventory_lot', ${LOT_28}, 300, now(), now())`);
  await client.db.execute(sql`UPDATE picking_items SET allocated_qty = 0 WHERE picking_order_id = ${PO_22}`);
  await client.db.execute(sql`UPDATE picking_orders SET status = 'picking' WHERE id = ${PO_22}`);

  // no demands at all → the refresh still runs and the 0 = 0 edge holds
  const s = await allocateAll(client.db);
  assert.equal(s.demands, 0);
  assert.equal(await allocationStatusOf(client.db, PO_22), "allocated");
});
