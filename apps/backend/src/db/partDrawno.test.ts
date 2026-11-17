// lookupPartsByDrawingNo tests (spec 2026-11-03-ncc-drawno-part-lookup): the
// externally-managed wcl_part_drawno table is created by the test itself (the
// test DB does not have it), and reseed() never truncates it (the table is
// not in the seed ALL_TABLES list) — fixture rows are deleted per test.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "./test-helper.js";
import { lookupPartsByDrawingNo } from "./partDrawno.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
  await client.db.execute(sql`CREATE TABLE IF NOT EXISTS wcl_part_drawno (
    id varchar(100) PRIMARY KEY,
    wcl_part_no varchar(255) NOT NULL,
    drawno varchar(2000) NOT NULL
  )`);
  // the real table carries the upstream org id and the lookup is org-scoped
  // (DRAWNO_ORG_ID) — add it idempotently in case a pre-existing test-db
  // table (created without the column) survives from an earlier run.
  await client.db.execute(sql`ALTER TABLE wcl_part_drawno ADD COLUMN IF NOT EXISTS organization_id bigint`);
});

beforeEach(async () => {
  // reseed() never truncates wcl_part_drawno (not in seed ALL_TABLES) — clear it here.
  await client.db.execute(sql`DELETE FROM wcl_part_drawno`);
});

async function insertDrawno(wclPartNo: string, drawno: string, organizationId = 160): Promise<void> {
  await client.db.execute(
    sql`INSERT INTO wcl_part_drawno (id, wcl_part_no, drawno, organization_id) VALUES (${randomUUID()}, ${wclPartNo}, ${drawno}, ${organizationId})`
  );
}

async function insertPart(partNo: string, wclItemNo: string): Promise<void> {
  await client.db.execute(
    sql`INSERT INTO parts (id, brand, part_no, wcl_item_no) VALUES (${randomUUID()}, 'NCC', ${partNo}, ${wclItemNo}) ON CONFLICT (wcl_item_no) DO NOTHING`
  );
}

test("exact match: duplicate rows collapse to one distinct result", async () => {
  await insertPart("EKLJ401ELL470MM20S", "NCC-EKLJ401ELL470MM20S");
  await insertDrawno("NCC-EKLJ401ELL470MM20S", "424307");
  await insertDrawno("NCC-EKLJ401ELL470MM20S", "424307"); // dup row (per org)

  const matches = await lookupPartsByDrawingNo(client.db, "424307");
  assert.deepEqual(matches, [{ wclItemNo: "NCC-EKLJ401ELL470MM20S", partNo: "EKLJ401ELL470MM20S" }]);
});

test("rows from other upstream orgs are excluded", async () => {
  await insertPart("EKLJ401ELL470MM20S", "NCC-EKLJ401ELL470MM20S");
  await insertDrawno("NCC-EKLJ401ELL470MM20S", "424307");
  await insertDrawno("NCC-OTHER-ORG", "424307", 161); // same drawing, other org

  const matches = await lookupPartsByDrawingNo(client.db, "424307");
  assert.deepEqual(matches, [{ wclItemNo: "NCC-EKLJ401ELL470MM20S", partNo: "EKLJ401ELL470MM20S" }]);

  // only the other org carries this drawing → no matches
  await insertDrawno("NCC-ONLY-OTHER-ORG", "777001", 222);
  assert.deepEqual(await lookupPartsByDrawingNo(client.db, "777001"), []);
});

test("exact match: wcl_part_no missing from parts still resolves with partNo null", async () => {
  await insertDrawno("NCC-NOT-IN-PARTS", "555001");
  const matches = await lookupPartsByDrawingNo(client.db, " 555001 "); // trimmed
  assert.deepEqual(matches, [{ wclItemNo: "NCC-NOT-IN-PARTS", partNo: null }]);
});

test("substring fallback: drawno embeds the code in a longer string", async () => {
  await insertPart("EKLJ401ELL470MM20S", "NCC-EKLJ401ELL470MM20S");
  await insertDrawno("NCC-EKLJ401ELL470MM20S", "REF#999001");
  const matches = await lookupPartsByDrawingNo(client.db, "999001");
  assert.deepEqual(matches, [{ wclItemNo: "NCC-EKLJ401ELL470MM20S", partNo: "EKLJ401ELL470MM20S" }]);
});

test("exact match wins over the substring fallback", async () => {
  await insertDrawno("NCC-EXACT", "999002");
  await insertDrawno("NCC-SUBSTRING", "REF#999002");
  const matches = await lookupPartsByDrawingNo(client.db, "999002");
  assert.deepEqual(matches.map((m) => m.wclItemNo), ["NCC-EXACT"]);
});

test("unknown code / blank input → []", async () => {
  await insertDrawno("NCC-EKLJ401ELL470MM20S", "424307");
  assert.deepEqual(await lookupPartsByDrawingNo(client.db, "000000"), []);
  assert.deepEqual(await lookupPartsByDrawingNo(client.db, "   "), []);
});
