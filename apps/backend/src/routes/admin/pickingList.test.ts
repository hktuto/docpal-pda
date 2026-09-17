// Route-level tests for GET /admin/picking-orders/:id/picking-list (spec
// 2026-09-14-admin-picking-list-download-design.md): a flat one-row-per-allocation
// xlsx — order-info block, lot-sourced rows with shelf/box/date-code/qty,
// receiving-sourced rows as `Receiving {batchNo}` / `(dock)`, an UNALLOCATED
// shortfall row, and a `(no allocation)` row for items with no allocations.
// Read-only: no in-request recompute. Dynamic app import so DATABASE_URL
// points at the test DB first (same pattern as receivingShipper.test.ts).

import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";
import { queryGet } from "../../db/query.js";
import { confirmReceivingArrival } from "../../db/receiving.js";
import { insertReceivingOrder, insertPickingOrder } from "../../db/test-fixtures.js";
import { allocateAll } from "../../db/allocate.js";
import { upsertUserScope } from "../../db/user-scope.js";
import { _setAllowedOrgIdsForTests, _resetFlowConfigForTests } from "../../config.js";

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
  token = (await res.json()).token;
});

function req(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
}

afterEach(async () => {
  _resetFlowConfigForTests();
  await upsertUserScope(client.db, "admin", []);
});

// --- GET /admin/picking-orders (unscoped list) ------------------------------

// The admin list ignores both org-partition filters (allowedOrgIds and the
// caller's user sub-inventory scope) that hide orders on the PDA list.
test("GET /admin/picking-orders: unscoped — allowedOrgIds and user scope do not apply", async () => {
  await reseed(client);
  const count = (
    await queryGet<{ n: number }>(client.db, sql`SELECT COUNT(*)::int AS n FROM picking_orders`)
  )!.n;
  assert.ok(count > 0);
  // Stamp every order so the user-scope pair filter actually hides them
  // (NULL sub-inventory stays visible).
  await client.db.execute(
    sql`UPDATE picking_orders SET org_id = 2, sub_inventory_code = 'STORE1'`
  );

  _setAllowedOrgIdsForTests([99]);
  await upsertUserScope(client.db, "admin", [{ orgId: 2, code: "WSTORE1" }]);

  const pdaRes = await req("/picking-orders");
  assert.equal(pdaRes.status, 200);
  assert.equal((await pdaRes.json()).rows.length, 0);

  const adminRes = await req("/admin/picking-orders");
  assert.equal(adminRes.status, 200);
  const body = await adminRes.json();
  assert.equal(body.rows.length, count);
  assert.equal(body.total, count);

  // Status filter still works on the unscoped list.
  const pendingCount = (
    await queryGet<{ n: number }>(
      client.db,
      sql`SELECT COUNT(*)::int AS n FROM picking_orders WHERE status = 'pending'`
    )
  )!.n;
  const filteredRes = await req("/admin/picking-orders?status=pending");
  assert.equal((await filteredRes.json()).rows.length, pendingCount);
});

