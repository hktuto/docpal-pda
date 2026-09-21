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
import { unzipSync } from "fflate";
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


test("GET shipper: HCC (supplier 23) renders the drawing-no first column; other suppliers keep Invoice / Ctn", async () => {
  await reseed(client);
  // Hermetic: the demo seed's picking orders would allocate against these
  // receipts and add slot columns (same reason as seedScenario).
  await client.db.execute(sql`DELETE FROM picking_orders`);
  const actorId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`)
  )!.id;
  // receiving_orders.supplier_code FKs to suppliers.code — seed HCC.
  await client.db.execute(
    sql`INSERT INTO suppliers (id, code, name) VALUES (${randomUUID()}, '23', 'HCC') ON CONFLICT (code) DO NOTHING`
  );

  // HCC order: first column header/value switch to the drawing number
  // (spec 2026-09-21-shipper-hcc-drawing-no-variant-design.md).
  const hccOrderId = await insertReceivingOrder(client.db, "HCC-TEST-01", {
    order: { supplierCode: "23", deliveryDate: "2026-09-21" },
    invoices: [
      {
        invoiceNo: "INV-HCC-01",
        totalCtn: 1,
        items: [
          { partNo: "HCC-PART-1", lineQty: 100, ctnNo: "7001", orgId: 2, subInventoryCode: "STORE1", additionalData: { drawing_no: "DRWG-9001" } },
        ],
      },
    ],
  });
  await confirmReceivingArrival(client.db, hccOrderId, actorId);
  // Non-HCC order in the same run: the default layout still applies
  // (registry scoping — the HCC variant must not leak across suppliers).
  const daitoOrderId = await insertReceivingOrder(client.db, "PL-TEST-HCC-CTRL", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-09-21" },
    invoices: [
      {
        invoiceNo: "INV-CTRL-01",
        totalCtn: 1,
        items: [{ partNo: "CTRL-PART-1", lineQty: 100, ctnNo: "8001", orgId: 2, subInventoryCode: "STORE1" }],
      },
    ],
  });
  await confirmReceivingArrival(client.db, daitoOrderId, actorId);

  const hccRes = await req(`/admin/receiving-orders/${hccOrderId}/shipper`);
  assert.equal(hccRes.status, 200);
  const hccRows = await sheetRows(await hccRes.arrayBuffer());

  assert.match(String(hccRows[0]![0]), /^Shipper — HCC-TEST-01/);
  // No allocations → zero Customer slots; the first header cell switches.
  assert.deepEqual(hccRows[4], ["Drawing No / CTN", "Part Number", "Qty", "Total Qty", "Balance"]);
  assert.deepEqual(hccRows[5], ["", "Shelf", "", "", ""]);
  // Single-carton block: drawing_no + ctn_no on the item row, totals on the
  // block's last row (no invoice_no anywhere — no fallback).
  assert.deepEqual(hccRows[7], ["", "", "", "", ""]);
  assert.deepEqual(hccRows[8], ["", "", "", "", ""]);
  assert.deepEqual(hccRows[9], ["DRWG-9001 7001", "HCC-PART-1", 100, 100, 100]);
  assert.equal(hccRows.length, 10);

  const ctrlRes = await req(`/admin/receiving-orders/${daitoOrderId}/shipper`);
  assert.equal(ctrlRes.status, 200);
  const ctrlRows = await sheetRows(await ctrlRes.arrayBuffer());
  assert.deepEqual(ctrlRows[4], ["Invoice / Ctn", "Part Number", "Qty", "Total Qty", "Balance"]);
  assert.deepEqual(ctrlRows[9], ["INV-CTRL-01 8001", "CTRL-PART-1", 100, 100, 100]);
});

// Split by location (spec 2026-09-21-shipper-split-by-location-design.md):
// ?split=location emits one xlsx per receiving-office (org_id,
// sub_inventory_code) section — a zip when the order spans >1 section, the
// plain per-section xlsx when it spans exactly one.

/** Zip member name → sheet rows, in member order. */
function zipSheets(buf: ArrayBuffer): [string, (string | number)[][]][] {
  return Object.entries(unzipSync(new Uint8Array(buf))).map(([name, data]) => {
    const wb = XLSX.read(Buffer.from(data));
    const ws = wb.Sheets[wb.SheetNames[0]!]!;
    return [name, XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" })];
  });
}

// Two-section live scenario: PART-A-1 (ctn 9001, STORE1) + PART-B-1
// (ctn 9002, WSTORE1); SO-SP-001 (STORE1) draws 60 of PART-A-1, SO-SP-002
// (WSTORE1) draws 80 of PART-B-1 (both item-level).
async function seedSplitScenario(): Promise<string> {
  await client.db.execute(sql`DELETE FROM picking_orders`);
  const orderId = await insertReceivingOrder(client.db, "PL-TEST-SP1", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-09-21" },
    invoices: [
      {
        invoiceNo: "INV-SP-01",
        totalCtn: 2,
        items: [
          { partNo: "PART-A-1", poNo: "PO-A", poLine: "1", lineQty: 100, ctnNo: "9001", orgId: 2, subInventoryCode: "STORE1" },
          { partNo: "PART-B-1", poNo: "PO-B", poLine: "1", lineQty: 200, ctnNo: "9002", orgId: 2, subInventoryCode: "WSTORE1" },
        ],
      },
    ],
  });
  const actorId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`)
  )!.id;
  await confirmReceivingArrival(client.db, orderId, actorId);

  await insertPickingOrder(client.db, randomUUID(), {
    order: { orderNo: "SO-SP-001", customerCode: "ACME", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "PART-A-1", qty: 60 }],
  });
  await insertPickingOrder(client.db, randomUUID(), {
    order: { orderNo: "SO-SP-002", orgId: 2, subInventoryCode: "WSTORE1" },
    items: [{ partNo: "PART-B-1", qty: 80 }],
  });
  await allocateAll(client.db);
  return orderId;
}

