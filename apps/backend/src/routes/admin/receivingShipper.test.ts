// Route-level tests for GET /admin/receiving-orders/:id/shipper (spec
// 2026-09-14-admin-receiving-shipper-download-design.md): shipper-style xlsx —
// merged per-part blocks (one row per carton, slot rows overlaid on the
// block's last three rows), order-level (no ctn) rows, Total/Balance.
// Modes: default (live — slots from the current `allocations` table, no
// in-request recompute) and ?mode=finished (slots from actual
// `picking_packages` traced back to the order's invoice items).
// Dynamic app import so DATABASE_URL points at the test DB first (same
// pattern as src/routes/admin-flow-config.test.ts).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../../db/test-helper.js";
import { queryAll, queryGet } from "../../db/query.js";
import { confirmReceivingArrival } from "../../db/receiving.js";
import { insertReceivingOrder, insertPickingOrder } from "../../db/test-fixtures.js";
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
  token = (await res.json()).token;
});

function req(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
}

/** Sheet rows as a plain array-of-arrays (blank cells → ""). */
function sheetRows(buf: ArrayBuffer): (string | number)[][] {
  const wb = XLSX.read(Buffer.from(buf));
  const ws = wb.Sheets[wb.SheetNames[0]!]!;
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
}

// Scenario: RK73H2ATTD1372F arrives in two cartons (item-level allocation), RK73H1JTTD3302F
// without a carton (whole-order allocation). Two picking orders draw on them:
//   SO-PL-001 (ACME): RK73H2ATTD1372F ×1500, RK73H1JTTD3302F ×200
//   SO-PL-002:        RK73H2ATTD1372F ×1000
async function seedScenario(): Promise<string> {
  // Keep the scenario hermetic: the demo seed's picking orders would also
  // draw on this stock (allocate.ts FIFO spans every open demand).
  await client.db.execute(sql`DELETE FROM picking_orders`);
  await insertReceivingOrder(client.db, "PL-TEST-01", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-09-07" },
    invoices: [
      {
        invoiceNo: "INV-PL-01",
        totalCtn: 2,
        items: [
          { partNo: "RK73H2ATTD1372F", poNo: "PO-1", poLine: "1", lineQty: 1000, ctnNo: "7001", orgId: 2, subInventoryCode: "STORE1" },
          { partNo: "RK73H2ATTD1372F", poNo: "PO-2", poLine: "1", lineQty: 2000, ctnNo: "7002", orgId: 2, subInventoryCode: "STORE1" },
          { partNo: "RK73H1JTTD3302F", poNo: "PO-3", poLine: "1", lineQty: 500, orgId: 2, subInventoryCode: "STORE1" },
        ],
      },
    ],
  });
  const orderId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = 'PL-TEST-01'`)
  )!.id;
  const actorId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`)
  )!.id;
  await confirmReceivingArrival(client.db, orderId, actorId);

  await insertPickingOrder(client.db, randomUUID(), {
    order: { orderNo: "SO-PL-001", customerCode: "ACME", orgId: 2, subInventoryCode: "STORE1" },
    items: [
      { partNo: "RK73H2ATTD1372F", qty: 1500 },
      { partNo: "RK73H1JTTD3302F", qty: 200 },
    ],
  });
  await insertPickingOrder(client.db, randomUUID(), {
    order: { orderNo: "SO-PL-002", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "RK73H2ATTD1372F", qty: 1000 }],
  });
  await allocateAll(client.db);
  return orderId;
}

test("GET shipper: 404 for an unknown receiving order", async () => {
  await reseed(client);
  const res = await req(`/admin/receiving-orders/${randomUUID()}/shipper`);
  assert.equal(res.status, 404);
});

