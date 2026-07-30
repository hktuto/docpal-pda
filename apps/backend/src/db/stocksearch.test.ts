import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet, queryRun } from "./query.js";
import { searchStock } from "./stocksearch.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

// --- business-key lookups (never hardcode seed UUIDs) ------------------------

async function partIdOf(partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM parts WHERE part_no = ${partNo}`);
  return row!.id;
}

// --- lot-source setup -----------------------------------------------------------

// The seed creates no inventory_lot_sources (derived rows come from business
// logic), so tests that exercise the supplierCode filter link the two
// BOX-H-20260701-0001 lots to KOA order 100001's matching invoice items —
// mirroring a receive → put-away of that order. DAITO has no receiving
// orders at all, so nothing traces to it.
async function linkBoxLotsToKoaOrder(): Promise<void> {
  await queryRun(
    client.db,
    sql`INSERT INTO inventory_lot_sources (id, inventory_lot_id, receiving_invoice_item_id, qty, created_date, last_update_date)
        SELECT gen_random_uuid()::text, il.id, rii.id, il.total_qty, now(), now()
        FROM inventory_lots il
        JOIN receiving_invoice_items rii ON rii.part_no = il.part_no
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
        WHERE il.box_id = 'BOX-H-20260701-0001' AND ro.batch_no = '100001'`
  );
}

// --- no filters ---------------------------------------------------------------

test("no filters: returns the seeded lots and parts with onHandQty sums", async () => {
  await reseed(client);
  const { parts, lots } = await searchStock(client.db, {});

  assert.equal(lots.length, 4);
  // ordered by part_no: ...181G, ...1002F, ...2202F, ...4702F
  const id181 = await partIdOf("RK73B1JTTD181G");
  const id1002 = await partIdOf("RK73H1JTTD1002F");
  const id2202 = await partIdOf("RK73H1JTTD2202F");
  const id4702 = await partIdOf("RK73H1JTTD4702F");

  assert.deepEqual(lots[0], {
    partNo: "RK73B1JTTD181G",
    dateCode: "2604",
    lotCode: "L2604A",
    coo: "JP",
    cow: "JP",
    shelfCode: "A-01-02",
    boxId: "BOX-H-20260701-0002",
    orgId: 2,
    subInventoryCode: "STORE1",
    totalQty: 400,
    allocatedQty: 0,
    availableQty: 400,
  });
  assert.deepEqual(lots[1], {
    partNo: "RK73H1JTTD1002F",
    dateCode: "2603",
    lotCode: "L2603A",
    coo: "JP",
    cow: "JP",
    shelfCode: "A-01-01",
    boxId: "BOX-H-20260701-0001",
    orgId: 2,
    subInventoryCode: "STORE1",
    totalQty: 1000,
    allocatedQty: 0,
    availableQty: 1000,
  });
  assert.deepEqual(lots[2], {
    partNo: "RK73H1JTTD2202F",
    dateCode: "2603",
    lotCode: "L2603B",
    coo: "JP",
    cow: "JP",
    shelfCode: "A-01-01",
    boxId: "BOX-H-20260701-0001",
    orgId: 2,
    subInventoryCode: "STORE1",
    totalQty: 500,
    allocatedQty: 0,
    availableQty: 500,
  });
  assert.deepEqual(lots[3], {
    partNo: "RK73H1JTTD4702F",
    dateCode: "2604",
    lotCode: "L2604B",
    coo: "JP",
    cow: "JP",
    shelfCode: "A-01-02",
    boxId: "BOX-H-20260701-0002",
    orgId: 2,
    subInventoryCode: "STORE1",
    totalQty: 200,
    allocatedQty: 0,
    availableQty: 200,
  });

  assert.equal(parts.length, 4);
  assert.deepEqual(parts[0], {
    id: id181,
    partNo: "RK73B1JTTD181G",
    wclItemNo: "RK73B1JTTD181G",
    description: "RES 180 OHM 5% 1/10W 0603",
    defaultCoo: "JP",
    onHandQty: 400,
  });
  assert.deepEqual(parts[1], {
    id: id1002,
    partNo: "RK73H1JTTD1002F",
    wclItemNo: "RK73H1JTTD1002F",
    description: "RES 10K OHM 1% 1/10W 0603",
    defaultCoo: "JP",
    onHandQty: 1000,
  });
  assert.deepEqual(parts[2], {
    id: id2202,
    partNo: "RK73H1JTTD2202F",
    wclItemNo: "RK73H1JTTD2202F",
    description: "RES 22K OHM 1% 1/10W 0603",
    defaultCoo: "JP",
    onHandQty: 500,
  });
  assert.deepEqual(parts[3], {
    id: id4702,
    partNo: "RK73H1JTTD4702F",
    wclItemNo: "RK73H1JTTD4702F",
    description: "RES 47K OHM 1% 1/10W 0603",
    defaultCoo: "JP",
    onHandQty: 200,
  });
});

// --- partNo filter --------------------------------------------------------------

test("partNo: case-insensitive substring, whitespace-normalized like scan matching", async () => {
  await reseed(client);

  // lowercase substring
  let r = await searchStock(client.db, { partNo: "rk73h1jttd1002" });
  assert.equal(r.lots.length, 1);
  assert.equal(r.parts.length, 1);
  assert.equal(r.parts[0].partNo, "RK73H1JTTD1002F");

  // shared substring matches all four stocked RK73 parts, order by part_no
  r = await searchStock(client.db, { partNo: "RK73" });
  assert.equal(r.lots.length, 4);
  assert.deepEqual(r.parts.map((p) => p.partNo), ["RK73B1JTTD181G", "RK73H1JTTD1002F", "RK73H1JTTD2202F", "RK73H1JTTD4702F"]);

  // whitespace in the query is stripped (normalizePartNo), so a spaced
  // fragment still matches the continuous part_no
  r = await searchStock(client.db, { partNo: " rk73h 1jttd2202 " });
  assert.equal(r.lots.length, 1);
  assert.equal(r.parts[0].partNo, "RK73H1JTTD2202F");
});

test("partNo: no match returns empty parts and lots", async () => {
  await reseed(client);
  const r = await searchStock(client.db, { partNo: "DOES-NOT-EXIST" });
  assert.deepEqual(r, { parts: [], lots: [] });
});

// --- shelfCode filter -----------------------------------------------------------

test("shelfCode: exact match only", async () => {
  await reseed(client);

  let r = await searchStock(client.db, { shelfCode: "A-01-01" });
  assert.equal(r.lots.length, 2);
  assert.ok(r.lots.every((l) => l.shelfCode === "A-01-01"));
  assert.deepEqual(r.parts.map((p) => p.partNo), ["RK73H1JTTD1002F", "RK73H1JTTD2202F"]);
  assert.equal(r.parts[0].onHandQty, 1000);
  assert.equal(r.parts[1].onHandQty, 500);

  // prefix is not a match — the filter is exact
  r = await searchStock(client.db, { shelfCode: "A-01" });
  assert.deepEqual(r, { parts: [], lots: [] });

  // a seeded shelf with no stock
  r = await searchStock(client.db, { shelfCode: "A-01-03" });
  assert.deepEqual(r, { parts: [], lots: [] });
});

// --- supplierCode filter --------------------------------------------------------

test("supplierCode: lot traces via lot sources to the receiving order's supplier", async () => {
  await reseed(client);
  await linkBoxLotsToKoaOrder();

  const r = await searchStock(client.db, { supplierCode: "KOA" });
  assert.equal(r.lots.length, 2);
  assert.deepEqual(r.parts.map((p) => p.partNo), ["RK73H1JTTD1002F", "RK73H1JTTD2202F"]);

  // DAITO has no receiving orders — no lots trace to it
  const empty = await searchStock(client.db, { supplierCode: "DAITO" });
  assert.deepEqual(empty, { parts: [], lots: [] });
});

// --- combined filters -----------------------------------------------------------

test("combined: all provided filters must match (AND)", async () => {
  await reseed(client);
  await linkBoxLotsToKoaOrder();

  const r = await searchStock(client.db, { partNo: "1002", shelfCode: "A-01-01", supplierCode: "KOA" });
  assert.equal(r.lots.length, 1);
  assert.equal(r.lots[0].shelfCode, "A-01-01");
  assert.deepEqual(r.parts.map((p) => p.partNo), ["RK73H1JTTD1002F"]);
  assert.equal(r.parts[0].onHandQty, 1000);

  // same supplier, but the part is on a different shelf → empty
  const conflict = await searchStock(client.db, { partNo: "1002", shelfCode: "A-01-02", supplierCode: "KOA" });
  assert.deepEqual(conflict, { parts: [], lots: [] });
});

// --- zero-qty lots ----------------------------------------------------------------

test("zero-qty lots are returned (old /stock-search/parts/lots had no qty filter)", async () => {
  await reseed(client);
  await queryRun(
    client.db,
    sql`UPDATE inventory_lots SET total_qty = 0
        WHERE part_no = 'RK73H1JTTD2202F'`
  );

  const { parts, lots } = await searchStock(client.db, {});
  assert.equal(lots.length, 4); // the zero-qty lot is still there
  assert.equal(lots[2].totalQty, 0);
  assert.equal(lots[2].availableQty, 0);
  const p = parts.find((p) => p.partNo === "RK73H1JTTD2202F")!;
  assert.equal(p.onHandQty, 0);
});
