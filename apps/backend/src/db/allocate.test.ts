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
const ITEM_23 = "00000000-0000-4000-8000-000000000023"; // part 5, qty 2000, dc "2601+"
const ITEM_24 = "00000000-0000-4000-8000-000000000024"; // part 6, qty 1000, dc "2601+"
const LOT_18 = "00000000-0000-4000-8000-000000000018"; // part 5, dc 2601, 10000
const LOT_19 = "00000000-0000-4000-8000-000000000019"; // part 6, dc 2602, 5000
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

test("allocateAll: date-code rule excludes older lots", async () => {
  await reseed(client);
  await client.db.execute(sql`UPDATE picking_items SET required_date_code = '2602+' WHERE id = ${ITEM_23}`);
  const s = await allocateAll(client.db);
  // item 23's only lot is dc 2601 → excluded; no receiving source → unallocated
  const a23 = await client.db.execute(sql`SELECT count(*)::int AS c FROM allocations WHERE picking_item_id = ${ITEM_23}`);
  assert.equal(Number((a23[0] as any).c), 0);
  const i23 = await client.db.execute(sql`SELECT allocated_qty FROM picking_items WHERE id = ${ITEM_23}`);
  assert.equal(Number((i23[0] as any).allocated_qty), 0);
  // item 24 (rule "2601+") still allocates from its dc 2602 lot
  const a24 = await client.db.execute(sql`SELECT qty FROM allocations WHERE picking_item_id = ${ITEM_24}`);
  assert.equal(Number((a24[0] as any).qty), 1000);
  assert.equal(s.fullyAllocated, 1);
});

test("allocateAll: sources must match the picking order's location", async () => {
  await reseed(client);
  await client.db.execute(sql`UPDATE picking_orders SET sub_inventory_code = 'ACME-S1' WHERE id = ${PO_22}`);
  const s = await allocateAll(client.db);
  assert.equal(s.allocationsCreated, 0);
  const c = await client.db.execute(sql`SELECT count(*)::int AS c FROM allocations`);
  assert.equal(Number((c[0] as any).c), 0);
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
