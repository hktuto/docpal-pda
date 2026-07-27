import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { allocateAll, parseDateCodeRule } from "./allocate.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

// Seed ids (see seed.ts)
const ITEM_23 = "00000000-0000-4000-8000-000000000023"; // part RK73H1JTTD1002F, qty 2000
const ITEM_24 = "00000000-0000-4000-8000-000000000024"; // part RK73H1JTTD2202F, qty 1000
const LOT_18 = "00000000-0000-4000-8000-000000000018"; // part RK73H1JTTD1002F, dc 2601, 10000
const LOT_19 = "00000000-0000-4000-8000-000000000019"; // part RK73H1JTTD2202F, dc 2602, 5000
const PO_22 = "00000000-0000-4000-8000-000000000022";

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
  // keep the demo world hermetic: drop the new_seed real-data picking orders
  // so allocateAll only sees the two seeded demo demands
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${PO_22}`);
  const s = await allocateAll(client.db);
  assert.equal(s.demands, 2);
  assert.equal(s.fullyAllocated, 2);
  assert.equal(s.allocationsCreated, 2);

  const rows = await client.db.execute(sql`
    SELECT a.picking_item_id AS item, a.inventory_lot_id AS lot, a.qty
    FROM allocations a ORDER BY a.picking_item_id`);
  assert.deepEqual(
    rows.map((r: any) => [r.item, r.lot, r.qty]),
    [
      [ITEM_23, LOT_18, 2000],
      [ITEM_24, LOT_19, 1000],
    ]
  );

  const lots = await client.db.execute(sql`
    SELECT id, allocated_qty, available_qty FROM inventory_lots ORDER BY id`);
  assert.deepEqual(
    lots.map((r: any) => [r.id, r.allocated_qty, r.available_qty]),
    [
      [LOT_18, 2000, 8000],
      [LOT_19, 1000, 4000],
    ]
  );

  const items = await client.db.execute(sql`
    SELECT id, allocated_qty FROM picking_items ORDER BY id`);
  assert.deepEqual(
    items.map((r: any) => [r.id, r.allocated_qty]),
    [
      [ITEM_23, 2000],
      [ITEM_24, 1000],
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
  assert.equal(s.fullyAllocated, 2);
  const a23 = await client.db.execute(sql`SELECT qty FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(Number((a23[0] as any).qty), 2000);
});

