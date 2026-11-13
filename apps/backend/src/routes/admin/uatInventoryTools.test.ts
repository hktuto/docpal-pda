// Route-level tests for the UAT inventory tools (spec
// docs/superpowers/specs/2026-11-13-uat-inventory-tools-design.md):
//   POST /admin/shelves/import-inventory — per-shelf Excel-import credit:
//     happy path inserts a lot + ADJUST ledger row, a second import of the
//     same key merges (total_qty += qty), unknown wcl_item_no is a per-row
//     error while valid rows still commit, and an org/sub-inventory pair
//     outside the shelf's sub_inventory_scopes is rejected.
//   POST /admin/uat/inventory-wipe — wipes allocations / inventory_lot_sources
//     / inventory_transactions / transaction_logs / inventory_lots in one tx
//     (goods_verify_tasks.inventory_lot_id nulled) and reports deletedLots.
// Same auth/fixture pattern as orderReset.test.ts.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";
import { queryAll, queryGet } from "../../db/query.js";
import { insertPickingOrder } from "../../db/test-fixtures.js";
import { allocateAll } from "../../db/allocate.js";

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
  token = (await res.json()).token as string;
});

beforeEach(async () => {
  await reseed(client);
});

function req(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
}

const IMPORT_URL = "/admin/shelves/import-inventory";

async function insertPart(wclItemNo: string, partNo: string): Promise<void> {
  await client.db.execute(sql`
    INSERT INTO parts (id, brand, part_no, wcl_item_no, description, creation_date, last_update_date)
    VALUES (${"part-" + wclItemNo}, 'TESTBRAND', ${partNo}, ${wclItemNo}, 'test part', now(), now())
  `);
}

async function insertScopedShelf(code: string, scopes: { orgId: number; code: string }[]): Promise<void> {
  await client.db.execute(sql`
    INSERT INTO shelves (id, code, sub_inventory_scopes, created_date, last_update_date)
    VALUES (${"shelf-" + code}, ${code}, ${JSON.stringify(scopes)}::jsonb, now(), now())
  `);
}

// --- import-inventory ------------------------------------------------------------

