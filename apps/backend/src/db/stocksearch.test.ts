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

async function supplierIdOf(code: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM suppliers WHERE code = ${code}`);
  return row!.id;
}

async function partIdOf(partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM parts WHERE part_no = ${partNo}`);
  return row!.id;
}

// --- no filters ---------------------------------------------------------------

test("no filters: returns the seeded lots and parts with onHandQty sums", async () => {
  await reseed(client);
  const { parts, lots } = await searchStock(client.db, {});

  assert.equal(lots.length, 2);
  // ordered by part_no: ...1002F before ...2202F
  const id1002 = await partIdOf("RK73H1JTTD1002F");
  const id2202 = await partIdOf("RK73H1JTTD2202F");

  assert.deepEqual(lots[0], {
    partNo: "RK73H1JTTD1002F",
    dateCode: "2601",
    lotCode: "L2601A",
    coo: "JP",
    cow: "JP",
    shelfCode: "A-01-01",
    boxId: "BOX-0001",
    orgId: 2,
    totalQty: 10000,
    allocatedQty: 0,
    availableQty: 10000,
  });
  assert.deepEqual(lots[1], {
    partNo: "RK73H1JTTD2202F",
    dateCode: "2602",
    lotCode: "L2602B",
    coo: "JP",
    cow: "JP",
    shelfCode: "A-01-02",
    boxId: "BOX-0002",
    orgId: 2,
    totalQty: 5000,
    allocatedQty: 0,
    availableQty: 5000,
  });

  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], {
    id: id1002,
    partNo: "RK73H1JTTD1002F",
    wclItemNo: "RK73H1JTTD1002F",
    description: "RES 10K OHM 1% 1/10W 0603",
    defaultCoo: "JP",
    onHandQty: 10000,
  });
  assert.deepEqual(parts[1], {
    id: id2202,
    partNo: "RK73H1JTTD2202F",
    wclItemNo: "RK73H1JTTD2202F",
    description: "RES 22K OHM 1% 1/10W 0603",
    defaultCoo: "JP",
    onHandQty: 5000,
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

  // shared substring matches both seeded parts, order by part_no
  r = await searchStock(client.db, { partNo: "RK73" });
  assert.equal(r.lots.length, 2);
  assert.deepEqual(r.parts.map((p) => p.partNo), ["RK73H1JTTD1002F", "RK73H1JTTD2202F"]);

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
  assert.equal(r.lots.length, 1);
  assert.equal(r.lots[0].shelfCode, "A-01-01");
  assert.equal(r.parts.length, 1);
  assert.equal(r.parts[0].partNo, "RK73H1JTTD1002F");
  assert.equal(r.parts[0].onHandQty, 10000);

  // prefix is not a match — the filter is exact
  r = await searchStock(client.db, { shelfCode: "A-01" });
  assert.deepEqual(r, { parts: [], lots: [] });

  // a seeded shelf with no stock
  r = await searchStock(client.db, { shelfCode: "A-01-03" });
  assert.deepEqual(r, { parts: [], lots: [] });
});

// --- supplierId filter ----------------------------------------------------------

test("supplierId: lot traces via lot sources to the receiving order's supplier", async () => {
  await reseed(client);

  const koa = await supplierIdOf("KOA");
  const r = await searchStock(client.db, { supplierId: koa });
  assert.equal(r.lots.length, 2);
  assert.deepEqual(r.parts.map((p) => p.partNo), ["RK73H1JTTD1002F", "RK73H1JTTD2202F"]);

  // DAITO's order is still pending — no lots trace to it
  const daito = await supplierIdOf("DAITO");
  const empty = await searchStock(client.db, { supplierId: daito });
  assert.deepEqual(empty, { parts: [], lots: [] });
});

// --- combined filters -----------------------------------------------------------

test("combined: all provided filters must match (AND)", async () => {
  await reseed(client);
  const koa = await supplierIdOf("KOA");

  const r = await searchStock(client.db, { partNo: "RK73", shelfCode: "A-01-01", supplierId: koa });
  assert.equal(r.lots.length, 1);
  assert.equal(r.lots[0].shelfCode, "A-01-01");
  assert.deepEqual(r.parts.map((p) => p.partNo), ["RK73H1JTTD1002F"]);
  assert.equal(r.parts[0].onHandQty, 10000);

  // same supplier, but the part is on a different shelf → empty
  const conflict = await searchStock(client.db, { partNo: "1002", shelfCode: "A-01-02", supplierId: koa });
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
  assert.equal(lots.length, 2); // the zero-qty lot is still there
  assert.equal(lots[1].totalQty, 0);
  assert.equal(lots[1].availableQty, 0);
  const p = parts.find((p) => p.partNo === "RK73H1JTTD2202F")!;
  assert.equal(p.onHandQty, 0);
});