test("GET shipper?split=location: two sections → zip of per-section xlsx, item-level slots stay in their item's section", async () => {
  await reseed(client);
  const orderId = await seedSplitScenario();

  const res = await req(`/admin/receiving-orders/${orderId}/shipper?split=location`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/zip");
  assert.match(res.headers.get("Content-Disposition") ?? "", /shipper-PL-TEST-SP1\.zip/);

  const members = zipSheets(await res.arrayBuffer());
  assert.deepEqual(
    members.map(([name]) => name),
    ["shipper-PL-TEST-SP1-org2-STORE1.xlsx", "shipper-PL-TEST-SP1-org2-WSTORE1.xlsx"]
  );

  const store1 = members[0]![1]!;
  assert.match(String(store1[0]![0]), /^Shipper — PL-TEST-SP1 \(DAITO\)/);
  assert.deepEqual(store1[4], ["Invoice / Ctn", "Part Number", "Qty", "Total Qty", "Customer", "Balance"]);
  // Single-carton block: related allocated (60, pair-matched to STORE1) sits
  // in column B of the order-ref row; the item row carries the slot.
  assert.deepEqual(store1[7], ["", "", "", "", "ACME Electronics (HK)", ""]);
  assert.deepEqual(store1[8], ["", 60, "", "", "SO-SP-001", ""]);
  assert.deepEqual(store1[9], ["INV-SP-01 9001", "PART-A-1", 100, 100, 60, 40]);
  assert.equal(store1.length, 10);

  const wstore1 = members[1]![1]!;
  assert.deepEqual(wstore1[7], ["", "", "", "", "SO-SP-002", ""]);
  assert.deepEqual(wstore1[8], ["", 80, "", "", "SO-SP-002", ""]);
  assert.deepEqual(wstore1[9], ["INV-SP-01 9002", "PART-B-1", 200, 200, 80, 120]);
  assert.equal(wstore1.length, 10);
});

test("GET shipper?split=location: whole-order slots attribute by the picking order's pair, fallback to the part's first section", async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM picking_orders`);
  const orderId = await insertReceivingOrder(client.db, "PL-TEST-SP2", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-09-21" },
    invoices: [
      {
        invoiceNo: "INV-SP2-01",
        totalCtn: 1,
        items: [
          { partNo: "PART-C-1", poNo: "PO-C", poLine: "1", lineQty: 300, orgId: 2, subInventoryCode: "STORE1" },
          { partNo: "PART-E-1", poNo: "PO-E", poLine: "1", lineQty: 50, ctnNo: "9003", orgId: 2, subInventoryCode: "WSTORE1" },
        ],
      },
    ],
  });
  const actorId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`)
  )!.id;
  await confirmReceivingArrival(client.db, orderId, actorId);

  // SO-WO-1's pair (2, STORE1) matches PART-C-1's section; SO-WO-2's pair
  // (140, STORE1) matches no section → falls back to the part's first
  // section (STORE1). Inserted directly — deterministic, no allocateAll.
  await insertPickingOrder(client.db, randomUUID(), {
    order: { orderNo: "SO-WO-1", orgId: 2, subInventoryCode: "STORE1" },
    items: [{ partNo: "PART-C-1", qty: 100 }],
  });
  await insertPickingOrder(client.db, randomUUID(), {
    order: { orderNo: "SO-WO-2", orgId: 140, subInventoryCode: "STORE1" },
    items: [{ partNo: "PART-C-1", qty: 50 }],
  });
  const pis = await queryAll<{ id: string; orderNo: string }>(
    client.db,
    sql`SELECT pi.id, po.order_no AS "orderNo" FROM picking_items pi
        JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE po.order_no IN ('SO-WO-1', 'SO-WO-2')`
  );
  for (const pi of pis) {
    await client.db.execute(sql`
      INSERT INTO allocations (id, picking_item_id, receiving_order_id, qty, created_date, last_update_date)
      VALUES (${randomUUID()}, ${pi.id}, ${orderId}, ${pi.orderNo === "SO-WO-1" ? 100 : 50}, now(), now())
    `);
  }

  const res = await req(`/admin/receiving-orders/${orderId}/shipper?split=location`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/zip");

  const members = zipSheets(await res.arrayBuffer());
  assert.deepEqual(
    members.map(([name]) => name),
    ["shipper-PL-TEST-SP2-org2-STORE1.xlsx", "shipper-PL-TEST-SP2-org2-WSTORE1.xlsx"]
  );

  const store1 = members[0]![1]!;
  assert.deepEqual(store1[4], ["Invoice / Ctn", "Part Number", "Qty", "Total Qty", "Customer", "Customer", "Balance"]);
  // Both whole-order slots land in STORE1 — SO-WO-1 by pair match, SO-WO-2
  // by fallback; the related cell (column B of the order-ref row) sums both.
  assert.deepEqual(store1[8], ["", 150, "", "", "", "", ""]);
  assert.deepEqual(store1[9], ["INV-SP2-01", "PART-C-1", 300, "", "", "", ""]);
  assert.deepEqual(store1[10], ["", "", "", "", "SO-WO-1", "SO-WO-2", ""]);
  assert.deepEqual(store1[11], ["", "", "", "", "SO-WO-1", "SO-WO-2", ""]);
  assert.deepEqual(store1[12], ["(order-level)", "PART-C-1", "", 300, 100, 50, 150]);
  assert.equal(store1.length, 13);

  const wstore1 = members[1]![1]!;
  assert.deepEqual(wstore1[4], ["Invoice / Ctn", "Part Number", "Qty", "Total Qty", "Balance"]);
  assert.deepEqual(wstore1[9], ["INV-SP2-01 9003", "PART-E-1", 50, 50, 50]);
  assert.equal(wstore1.length, 10);
});