test("import: happy path inserts a lot with an ADJUST ledger row and a transaction log", async () => {
  await insertPart("WCL-IMP-1", "PART-IMP-1");
  const res = await req(IMPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shelfCode: "A0101",
      orgId: 2,
      subInventoryCode: "STORE1",
      rows: [{ wclItemNo: "WCL-IMP-1", dateCode: "2632", qty: 50 }],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual({ ok: body.ok, inserted: body.inserted, merged: body.merged, errors: body.errors }, {
    ok: true,
    inserted: 1,
    merged: 0,
    errors: [],
  });

  const lot = (await queryGet<{ totalQty: number; allocatedQty: number; dateCode: string; wclItemNo: string }>(
    client.db,
    sql`SELECT total_qty AS "totalQty", allocated_qty AS "allocatedQty", date_code AS "dateCode", wcl_item_no AS "wclItemNo"
        FROM inventory_lots WHERE shelf_code = 'A0101' AND wcl_item_no = 'WCL-IMP-1'`
  ))!;
  assert.equal(lot.totalQty, 50);
  assert.equal(lot.allocatedQty, 0);
  assert.equal(lot.dateCode, "2632");

  const txn = (await queryGet<{ txnType: string; qtyType: string; qtyDelta: number; txnReason: string }>(
    client.db,
    sql`SELECT txn_type AS "txnType", qty_type AS "qtyType", qty_delta AS "qtyDelta", txn_reason AS "txnReason"
        FROM inventory_transactions WHERE part_no = 'PART-IMP-1' AND txn_type = 'ADJUST'`
  ))!;
  assert.equal(txn.qtyType, "on_hand");
  assert.equal(txn.qtyDelta, 50);
  assert.match(txn.txnReason, /admin import/);

  const log = (await queryGet<{ toState: string; inserted: string; merged: string }>(
    client.db,
    sql`SELECT to_state AS "toState", metadata->>'inserted' AS "inserted", metadata->>'merged' AS "merged"
        FROM transaction_logs WHERE entity_type = 'inventory_import' AND entity_id = 'A0101'`
  ))!;
  assert.equal(log.toState, "imported");
  assert.equal(Number(log.inserted), 1);
});

test("import: second import of the same key merges into the existing lot", async () => {
  await insertPart("WCL-IMP-2", "PART-IMP-2");
  const payload = {
    shelfCode: "A0101",
    orgId: 2,
    subInventoryCode: "STORE1",
    rows: [{ wclItemNo: "WCL-IMP-2", dateCode: "2632", qty: 50 }],
  };
  assert.equal((await req(IMPORT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).status, 200);
  const res = await req(IMPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, rows: [{ wclItemNo: "WCL-IMP-2", dateCode: "2632", qty: 30 }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual({ inserted: body.inserted, merged: body.merged }, { inserted: 0, merged: 1 });

  const lots = await queryAll<{ n: number; totalQty: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n, SUM(total_qty)::int AS "totalQty" FROM inventory_lots WHERE wcl_item_no = 'WCL-IMP-2'`
  );
  assert.equal(lots[0].n, 1, "one merged lot, not two");
  assert.equal(lots[0].totalQty, 80);
});

test("import: unknown wcl_item_no is a per-row error; valid rows still commit", async () => {
  await insertPart("WCL-IMP-3", "PART-IMP-3");
  const res = await req(IMPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shelfCode: "A0101",
      orgId: 2,
      subInventoryCode: "STORE1",
      rows: [
        { wclItemNo: "WCL-NOPE", dateCode: "2632", qty: 10 },
        { wclItemNo: "WCL-IMP-3", dateCode: "", qty: 5 },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.inserted, 1);
  assert.deepEqual(body.errors, [{ row: 1, message: "unknown wcl_item_no: WCL-NOPE" }]);

  const lot = (await queryGet<{ totalQty: number; dateCode: string | null }>(
    client.db,
    sql`SELECT total_qty AS "totalQty", date_code AS "dateCode" FROM inventory_lots WHERE wcl_item_no = 'WCL-IMP-3'`
  ))!;
  assert.equal(lot.totalQty, 5, "the valid row committed");
  assert.equal(lot.dateCode, null, "empty date_code stored as NULL");
});

test("import: org/sub-inventory outside the shelf scope is rejected with one error", async () => {
  await insertPart("WCL-IMP-4", "PART-IMP-4");
  await insertScopedShelf("IMP-SCOPED", [{ orgId: 2, code: "SUB-OK" }]);
  const res = await req(IMPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shelfCode: "IMP-SCOPED",
      orgId: 2,
      subInventoryCode: "STORE1",
      rows: [{ wclItemNo: "WCL-IMP-4", dateCode: "2632", qty: 10 }],
    }),
  });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /org_sub_inventory_outside_shelf_scope/);

  const n = (await queryGet<{ n: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS n FROM inventory_lots WHERE wcl_item_no = 'WCL-IMP-4'`
  ))!.n;
  assert.equal(n, 0);
});

test("import: org-options reflects the shelf scope", async () => {
  await insertScopedShelf("IMP-OPT", [{ orgId: 2, code: "STORE1" }]);
  const res = await req("/admin/shelves/import-inventory/org-options?shelfCode=IMP-OPT");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.pairs, [{ orgId: 2, code: "STORE1", description: body.pairs[0].description }]);
  const all = await req("/admin/shelves/import-inventory/org-options?shelfCode=A0101");
  const allBody = await all.json();
  assert.ok(allBody.pairs.length >= 1, "unrestricted shelf offers all org pairs");
});

test("import: drawing_no splits lots — same part + date_code, different drawing_no = second lot; blank = null", async () => {
  await insertPart("WCL-IMP-DWG", "PART-IMP-DWG");
  const res = await req(IMPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shelfCode: "A0101",
      orgId: 2,
      subInventoryCode: "STORE1",
      rows: [
        { wclItemNo: "WCL-IMP-DWG", dateCode: "2632", drawingNo: "DWG-4521-A", qty: 10 },
        { wclItemNo: "WCL-IMP-DWG", dateCode: "2632", drawingNo: "DWG-4521-B", qty: 20 },
        { wclItemNo: "WCL-IMP-DWG", dateCode: "2632", drawingNo: "", qty: 5 },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual({ ok: body.ok, inserted: body.inserted, merged: body.merged, errors: body.errors }, {
    ok: true,
    inserted: 3,
    merged: 0,
    errors: [],
  });

  const lots = await queryAll<{ drawingNo: string | null; totalQty: number }>(
    client.db,
    sql`SELECT drawing_no AS "drawingNo", total_qty AS "totalQty" FROM inventory_lots
        WHERE wcl_item_no = 'WCL-IMP-DWG' ORDER BY drawing_no NULLS LAST`
  );
  assert.equal(lots.length, 3, "three distinct lots (two drawing numbers + one blank)");
  assert.deepEqual(lots, [
    { drawingNo: "DWG-4521-A", totalQty: 10 },
    { drawingNo: "DWG-4521-B", totalQty: 20 },
    { drawingNo: null, totalQty: 5 },
  ]);

  // The ADJUST ledger snapshot carries drawing_no in metadata (the table has
  // no drawing_no column).
  const txnMeta = await queryAll<{ drawingNo: string | null }>(
    client.db,
    sql`SELECT metadata->>'drawingNo' AS "drawingNo" FROM inventory_transactions
        WHERE part_no = 'PART-IMP-DWG' AND txn_type = 'ADJUST' ORDER BY metadata->>'drawingNo' NULLS LAST`
  );
  assert.deepEqual(txnMeta, [{ drawingNo: "DWG-4521-A" }, { drawingNo: "DWG-4521-B" }, { drawingNo: null }]);

  // The import log metadata lists the distinct drawing numbers touched.
  const log = (await queryGet<{ drawingNos: string[] }>(
    client.db,
    sql`SELECT metadata->'drawingNos' AS "drawingNos" FROM transaction_logs
        WHERE entity_type = 'inventory_import' AND entity_id = 'A0101'
        ORDER BY created_date DESC LIMIT 1`
  ))!;
  assert.deepEqual(log.drawingNos, ["DWG-4521-A", "DWG-4521-B"]);
});

// --- inventory-wipe ---------------------------------------------------------------

test("wipe: clears lots, allocations, ledger and logs in one call", async () => {
  await insertPart("WCL-WIPE-1", "PART-WIPE-1");
  const res1 = await req(IMPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      shelfCode: "A0101",
      orgId: 2,
      subInventoryCode: "STORE1",
      rows: [{ wclItemNo: "WCL-WIPE-1", dateCode: "2632", qty: 100 }],
    }),
  });
  assert.equal(res1.status, 200);

  // An allocation row against the lot — allocations.picking_item_id is NOT
  // NULL, so seed a real picking order + allocateAll (orderReset.test.ts
  // pattern) instead of hand-inserting.
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, wcl_item_no, shelf_code, box_id, date_code, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-WIPE-1', 'PART-WIPE-ALLOC', 'WCL-WIPE-1', 'A0101', 'BOX-WIPE-1', '2601', 2, 'STORE1', 200, now(), now())
  `);
  await insertPickingOrder(client.db, "ORDER-WIPE-1", {
    order: { orderNo: "SO-WIPE-1", customerCode: "ACME", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "PART-WIPE-ALLOC", qty: 100 }],
  });
  await allocateAll(client.db);

  await insertScopedShelf("GVT-S1", []);
  await client.db.execute(sql`
    INSERT INTO goods_verify_tasks (id, task_date, shelf_code, inventory_lot_id, status, created_date, last_update_date)
    SELECT 'GVT-WIPE-1', '2026-11-13', 'GVT-S1', id, 'pending', now(), now()
    FROM inventory_lots WHERE wcl_item_no = 'WCL-WIPE-1' ORDER BY created_date LIMIT 1
  `);

  const res = await req("/admin/uat/inventory-wipe", { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.deletedLots >= 1);

  for (const table of ["inventory_lots", "allocations", "inventory_lot_sources", "inventory_transactions"]) {
    const n = (await queryGet<{ n: number }>(client.db, sql`SELECT COUNT(*)::int AS n FROM ${sql.raw(table)}`))!.n;
    assert.equal(n, 0, `${table} empty after wipe`);
  }
  // The wipe leaves exactly its own audit row behind.
  const logs = await queryAll<{ entityType: string }>(
    client.db,
    sql`SELECT entity_type AS "entityType" FROM transaction_logs`
  );
  assert.deepEqual(logs, [{ entityType: "uat_inventory_wipe" }]);
  const gvt = await queryAll<{ inventoryLotId: string | null }>(
    client.db,
    sql`SELECT inventory_lot_id AS "inventoryLotId" FROM goods_verify_tasks`
  );
  assert.ok(gvt.length >= 1, "goods verify tasks kept");
  assert.ok(gvt.every((g) => g.inventoryLotId === null), "legacy inventory_lot_id nulled");
});