test("allocateAll: sources must match the picking order's location pair", async () => {
  await reseed(client);
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
  // demo seed puts org-2 STORE1 + WSTORE1 in share group HK; the lots live in
  // STORE1. A WSTORE1 demand allocates from the shared STORE1 stock.
  await client.db.execute(sql`UPDATE picking_orders SET sub_inventory_code = 'WSTORE1' WHERE id = ${PO_22}`);
  let s = await allocateAll(client.db);
  assert.equal(s.fullyAllocated, 2);
  let rows = await client.db.execute(sql`
    SELECT picking_item_id AS item, inventory_lot_id AS lot, qty FROM allocations ORDER BY picking_item_id`);
  assert.deepEqual(
    rows.map((r: any) => [r.item, r.lot, Number(r.qty)]),
    [
      [ITEM_23, LOT_18, 2000],
      [ITEM_24, LOT_19, 1000],
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
  await client.db.execute(sql`INSERT INTO sub_inventory_share_members (org_id, code, share_group, created_at, updated_at) VALUES (2, 'ACME-S1', 'HK', now(), now())`);
  await client.db.execute(sql`UPDATE picking_orders SET sub_inventory_code = 'WSTORE1', customer_code = NULL WHERE id = ${PO_22}`);

  // the segregated lot stays off-limits (customer mismatch) even though it
  // shares the group; item 24's plain STORE1 lot still allocates via sharing
  await allocateAll(client.db);
  const c23 = await client.db.execute(sql`SELECT count(*)::int AS c FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(Number((c23[0] as any).c), 0);
  const a24 = await client.db.execute(sql`SELECT inventory_lot_id AS lot, qty FROM allocations WHERE picking_item_id = ${ITEM_24}`);
  assert.equal((a24[0] as any).lot, LOT_19);
  assert.equal(Number((a24[0] as any).qty), 1000);
});

test("allocateAll: customer-segregated sub-inventory only serves its customer", async () => {
  await reseed(client);
  // move lot 18 into the ACME-segregated store; keep the demand pair-less so
  // the pair match cannot mask the segregation rule
  await client.db.execute(sql`UPDATE inventory_lots SET sub_inventory_code = 'ACME-S1' WHERE id = ${LOT_18}`);
  await client.db.execute(sql`UPDATE picking_orders SET org_id = NULL, sub_inventory_code = NULL WHERE id = ${PO_22}`);

  // seeded demand is customer ACME → the segregated lot serves it
  let s = await allocateAll(client.db);
  assert.equal(s.fullyAllocated, 2);
  const a23 = await client.db.execute(sql`SELECT qty, inventory_lot_id AS lot FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(a23.length, 1);
  assert.equal(Number((a23[0] as any).qty), 2000);
  assert.equal((a23[0] as any).lot, LOT_18);

  // the same demand without a customer cannot touch the segregated lot, but
  // item 24's STORE1 lot (not segregated) still allocates
  await client.db.execute(sql`UPDATE picking_orders SET customer_code = NULL WHERE id = ${PO_22}`);
  await allocateAll(client.db);
  const c = await client.db.execute(sql`SELECT count(*)::int AS c FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(Number((c[0] as any).c), 0);
  const a24 = await client.db.execute(sql`SELECT qty FROM allocations WHERE picking_item_id = ${ITEM_24}`);
  assert.equal(Number((a24[0] as any).qty), 1000);
});

test("allocateAll: idempotent recompute, ledger stays consistent", async () => {
  await reseed(client);
  await allocateAll(client.db);
  const second = await allocateAll(client.db);
  assert.equal(second.allocationsRemoved, 2);
  assert.equal(second.allocationsCreated, 2);

  const lots = await client.db.execute(sql`
    SELECT id, allocated_qty FROM inventory_lots ORDER BY id`);
  assert.deepEqual(
    lots.map((r: any) => [r.id, r.allocated_qty]),
    [
      [LOT_18, 2000],
      [LOT_19, 1000],
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
      [LOT_18, 2000],
      [LOT_19, 1000],
    ]
  );
});

test("allocateAll: priority_seq decides who wins scarce stock", async () => {
  await reseed(client);
  // order B wants 9000 of the same part as ITEM_23; lot 18 holds 10000.
  const ORDER_B = "00000000-0000-4000-8000-0000000000b1";
  const ITEM_B = "00000000-0000-4000-8000-0000000000b2";
  await client.db.execute(sql`
    INSERT INTO picking_orders (id, order_no, customer_code, org_id, sub_inventory_code, status, priority_seq, created_at, updated_at)
    VALUES (${ORDER_B}, 'TEST-PRIO', 'ACME', 2, 'STORE1', 'pending', 1, now(), now())`);
  await client.db.execute(sql`
    INSERT INTO picking_items (id, picking_order_id, part_no, qty, created_at, updated_at)
    VALUES (${ITEM_B}, ${ORDER_B}, 'RK73H1JTTD1002F', 9000, now(), now())`);
  await client.db.execute(sql`UPDATE picking_orders SET priority_seq = 2 WHERE id = ${PO_22}`);

  // B (seq 1) takes 9000 first; ITEM_23 gets only the remaining 1000.
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
  assert.equal(flipped.get(ITEM_23), 2000);
  assert.equal(flipped.get(ITEM_B), 8000);
});

test("allocateAll: live work lock protects the order; expired lock is rebuilt", async () => {
  await reseed(client);
  const first = await allocateAll(client.db);
  assert.equal(first.allocationsCreated, 2);

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
  assert.equal(Number((kept[0] as any).c), 2);

  // expired lock (> 10 min) → wiped and rebuilt like any other order
  await client.db.execute(
    sql`UPDATE picking_orders SET working_at = now() - interval '20 minutes' WHERE id = ${PO_22}`
  );
  const expired = await allocateAll(client.db);
  assert.equal(expired.demands, 2);
  assert.equal(expired.allocationsRemoved, 2);
  assert.equal(expired.allocationsCreated, 2);
});

test("allocateAll: open qty subtracts unboxed packages (no double reserve)", async () => {
  await reseed(client);
  await allocateAll(client.db);
  // simulate a scan: 500 of ITEM_23 consumed into an UNBOXED package
  // (picked_qty stays 0 — the old picked_qty-based guard would re-reserve it)
  await client.db.execute(sql`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, created_at, updated_at)
    VALUES ('00000000-0000-4000-8000-0000000000c1', ${ITEM_23}, ${PO_22}, 'inventory_lot', ${LOT_18}, 500, now(), now())`);
  await client.db.execute(sql`UPDATE allocations SET qty = 1500 WHERE picking_item_id = ${ITEM_23}`);

  await allocateAll(client.db);
  const a = await client.db.execute(sql`SELECT qty FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(a.length, 1);
  assert.equal(Number((a[0] as any).qty), 1500);
});