test("GET shipper?split=location: NULL sub-inventory items form the no-subinventory section, ordered last", async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM picking_orders`);
  const orderId = await insertReceivingOrder(client.db, "PL-TEST-SP3", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-09-21" },
    invoices: [
      {
        invoiceNo: "INV-SP3-01",
        totalCtn: 2,
        items: [
          { partNo: "PART-N-1", lineQty: 10, ctnNo: "9005", orgId: 2, subInventoryCode: null },
          { partNo: "PART-S-1", lineQty: 20, ctnNo: "9006", orgId: 2, subInventoryCode: "STORE1" },
        ],
      },
    ],
  });
  const actorId = (
    await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`)
  )!.id;
  await confirmReceivingArrival(client.db, orderId, actorId);

  const res = await req(`/admin/receiving-orders/${orderId}/shipper?split=location`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/zip");

  const members = zipSheets(await res.arrayBuffer());
  assert.deepEqual(
    members.map(([name]) => name),
    ["shipper-PL-TEST-SP3-org2-STORE1.xlsx", "shipper-PL-TEST-SP3-org2-no-subinventory.xlsx"]
  );
  assert.deepEqual(members[0]![1]![9], ["INV-SP3-01 9006", "PART-S-1", 20, 20, 20]);
  assert.deepEqual(members[1]![1]![9], ["INV-SP3-01 9005", "PART-N-1", 10, 10, 10]);
});