// The admin detail is unscoped too: an order hidden by allowedOrgIds / user
// scope still opens in the admin console.
test("GET /admin/picking-orders/:id: unscoped — 200 where the PDA detail 404s", async () => {
  await reseed(client);
  const row = (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_orders LIMIT 1`
  ))!;

  const before = await req(`/admin/picking-orders/${row.id}`);
  assert.equal(before.status, 200);
  assert.equal((await before.json()).id, row.id);

  _setAllowedOrgIdsForTests([99]);
  assert.equal((await req(`/picking-orders/${row.id}`)).status, 404);
  const adminRes = await req(`/admin/picking-orders/${row.id}`);
  assert.equal(adminRes.status, 200);
  assert.equal((await adminRes.json()).id, row.id);

  assert.equal((await req(`/admin/picking-orders/${randomUUID()}`)).status, 404);
});

/** Sheet rows as a plain array-of-arrays (blank cells → ""). */
function sheetRows(buf: ArrayBuffer): (string | number)[][] {
  const wb = XLSX.read(Buffer.from(buf));
  const ws = wb.Sheets[wb.SheetNames[0]!]!;
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
}

// Scenario: one picking order SO-PLIST-001 with three items:
//   RK73H2ATTD1372F ×300 — split across two shelf lots (LOT-PL-01 has 200,
//     LOT-PL-02 supplies the remaining 100) → second row carries only the
//     allocation info (blank item columns);
//   RK73H1JTTD3302F ×700 — receiving order PLIST-01 supplies 500 (dock pick),
//     leaving a 200 UNALLOCATED shortfall;
//   RK73H2BTTD1004F  ×100 — no stock at all → `(no allocation)` row.
async function seedScenario(): Promise<string> {
  // Hermetic: the demo seed's picking orders would also draw on this stock.
  await client.db.execute(sql`DELETE FROM picking_orders`);

  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, shelf_code, box_id, date_code, lot_code, coo, cow, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-PL-01', 'RK73H2ATTD1372F', 'A-04-05', 'BOX-PL-1', '2601', 'LOT-X', 'HK', 'CN', 2, 'STORE1', 200, now(), now())
  `);
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, shelf_code, box_id, date_code, lot_code, coo, cow, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-PL-02', 'RK73H2ATTD1372F', 'W-01-01', 'BOX-PL-2', '2602', 'LOT-Y', 'HK', 'CN', 2, 'STORE1', 500, now(), now())
  `);

  await insertReceivingOrder(client.db, "PLIST-01", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-09-14" },
    invoices: [
      {
        invoiceNo: "INV-PLIST-01",
        totalCtn: 1,
        items: [
          { partNo: "RK73H1JTTD3302F", poNo: "PO-1", poLine: "1", lineQty: 500, ctnNo: "8001", orgId: 2, subInventoryCode: "STORE1" },
        ],
      },
    ],
  });
  const receivingId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = 'PLIST-01'`)
  )!.id;
  const actorId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`)
  )!.id;
  await confirmReceivingArrival(client.db, receivingId, actorId);

  const orderId = randomUUID();
  await insertPickingOrder(client.db, orderId, {
    order: { orderNo: "SO-PLIST-001", customerCode: "ACME", orgId: 2, subInventoryCode: "STORE1" },
    items: [
      { partNo: "RK73H2ATTD1372F", qty: 300 },
      { partNo: "RK73H1JTTD3302F", qty: 700 },
      { partNo: "RK73H2BTTD1004F", qty: 100 },
    ],
  });
  await allocateAll(client.db);
  await client.db.execute(sql`UPDATE picking_orders SET remark = 'Handle with care' WHERE id = ${orderId}`);
  return orderId;
}

test("GET picking-list: 404 for an unknown picking order", async () => {
  await reseed(client);
  const res = await req(`/admin/picking-orders/${randomUUID()}/picking-list`);
  assert.equal(res.status, 404);
});

test("GET picking-list: order-info block and flat allocation rows", async () => {
  await reseed(client);
  const orderId = await seedScenario();

  const res = await req(`/admin/picking-orders/${orderId}/picking-list`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("Content-Type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  assert.match(res.headers.get("Content-Disposition") ?? "", /picking-list-SO-PLIST-001\.xlsx/);

  const rows = await sheetRows(await res.arrayBuffer());

  // Title + order-info block (label / value pairs; defval pads rows to full width).
  assert.equal(rows[0]![0], "Picking List — SO-PLIST-001");
  assert.deepEqual(rows[1]!.slice(0, 2), ["Order No", "SO-PLIST-001"]);
  assert.deepEqual(rows[2]!.slice(0, 2), ["PO No", ""]);
  assert.deepEqual(rows[3]!.slice(0, 2), ["Customer", "ACME"]);
  assert.deepEqual(rows[4]!.slice(0, 2), ["Ship To", ""]);
  assert.deepEqual(rows[5]!.slice(0, 2), ["Org / Sub-Inventory", "2 / STORE1"]);
  assert.deepEqual(rows[6]!.slice(0, 2), ["Status", "pending"]);
  assert.deepEqual(rows[7]!.slice(0, 2), ["Allocation Status", "partial"]);
  assert.deepEqual(rows[8]!.slice(0, 2), ["Remark", "Handle with care"]);
  assert.equal(rows[9]![0], "Generated At");

  // Header row after the blank separator.
  assert.deepEqual(rows[11], [
    "Part Number", "Item Qty", "Allocated Qty", "Picked Qty", "Source",
    "Location (Shelf)", "Box", "Date Code", "Lot Code", "COO / COW",
    "Source Org / Sub-Inv", "Alloc Qty",
  ]);

  // Data rows (item order is created_date/id-based, so locate each item's
  // block by its first row rather than assuming a fixed order). Item blocks
  // are separated by a fully blank row; continuation rows have blank item
  // columns but non-empty allocation columns.
  const data = rows.slice(12);
  assert.equal(data.length, 7); // 5 data rows + 2 blank separators
  const isBlank = (r: (string | number)[]) => r.every((cell) => cell === "");
  assert.equal(data.filter(isBlank).length, 2); // separators between the 3 items
  const itemBlock = (partNo: string) => {
    const i = data.findIndex((r) => r[0] === partNo);
    assert.notEqual(i, -1, `item row for ${partNo}`);
    const block = [data[i]!];
    while (
      i + block.length < data.length &&
      data[i + block.length]![0] === "" &&
      !isBlank(data[i + block.length]!)
    ) {
      block.push(data[i + block.length]!);
    }
    // Every non-last block — including a `(no allocation)` one — is followed
    // by a blank separator row.
    const next = data[i + block.length];
    if (next !== undefined) assert.ok(isBlank(next), `blank separator after ${partNo}`);
    return block;
  };

  // Item 1: two lot-sourced allocation rows; item columns only on the first.
  assert.deepEqual(itemBlock("RK73H2ATTD1372F"), [
    [
      "RK73H2ATTD1372F", 300, 300, 0, "Shelf",
      "A-04-05", "BOX-PL-1", "2601", "LOT-X", "HK / CN",
      "2 / STORE1", 200,
    ],
    [
      "", "", "", "", "Shelf",
      "W-01-01", "BOX-PL-2", "2602", "LOT-Y", "HK / CN",
      "2 / STORE1", 100,
    ],
  ]);

  // Item 2: receiving-sourced dock row plus the UNALLOCATED shortfall
  // (blank item columns on the footer).
  assert.deepEqual(itemBlock("RK73H1JTTD3302F"), [
    [
      "RK73H1JTTD3302F", 700, 500, 0, "Receiving PLIST-01",
      "(dock)", "", "", "", "",
      "", 500,
    ],
    [
      "", "", "", "", "UNALLOCATED",
      "", "", "", "", "",
      "", 200,
    ],
  ]);

  // Item 3: no allocations at all (single row keeps the item columns).
  assert.deepEqual(itemBlock("RK73H2BTTD1004F"), [
    [
      "RK73H2BTTD1004F", 100, 0, 0, "(no allocation)",
      "", "", "", "", "",
      "", "",
    ],
  ]);
});