test("GET shipper: merged part blocks with per-block order slots and balance", async () => {
  await reseed(client);
  const orderId = await seedScenario();

  const res = await req(`/admin/receiving-orders/${orderId}/shipper`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("Content-Type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  assert.match(res.headers.get("Content-Disposition") ?? "", /shipper-PL-TEST-01\.xlsx/);

  const rows = await sheetRows(await res.arrayBuffer());

  // Title block
  assert.match(String(rows[0]![0]), /^Shipper — PL-TEST-01 \(DAITO\)/);
  assert.equal(rows[1]![0], "Date: 2026-09-07");
  assert.equal(rows[2]![0], "Total Ctn: 2");

  // Generic slot headers (the widest block — the 2-carton group — merges 3
  // allocations): the actual customer / order_no values ride on each group's
  // own block.
  assert.deepEqual(rows[4], ["Invoice / Ctn", "Part Number", "Qty", "Total Qty", "Customer", "Customer", "Customer", "Balance"]);
  assert.deepEqual(rows[5], ["", "Shelf", "", "", "Order No", "Order No", "Order No", ""]);
  assert.deepEqual(rows[6], ["", "", "", "", "", "", "", ""]); // blank row after the header

  // RK73H1JTTD3302F group first (alphabetical): the receipt has no item-level
  // allocations; order-level covers 200 of 500. The group header cell shows
  // the related-order allocated qty: SO-PL-001 + SO-PL-002 are related (both
  // draw on this order), and their allocations for this part sum to 200. The
  // whole-order block closes the group carrying Total/Balance.
  assert.deepEqual(rows[7], ["", "", "", "", "", "", "", ""]); // customer names (none)
  assert.deepEqual(rows[8], ["", 200, "", "", "", "", "", ""]); // related allocated + order refs
  assert.deepEqual(rows[9], ["INV-PL-01", "RK73H1JTTD3302F", 500, "", "", "", "", ""]);
  assert.deepEqual(rows[10], ["", "", "", "", "ACME Electronics (HK)", "", "", ""]);
  assert.deepEqual(rows[11], ["", "", "", "", "SO-PL-001", "", "", ""]);
  assert.deepEqual(rows[12], ["(order-level)", "RK73H1JTTD3302F", "", 500, 200, "", "", 300]);
  assert.deepEqual(rows[13], ["", "", "", "", "", "", "", ""]); // group separator

  // RK73H2ATTD1372F group: both cartons merge into ONE block — item rows
  // stack, the slot rows overlay the block's last three rows. FIFO gives
  // SO-PL-001 1000 from ctn 7001 + 500 from ctn 7002; SO-PL-002 takes 1000
  // from ctn 7002, so SO-PL-001 occupies two slots. The related-order
  // allocated qty (1500 + 1000 = 2500) sits in the Total Qty column of the
  // order-ref row.
  assert.deepEqual(rows[14], ["", "", "", "", "ACME Electronics (HK)", "ACME Electronics (HK)", "SO-PL-002", ""]);
  assert.deepEqual(rows[15], ["INV-PL-01 7001", "RK73H2ATTD1372F", 1000, 2500, "SO-PL-001", "SO-PL-001", "SO-PL-002", ""]);
  assert.deepEqual(rows[16], ["INV-PL-01 7002", "RK73H2ATTD1372F", 2000, 3000, 1000, 500, 1000, 500]);

  assert.equal(rows.length, 17);
});

test("GET shipper: reflects current allocations — recompute happens on the reallocate endpoint, not the download", async () => {
  await reseed(client);
  const orderId = await seedScenario();

  // New demand arrives AFTER the last allocateAll — the download alone must
  // NOT pick it up (no in-request recompute since 2026-09-15).
  await insertPickingOrder(client.db, randomUUID(), {
    order: { orderNo: "SO-PL-003", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "RK73H2ATTD1372F", qty: 500 }],
  });

  const resBefore = await req(`/admin/receiving-orders/${orderId}/shipper`);
  assert.equal(resBefore.status, 200);
  const rowsBefore = await sheetRows(await resBefore.arrayBuffer());
  // Still 3 slots (SO-PL-001 ×2, SO-PL-002); SO-PL-003 absent, balance 500.
  // The related-order allocated cell still sums only SO-PL-001 + SO-PL-002.
  assert.deepEqual(rowsBefore[4], ["Invoice / Ctn", "Part Number", "Qty", "Total Qty", "Customer", "Customer", "Customer", "Balance"]);
  assert.deepEqual(rowsBefore[15], ["INV-PL-01 7001", "RK73H2ATTD1372F", 1000, 2500, "SO-PL-001", "SO-PL-001", "SO-PL-002", ""]);
  assert.deepEqual(rowsBefore[16], ["INV-PL-01 7002", "RK73H2ATTD1372F", 2000, 3000, 1000, 500, 1000, 500]);

  // The separate re-allocate endpoint runs the scoped recompute…
  const re = await req(`/admin/receiving-orders/${orderId}/reallocate`, { method: "POST" });
  assert.equal(re.status, 200);
  assert.ok((await re.json()).allocation);

  // …and the next download reflects it: the 500 balance of ctn 7002 goes to
  // SO-PL-003 — the merged RK73H2ATTD1372F block now has 4 slots, zero balance.
  const res = await req(`/admin/receiving-orders/${orderId}/shipper`);
  assert.equal(res.status, 200);

  const rows = await sheetRows(await res.arrayBuffer());

  assert.deepEqual(rows[4], ["Invoice / Ctn", "Part Number", "Qty", "Total Qty", "Customer", "Customer", "Customer", "Customer", "Balance"]);
  assert.deepEqual(rows[14], ["", "", "", "", "ACME Electronics (HK)", "ACME Electronics (HK)", "SO-PL-002", "SO-PL-003", ""]);
  assert.deepEqual(rows[15], ["INV-PL-01 7001", "RK73H2ATTD1372F", 1000, 3000, "SO-PL-001", "SO-PL-001", "SO-PL-002", "SO-PL-003", ""]);
  assert.deepEqual(rows[16], ["INV-PL-01 7002", "RK73H2ATTD1372F", 2000, 3000, 1000, 500, 1000, 500, 0]);
});

test("GET shipper: group header counts stock-sourced allocations on related orders, ignores unrelated orders", async () => {
  await reseed(client);
  const orderId = await seedScenario();

  const so1 = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_orders WHERE order_no = 'SO-PL-001'`
  );
  const piH1 = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_items WHERE picking_order_id = ${so1!.id} AND part_no = 'RK73H1JTTD3302F'`
  );

  // Stock-sourced allocation on a RELATED order (SO-PL-001 also draws on this
  // receiving order): +50 for the RK73H1JTTD3302F group.
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, shelf_code, box_id, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-REL-01', 'RK73H1JTTD3302F', 'A-04-05', 'RELBOX1', 2, 'STORE1', 200, now(), now())
  `);
  await client.db.execute(sql`
    INSERT INTO allocations (id, picking_item_id, inventory_lot_id, qty, created_date, last_update_date)
    VALUES (${randomUUID()}, ${piH1!.id}, 'LOT-REL-01', 50, now(), now())
  `);

  // An UNRELATED order (nothing traces back to this receiving order) with its
  // own stock-sourced allocation: must NOT be counted.
  await insertPickingOrder(client.db, randomUUID(), {
    order: { orderNo: "SO-PL-009", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "RK73H2ATTD1372F", qty: 800 }],
  });
  const piH2Unrelated = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT pi.id FROM picking_items pi JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE po.order_no = 'SO-PL-009' AND pi.part_no = 'RK73H2ATTD1372F'`
  );
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, shelf_code, box_id, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-UNREL-01', 'RK73H2ATTD1372F', 'A-04-05', 'UNRELBOX1', 2, 'STORE1', 800, now(), now())
  `);
  await client.db.execute(sql`
    INSERT INTO allocations (id, picking_item_id, inventory_lot_id, qty, created_date, last_update_date)
    VALUES (${randomUUID()}, ${piH2Unrelated!.id}, 'LOT-UNREL-01', 800, now(), now())
  `);

  const res = await req(`/admin/receiving-orders/${orderId}/shipper`);
  assert.equal(res.status, 200);
  const rows = await sheetRows(await res.arrayBuffer());

  // RK73H1JTTD3302F: 200 order-level (from this receiving) + 50 stock = 250.
  assert.deepEqual(rows[8], ["", 250, "", "", "", "", "", ""]);
  // RK73H2ATTD1372F: still 2500 — SO-PL-009's 800 is not related.
  assert.deepEqual(rows[15], ["INV-PL-01 7001", "RK73H2ATTD1372F", 1000, 2500, "SO-PL-001", "SO-PL-001", "SO-PL-002", ""]);
});

test("GET shipper?mode=finished: slots come from actual picked packages", async () => {
  await reseed(client);
  const orderId = await seedScenario();

  const items = await queryAll<{ id: string; partNo: string; ctnNo: string | null }>(
    client.db,
    sql`SELECT rii.id, rii.part_no AS "partNo", rii.ctn_no AS "ctnNo"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId}`
  );
  const ctn7001 = items.find((i) => i.ctnNo === "7001")!;
  const noCtn = items.find((i) => i.partNo === "RK73H1JTTD3302F")!;

  const so1 = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_orders WHERE order_no = 'SO-PL-001'`
  );
  const pickingItems = await queryAll<{ id: string; partNo: string }>(
    client.db,
    sql`SELECT id, part_no AS "partNo" FROM picking_items WHERE picking_order_id = ${so1!.id}`
  );
  const piH2 = pickingItems.find((p) => p.partNo === "RK73H2ATTD1372F")!;
  const piH1 = pickingItems.find((p) => p.partNo === "RK73H1JTTD3302F")!;

  // Actuals: 400 picked straight off ctn 7001 (dock stock), and 150 of the
  // no-ctn part picked from a put-away lot traced via inventory_lot_sources.
  await client.db.execute(sql`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, created_date, last_update_date)
    VALUES (${randomUUID()}, ${piH2.id}, ${so1!.id}, 'receiving_invoice_item', ${ctn7001.id}, 400, now(), now())
  `);
  await client.db.execute(sql`
    INSERT INTO inventory_lots (id, part_no, shelf_code, box_id, org_id, sub_inventory_code, total_qty, created_date, last_update_date)
    VALUES ('LOT-FIN-01', 'RK73H1JTTD3302F', 'A-04-05', 'FINBOX1', 2, 'STORE1', 500, now(), now())
  `);
  await client.db.execute(sql`
    INSERT INTO inventory_lot_sources (id, inventory_lot_id, receiving_invoice_item_id, qty, created_date, last_update_date)
    VALUES (${randomUUID()}, 'LOT-FIN-01', ${noCtn.id}, 500, now(), now())
  `);
  await client.db.execute(sql`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, created_date, last_update_date)
    VALUES (${randomUUID()}, ${piH1.id}, ${so1!.id}, 'inventory_lot', 'LOT-FIN-01', 150, now(), now())
  `);

  // Order completed.
  await client.db.execute(sql`UPDATE receiving_orders SET status = 'clear' WHERE id = ${orderId}`);

  const res = await req(`/admin/receiving-orders/${orderId}/shipper?mode=finished`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Disposition") ?? "", /finished-shipper-PL-TEST-01\.xlsx/);

  const rows = await sheetRows(await res.arrayBuffer());

  assert.match(String(rows[0]![0]), /^Finished Shipper — PL-TEST-01 \(DAITO\)/);
  assert.equal(rows[1]![0], "Date: 2026-09-07");
  assert.equal(rows[2]![0], "Total Ctn: 2");

  // One slot per group (only SO-PL-001 actually picked).
  assert.deepEqual(rows[4], ["Invoice / Ctn", "Part Number", "Qty", "Total Qty", "Customer", "Balance"]);
  assert.deepEqual(rows[5], ["", "Shelf", "", "", "Order No", ""]);
  assert.deepEqual(rows[6], ["", "", "", "", "", ""]);

  // RK73H1JTTD3302F: 150 of 500 actually picked (lot-traced) → balance 350.
  // No group header cell in finished mode.
  assert.deepEqual(rows[7], ["", "", "", "", "ACME Electronics (HK)", ""]);
  assert.deepEqual(rows[8], ["", "", "", "", "SO-PL-001", ""]);
  assert.deepEqual(rows[9], ["INV-PL-01", "RK73H1JTTD3302F", 500, 500, 150, 350]);
  assert.deepEqual(rows[10], ["", "", "", "", "", ""]);

  // RK73H2ATTD1372F: 400 of 3000 actually picked (direct from ctn 7001).
  assert.deepEqual(rows[11], ["", "", "", "", "ACME Electronics (HK)", ""]);
  assert.deepEqual(rows[12], ["INV-PL-01 7001", "RK73H2ATTD1372F", 1000, "", "SO-PL-001", ""]);
  assert.deepEqual(rows[13], ["INV-PL-01 7002", "RK73H2ATTD1372F", 2000, 3000, 400, 2600]);

  assert.equal(rows.length, 14);
});