test("GET shipper?split=location: single-section order returns the plain per-section xlsx, not a zip", async () => {
  await reseed(client);
  const orderId = await seedScenario();

  const res = await req(`/admin/receiving-orders/${orderId}/shipper?split=location`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("Content-Type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  assert.match(res.headers.get("Content-Disposition") ?? "", /shipper-PL-TEST-01-org2-STORE1\.xlsx/);

  // Same rows as the combined download.
  const rows = await sheetRows(await res.arrayBuffer());
  assert.deepEqual(rows[15], ["INV-PL-01 7001", "RK73H2ATTD1372F", 1000, 2500, "SO-PL-001", "SO-PL-001", "SO-PL-002", ""]);
  assert.deepEqual(rows[16], ["INV-PL-01 7002", "RK73H2ATTD1372F", 2000, 3000, 1000, 500, 1000, 500]);
  assert.equal(rows.length, 17);
});

test("GET shipper?mode=finished&split=location: package slots attribute per section", async () => {
  await reseed(client);
  const orderId = await seedSplitScenario();

  const items = await queryAll<{ id: string; ctnNo: string | null }>(
    client.db,
    sql`SELECT rii.id, rii.ctn_no AS "ctnNo"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId}`
  );
  const orders = await queryAll<{ id: string; orderNo: string }>(
    client.db,
    sql`SELECT id, order_no AS "orderNo" FROM picking_orders WHERE order_no IN ('SO-SP-001', 'SO-SP-002')`
  );
  const so1 = orders.find((o) => o.orderNo === "SO-SP-001")!;
  const so2 = orders.find((o) => o.orderNo === "SO-SP-002")!;
  const piA = (
    await queryGet<{ id: string }>(
      client.db,
      sql`SELECT id FROM picking_items WHERE picking_order_id = ${so1.id} AND part_no = 'PART-A-1'`
    )
  )!;
  const piB = (
    await queryGet<{ id: string }>(
      client.db,
      sql`SELECT id FROM picking_items WHERE picking_order_id = ${so2.id} AND part_no = 'PART-B-1'`
    )
  )!;
  await client.db.execute(sql`
    INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, created_date, last_update_date)
    VALUES
      (${randomUUID()}, ${piA.id}, ${so1.id}, 'receiving_invoice_item', ${items.find((i) => i.ctnNo === "9001")!.id}, 40, now(), now()),
      (${randomUUID()}, ${piB.id}, ${so2.id}, 'receiving_invoice_item', ${items.find((i) => i.ctnNo === "9002")!.id}, 70, now(), now())
  `);
  await client.db.execute(sql`UPDATE receiving_orders SET status = 'clear' WHERE id = ${orderId}`);

  const res = await req(`/admin/receiving-orders/${orderId}/shipper?mode=finished&split=location`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/zip");
  assert.match(res.headers.get("Content-Disposition") ?? "", /finished-shipper-PL-TEST-SP1\.zip/);

  const members = zipSheets(await res.arrayBuffer());
  assert.deepEqual(
    members.map(([name]) => name),
    ["finished-shipper-PL-TEST-SP1-org2-STORE1.xlsx", "finished-shipper-PL-TEST-SP1-org2-WSTORE1.xlsx"]
  );

  const store1 = members[0]![1]!;
  assert.match(String(store1[0]![0]), /^Finished Shipper — PL-TEST-SP1 \(DAITO\)/);
  assert.deepEqual(store1[4], ["Invoice / Ctn", "Part Number", "Qty", "Total Qty", "Customer", "Balance"]);
  assert.deepEqual(store1[8], ["", "", "", "", "SO-SP-001", ""]);
  assert.deepEqual(store1[9], ["INV-SP-01 9001", "PART-A-1", 100, 100, 40, 60]);
  assert.equal(store1.length, 10);

  const wstore1 = members[1]![1]!;
  assert.deepEqual(wstore1[8], ["", "", "", "", "SO-SP-002", ""]);
  assert.deepEqual(wstore1[9], ["INV-SP-01 9002", "PART-B-1", 200, 200, 70, 130]);
  assert.equal(wstore1.length, 10);
});
