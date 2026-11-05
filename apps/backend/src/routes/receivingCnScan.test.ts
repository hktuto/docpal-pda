// CN receiving scan task routes (specs
// docs/superpowers/plans/2026-11-01-cn-receiving-scan.md and
// docs/superpowers/specs/2026-11-04-cn-receiving-scan-grouping-design.md): the
// pdf path's confirm/cron finalize moves a CN order to `scanning`; the PDA
// scans physical labels and the server-side aggregate matcher credits the
// matching OPEN items FIFO (partial credits stay open, over-scan →
// warning/qty_mismatch + lastScan.overQty), flags resolve to error, reset
// clears, and finalize receives min(scan_qty, line_qty) on the non-error
// lines into the CN put-away world. Seeds the scanning order directly (no
// DocPal workflow needed).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";
import { _setCnReceivingForTests, _resetFlowConfigForTests } from "../config.js";
import { queryAll, queryGet } from "../db/query.js";
import { getCnPutAwayTaskDetail } from "../db/putawayCn.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../index.js"))["app"];

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
  _setCnReceivingForTests(true); // the whole surface 404s while the receiving-cn step is off
});

after(() => {
  _resetFlowConfigForTests();
});

async function login(username: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

interface SeedItem {
  partNo: string;
  lineQty: number | null;
  wclItemNo?: string;
  poNo?: string;
  poLine?: string;
  dateCode?: string;
  lotCode?: string;
  coo?: string;
  cow?: string;
}

/** Seed a CN order straight at `scanning` (what confirm/finalize produces). */
async function seedScanningOrder(batchNo: string, items: SeedItem[]): Promise<{ orderId: string; itemIds: string[] }> {
  const orderId = `cn-order-${batchNo}`;
  await client.db.execute(
    sql`INSERT INTO receiving_orders_cn (id, batch_no, status, delivery_date, org_id, arrived_at)
        VALUES (${orderId}, ${batchNo}, 'scanning', '2026-10-10', 2, now())`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoices_cn (id, receiving_order_id, invoice_no, org_id)
        VALUES (${`cn-inv-${batchNo}`}, ${orderId}, ${`INV-${batchNo}`}, 2)`
  );
  const itemIds: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const itemId = `cn-item-${batchNo}-${i}`;
    itemIds.push(itemId);
    const it = items[i];
    await client.db.execute(
      sql`INSERT INTO receiving_invoice_items_cn (id, receiving_invoice_id, part_no, wcl_item_no, po_no, po_line, line_qty, received_qty, date_code, lot_code, coo, cow, org_id, sub_inventory_code)
          VALUES (${itemId}, ${`cn-inv-${batchNo}`}, ${it.partNo}, ${it.wclItemNo ?? null}, ${it.poNo ?? "PO-1"}, ${it.poLine ?? null},
                  ${it.lineQty}, 0, ${it.dateCode ?? null}, ${it.lotCode ?? null}, ${it.coo ?? null}, ${it.cow ?? null}, 2, 'STORE1')`
    );
  }
  return { orderId, itemIds };
}

async function call(token: string, method: string, url: string, body?: unknown) {
  return app.request(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface DetailItem {
  id: string;
  partNo: string;
  scanStatus: string | null;
  scanQty: number | null;
  scanReason: string | null;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
}

interface AggregateResponse {
  order: { id: string; batchNo: string; status: string };
  items: DetailItem[];
  lastScan: { overQty: number };
}

test("config gate: the scan-task surface 404s while the receiving-cn step is off", async () => {
  await reseed(client);
  _setCnReceivingForTests(false);
  try {
    const token = await login("operator", "DocPal2026!");
    const res = await call(token, "GET", "/receiving-cn/scan-tasks");
    assert.equal(res.status, 404);
  } finally {
    _setCnReceivingForTests(true);
  }
});

test("list: only scanning orders, with item/resolved counts, oldest first", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  await seedScanningOrder("CN-SCAN-L1", [
    { partNo: "PART-A", lineQty: 100 },
    { partNo: "PART-B", lineQty: 50 },
  ]);
  await seedScanningOrder("CN-SCAN-L2", [{ partNo: "PART-C", lineQty: 10 }]);
  // Non-scanning orders are excluded.
  await client.db.execute(
    sql`INSERT INTO receiving_orders_cn (id, batch_no, status, org_id) VALUES ('cn-order-ih', 'CN-IH-1', 'in_hand', 2)`
  );
  // Resolve L2's item via the aggregate scan to check the resolved count.
  await call(token, "POST", "/receiving-cn/scan-tasks/cn-order-CN-SCAN-L2/scan-aggregate", { partNo: "PART-C", qty: 10 });

  const res = await call(token, "GET", "/receiving-cn/scan-tasks");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as {
    id: string;
    batchNo: string;
    invoiceNos: string;
    itemCount: number;
    resolvedCount: number;
    orgId: number;
  }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].batchNo, "CN-SCAN-L1"); // oldest first
  assert.equal(rows[0].itemCount, 2);
  assert.equal(rows[0].resolvedCount, 0);
  assert.equal(rows[0].invoiceNos, "INV-CN-SCAN-L1");
  assert.equal(rows[1].batchNo, "CN-SCAN-L2");
  assert.equal(rows[1].resolvedCount, 1);
});

test("detail: order + items with scan fields; 404 receiving_cn_scan_task_not_found unless scanning", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-D1", [
    { partNo: "RK73B1JTTD181G", lineQty: 300, wclItemNo: "WCL/181G", poNo: "329062100T3", dateCode: "2641" },
  ]);

  const res = await call(token, "GET", `/receiving-cn/scan-tasks/${orderId}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    order: { id: string; batchNo: string; status: string; invoiceNos: string };
    items: {
      id: string;
      partNo: string;
      wclItemNo: string | null;
      poNo: string | null;
      lineQty: number;
      dateCode: string | null;
      orgId: number;
      subInventoryCode: string | null;
      scanStatus: string | null;
      scanQty: number | null;
    }[];
  };
  assert.equal(body.order.batchNo, "CN-SCAN-D1");
  assert.equal(body.order.status, "scanning");
  assert.equal(body.order.invoiceNos, "INV-CN-SCAN-D1");
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, itemIds[0]);
  assert.equal(body.items[0].partNo, "RK73B1JTTD181G");
  assert.equal(body.items[0].lineQty, 300);
  assert.equal(body.items[0].subInventoryCode, "STORE1");
  assert.equal(body.items[0].scanStatus, null);

  // A non-scanning order is not a scan task.
  await client.db.execute(
    sql`INSERT INTO receiving_orders_cn (id, batch_no, status, org_id) VALUES ('cn-order-pend', 'CN-PEND-1', 'pending', 2)`
  );
  const pending = await call(token, "GET", "/receiving-cn/scan-tasks/cn-order-pend");
  assert.equal(pending.status, 404);
  assert.match(await pending.text(), /receiving_cn_scan_task_not_found/);
  const missing = await call(token, "GET", "/receiving-cn/scan-tasks/nope");
  assert.equal(missing.status, 404);
});

test("aggregate scan: FIFO credit across same-part lines; partial credit stays open; response is the full detail + lastScan", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-A1", [
    { partNo: "PART-A", lineQty: 100, poNo: "PO-1", poLine: "1" },
    { partNo: "PART-A", lineQty: 50, poNo: "PO-1", poLine: "2" },
    { partNo: "PART-B", lineQty: 10 },
  ]);

  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, {
    partNo: "PART-A",
    qty: 120,
    lotCode: "L9",
    coo: "JP",
    raw: ":RAW-1:",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as AggregateResponse;
  assert.equal(body.order.id, orderId);
  assert.equal(body.items.length, 3);
  assert.deepEqual(body.lastScan, { overQty: 0 });
  const [l1, l2, l3] = body.items;
  assert.equal(l1.id, itemIds[0]);
  assert.deepEqual([l1.scanQty, l1.scanStatus], [100, "ok"]); // fully covered → ok
  assert.equal(l1.lotCode, "L9"); // batch fields filled (line was NULL)
  assert.equal(l1.coo, "JP");
  assert.equal(l2.id, itemIds[1]);
  assert.deepEqual([l2.scanQty, l2.scanStatus], [20, null]); // partial → stays open
  assert.equal(l2.lotCode, "L9");
  assert.deepEqual([l3.scanQty, l3.scanStatus], [null, null]); // other part untouched

  // The partial line keeps accumulating; completing it flips it to ok.
  const again = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 30 });
  assert.equal(again.status, 200);
  const againBody = (await again.json()) as AggregateResponse;
  assert.deepEqual([againBody.items[1].scanQty, againBody.items[1].scanStatus], [50, "ok"]);

  // Audit rows per credited line.
  const logs = await queryAll<{ toState: string; metadata: Record<string, unknown> }>(
    client.db,
    sql`SELECT to_state AS "toState", metadata FROM transaction_logs
        WHERE entity_type = 'receiving_invoice_item_cn' AND entity_id IN (${itemIds[0]}, ${itemIds[1]})
        ORDER BY created_date, id`
  );
  assert.deepEqual(
    logs.map((l) => l.toState),
    ["scan_ok", "scan_partial", "scan_ok"]
  );
  assert.equal(logs[0].metadata.qty, 100);
  assert.equal(logs[0].metadata.raw, ":RAW-1:");
  assert.equal(logs[1].metadata.qty, 20);
  assert.equal(logs[2].metadata.qty, 30);
});

test("aggregate scan: part match is space/case-insensitive with TE AMP(...) unwrap, any label↔line key cross combination", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId } = await seedScanningOrder("CN-SCAN-A2", [
    { partNo: "AMP(640385-8)", wclItemNo: "TE-AMP(640385-8)", lineQty: 10 },
  ]);
  // The label scans the bare MPN with odd spacing/casing.
  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, {
    itemId: " 640385-8 ",
    qty: 10,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as AggregateResponse;
  assert.deepEqual([body.items[0].scanQty, body.items[0].scanStatus], [10, "ok"]);
});

test("aggregate scan: over-scan dumps into the last credited line → warning/qty_mismatch + lastScan.overQty", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-A3", [
    { partNo: "PART-A", lineQty: 100, poNo: "PO-1", poLine: "1" },
    { partNo: "PART-A", lineQty: 50, poNo: "PO-1", poLine: "2" },
  ]);
  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 170 });
  assert.equal(res.status, 200);
  const body = (await res.json()) as AggregateResponse;
  assert.deepEqual(body.lastScan, { overQty: 20 });
  const [l1, l2] = body.items;
  assert.equal(l1.id, itemIds[0]);
  assert.deepEqual([l1.scanQty, l1.scanStatus], [100, "ok"]);
  assert.equal(l2.id, itemIds[1]);
  assert.deepEqual([l2.scanQty, l2.scanStatus, l2.scanReason], [70, "warning", "qty_mismatch"]);
});

test("aggregate scan: matching is part-only — label batch fields never filter lines and overwrite the credited line's OCR values", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-A4", [
    { partNo: "PART-A", lineQty: 100, dateCode: "2641", coo: "JP" },
    { partNo: "PART-A", lineQty: 50 }, // NULL batch fields
  ]);

  // A label with dateCode 2641 credits both FIFO (line 2's NULL fields never excluded it).
  const hit = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, {
    partNo: "PART-A",
    qty: 150,
    dateCode: "2641",
  });
  assert.equal(hit.status, 200);
  const hitBody = (await hit.json()) as AggregateResponse;
  assert.deepEqual([hitBody.items[0].scanQty, hitBody.items[0].scanStatus], [100, "ok"]);
  assert.deepEqual([hitBody.items[1].scanQty, hitBody.items[1].scanStatus], [50, "ok"]);

  // A conflicting dateCode still matches — the OCR date_code is replaced by the scanned one.
  const { orderId: orderId2 } = await seedScanningOrder("CN-SCAN-A5", [{ partNo: "PART-A", lineQty: 100, dateCode: "2641" }]);
  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId2}/scan-aggregate`, {
    partNo: "PART-A",
    qty: 10,
    dateCode: "2645",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as AggregateResponse;
  assert.equal(body.items[0].scanQty, 10);
  assert.equal(body.items[0].dateCode, "2645");

  // A label without batch fields also matches; untouched lines keep their OCR values.
  const plain = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId2}/scan-aggregate`, { partNo: "PART-A", qty: 10 });
  assert.equal(plain.status, 200);
  const plainBody = (await plain.json()) as AggregateResponse;
  assert.equal(plainBody.items[0].scanQty, 20);
  assert.equal(plainBody.items[0].dateCode, "2645"); // kept from the earlier overwrite, not re-blanked
  void itemIds;
});

test("aggregate scan: no matching part → 404 no_matching_item; flagged/resolved lines are skipped", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-A6", [
    { partNo: "PART-A", lineQty: 100, poNo: "PO-1", poLine: "1" },
    { partNo: "PART-A", lineQty: 50, poNo: "PO-1", poLine: "2" },
  ]);

  const noPart = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "NOPE", qty: 5 });
  assert.equal(noPart.status, 404);
  assert.match(await noPart.text(), /no_matching_item/);

  // Flag the first line — scans then skip it and credit only the open one.
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/flag`, { reason: "damaged" });
  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 30 });
  assert.equal(res.status, 200);
  const body = (await res.json()) as AggregateResponse;
  assert.deepEqual([body.items[0].scanQty, body.items[0].scanStatus, body.items[0].scanReason], [null, "error", "damaged"]);
  assert.deepEqual([body.items[1].scanQty, body.items[1].scanStatus], [30, null]);

  // Once every matching line is resolved, further scans find nothing.
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 20 });
  const exhausted = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 1 });
  assert.equal(exhausted.status, 404);
  assert.match(await exhausted.text(), /no_matching_item/);
});

test("aggregate scan: NULL line_qty lines credit last and absorb the remainder as warning/qty_mismatch", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-A7", [
    { partNo: "PART-A", lineQty: null, poNo: "PO-1", poLine: "1" }, // sorts first, credits LAST
    { partNo: "PART-A", lineQty: 100, poNo: "PO-1", poLine: "2" },
  ]);
  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 130 });
  assert.equal(res.status, 200);
  const body = (await res.json()) as AggregateResponse;
  assert.deepEqual(body.lastScan, { overQty: 0 }); // absorbed, not over-received
  const byId = new Map(body.items.map((i) => [i.id, i]));
  assert.deepEqual(
    [byId.get(itemIds[1])!.scanQty, byId.get(itemIds[1])!.scanStatus],
    [100, "ok"]
  );
  assert.deepEqual(
    [byId.get(itemIds[0])!.scanQty, byId.get(itemIds[0])!.scanStatus, byId.get(itemIds[0])!.scanReason],
    [30, "warning", "qty_mismatch"]
  );
});

test("aggregate scan: scanned batch fields overwrite existing OCR line values (the label is the source of truth)", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId } = await seedScanningOrder("CN-SCAN-A8", [
    { partNo: "PART-A", lineQty: 100, dateCode: "2641", lotCode: "OLD-LOT" },
  ]);
  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, {
    partNo: "PART-A",
    qty: 100,
    dateCode: "2641",
    lotCode: "NEW-LOT",
    coo: "JP",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as AggregateResponse;
  assert.equal(body.items[0].dateCode, "2641");
  assert.equal(body.items[0].lotCode, "NEW-LOT"); // overwritten — the OCR value was untrustworthy
  assert.equal(body.items[0].coo, "JP"); // filled (line was NULL)

  // A scan without batch fields leaves the stamped values alone.
  const { orderId: orderId2 } = await seedScanningOrder("CN-SCAN-A8B", [
    { partNo: "PART-A", lineQty: 100, dateCode: "2641" },
  ]);
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId2}/scan-aggregate`, { partNo: "PART-A", qty: 50 });
  const body2 = (await (await call(token, "GET", `/receiving-cn/scan-tasks/${orderId2}`)).json()) as AggregateResponse;
  assert.equal(body2.items[0].dateCode, "2641");
});

test("aggregate scan: validation 400s; non-scanning order → 409; unknown order → 404", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId } = await seedScanningOrder("CN-SCAN-A9", [{ partNo: "PART-A", lineQty: 100 }]);

  for (const bad of [{ partNo: "PART-A", qty: 0 }, { partNo: "PART-A", qty: -1 }, { partNo: "PART-A", qty: 1.5 }, { partNo: "PART-A", qty: "abc" }, { qty: 10 }, {}]) {
    const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(await res.text(), /invalid_payload/);
  }

  const missing = await call(token, "POST", "/receiving-cn/scan-tasks/nope/scan-aggregate", { partNo: "PART-A", qty: 1 });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /receiving_cn_scan_task_not_found/);

  await client.db.execute(sql`UPDATE receiving_orders_cn SET status = 'in_hand' WHERE id = ${orderId}`);
  const closed = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 1 });
  assert.equal(closed.status, 409);
  assert.match(await closed.text(), /order_not_scanning/);
});

test("flag: reason → error + mirrored mismatch columns; wrong_part carries wrongPartNo; invalid reason → 400", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-F1", [
    { partNo: "PART-A", lineQty: 100 },
    { partNo: "PART-B", lineQty: 50 },
  ]);

  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/flag`, {
    reason: "damaged",
    note: "纸箱破损",
  });
  assert.equal(res.status, 200);
  const item = (await res.json()) as { scanStatus: string; scanReason: string; scanNote: string };
  assert.equal(item.scanStatus, "error");
  assert.equal(item.scanReason, "damaged");
  assert.equal(item.scanNote, "纸箱破损");
  // Mirrored into the dormant mismatch columns for the admin detail.
  const mirror = await queryGet<{ reportedMismatch: boolean; mismatchReason: string; mismatchNote: string }>(
    client.db,
    sql`SELECT reported_mismatch AS "reportedMismatch", mismatch_reason AS "mismatchReason", mismatch_note AS "mismatchNote"
        FROM receiving_invoice_items_cn WHERE id = ${itemIds[0]}`
  );
  assert.equal(mirror!.reportedMismatch, true);
  assert.equal(mirror!.mismatchReason, "damaged");
  assert.equal(mirror!.mismatchNote, "纸箱破损");

  const wrong = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[1]}/flag`, {
    reason: "wrong_part",
    wrongPartNo: "PART-X",
  });
  assert.equal(wrong.status, 200);
  const wrongRow = await queryGet<{ wrongPartNo: string | null }>(
    client.db,
    sql`SELECT wrong_part_no AS "wrongPartNo" FROM receiving_invoice_items_cn WHERE id = ${itemIds[1]}`
  );
  assert.equal(wrongRow!.wrongPartNo, "PART-X");

  const bad = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/flag`, { reason: "nope" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /invalid_payload/);
});

test("reset: clears the scan state — including a partial scan_qty — and the mirrored mismatch columns back to unresolved", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-R1", [{ partNo: "PART-A", lineQty: 100 }]);
  // Partial aggregate credit (scan_qty set, scan_status still NULL).
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 40 });

  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/reset`);
  assert.equal(res.status, 200);
  const item = (await res.json()) as {
    scanStatus: string | null;
    scanQty: number | null;
    scanReason: string | null;
    scannedBy: string | null;
  };
  assert.equal(item.scanStatus, null);
  assert.equal(item.scanQty, null);
  assert.equal(item.scanReason, null);
  assert.equal(item.scannedBy, null);
  const mirror = await queryGet<{ reportedMismatch: boolean; mismatchReason: string | null; mismatchNote: string | null }>(
    client.db,
    sql`SELECT reported_mismatch AS "reportedMismatch", mismatch_reason AS "mismatchReason", mismatch_note AS "mismatchNote"
        FROM receiving_invoice_items_cn WHERE id = ${itemIds[0]}`
  );
  assert.equal(mirror!.reportedMismatch, false);
  assert.equal(mirror!.mismatchReason, null);
  assert.equal(mirror!.mismatchNote, null);
});

test("finalize: unresolved items → 409 unresolved_items; unresolvedAs 'missing' receives min(scan_qty, line_qty) on non-error lines", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-Z1", [
    { partNo: "PART-A", lineQty: 100, poNo: "PO-1", poLine: "1" }, // exact scan → ok
    { partNo: "PART-B", lineQty: 50, poNo: "PO-1", poLine: "2" }, // over-scan → warning, receives 50
    { partNo: "PART-C", lineQty: null, poNo: "PO-1", poLine: "3" }, // NULL lineQty → warning, receives scan_qty
    { partNo: "PART-D", lineQty: 25, poNo: "PO-1", poLine: "4" }, // flagged damaged (error) → 0
    { partNo: "PART-E", lineQty: 10, poNo: "PO-1", poLine: "5" }, // left unresolved → missing → 0
  ]);
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 100, dateCode: "2645" });
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-B", qty: 60 });
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-C", qty: 25 });
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[3]}/flag`, { reason: "damaged" });

  // The unresolved item blocks the finalize, with the count in the message.
  const blocked = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/finalize`, {});
  assert.equal(blocked.status, 409);
  assert.match(await blocked.text(), /unresolved_items: 1/);

  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/finalize`, { unresolvedAs: "missing" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; batchNo: string; putAwayTaskId: string | null };
  assert.equal(body.batchNo, "CN-SCAN-Z1");
  assert.ok(body.putAwayTaskId); // received lines exist → task created

  const order = await queryGet<{ status: string; arrivedAt: string | null }>(
    client.db,
    sql`SELECT status, arrived_at AS "arrivedAt" FROM receiving_orders_cn WHERE id = ${orderId}`
  );
  assert.equal(order!.status, "in_hand");
  assert.ok(order!.arrivedAt);

  const items = await queryAll<{ id: string; receivedQty: number; scanStatus: string; scanReason: string | null }>(
    client.db,
    sql`SELECT id, received_qty AS "receivedQty", scan_status AS "scanStatus", scan_reason AS "scanReason"
        FROM receiving_invoice_items_cn
        WHERE receiving_invoice_id = 'cn-inv-CN-SCAN-Z1' ORDER BY id`
  );
  assert.deepEqual(
    items.map((i) => [i.id, i.receivedQty, i.scanStatus, i.scanReason]),
    [
      [itemIds[0], 100, "ok", null], // scanned qty received
      [itemIds[1], 50, "warning", "qty_mismatch"], // min(60, 50)
      [itemIds[2], 25, "warning", "qty_mismatch"], // NULL line_qty → scan_qty
      [itemIds[3], 0, "error", "damaged"], // held back
      [itemIds[4], 0, "error", "missing"], // auto-flagged by the finalize
    ]
  );

  // The CN put-away detail offers the credited items (remaining = received −
  // picked − put_away → 0 for the held-back ones).
  const detail = await getCnPutAwayTaskDetail(client.db, body.putAwayTaskId!);
  assert.equal(detail.order.batchNo, "CN-SCAN-Z1");
  const byPart = new Map(detail.items.map((i) => [i.partNo, i.remainingQty]));
  assert.deepEqual(
    [...byPart.entries()].sort(),
    [
      ["PART-A", 100],
      ["PART-B", 50],
      ["PART-C", 25],
      ["PART-D", 0],
      ["PART-E", 0],
    ]
  );

  // After the finalize the task is closed: scan/flag/reset/detail 409/404.
  const scanAgain = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 100 });
  assert.equal(scanAgain.status, 409);
  assert.match(await scanAgain.text(), /order_not_scanning/);
  const flagAgain = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/flag`, { reason: "missing" });
  assert.equal(flagAgain.status, 409);
  const resetAgain = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/reset`);
  assert.equal(resetAgain.status, 409);
  const finalizeAgain = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/finalize`, {});
  assert.equal(finalizeAgain.status, 409);
  const detailGone = await call(token, "GET", `/receiving-cn/scan-tasks/${orderId}`);
  assert.equal(detailGone.status, 404);
});

test("finalize: a partially credited open line blocks the finalize as unresolved", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId } = await seedScanningOrder("CN-SCAN-Z2", [{ partNo: "PART-A", lineQty: 100 }]);
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/scan-aggregate`, { partNo: "PART-A", qty: 40 });
  const blocked = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/finalize`, {});
  assert.equal(blocked.status, 409);
  assert.match(await blocked.text(), /unresolved_items: 1/);
});

test("finalize: all-flagged order completes without a put-away task", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-Z3", [{ partNo: "PART-A", lineQty: 100 }]);
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/flag`, { reason: "missing" });

  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/finalize`, {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { putAwayTaskId: string | null };
  assert.equal(body.putAwayTaskId, null);
  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_orders_cn WHERE id = ${orderId}`);
  assert.equal(order!.status, "in_hand");
  const tasks = await queryAll<{ id: string }>(
    client.db,
    sql`SELECT id FROM put_away_tasks_cn WHERE receiving_order_cn_id = ${orderId}`
  );
  assert.equal(tasks.length, 0);
});

test("finalize on a pending order → 409 order_not_scanning; unknown order → 404", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  await client.db.execute(
    sql`INSERT INTO receiving_orders_cn (id, batch_no, status, org_id) VALUES ('cn-order-p2', 'CN-PEND-2', 'pending', 2)`
  );
  const res = await call(token, "POST", "/receiving-cn/scan-tasks/cn-order-p2/finalize", {});
  assert.equal(res.status, 409);
  assert.match(await res.text(), /order_not_scanning/);
  const missing = await call(token, "POST", "/receiving-cn/scan-tasks/nope/finalize", {});
  assert.equal(missing.status, 404);
});

test("flag/reset on a non-scanning order → 409 order_not_scanning", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-G1", [{ partNo: "PART-A", lineQty: 100 }]);
  await client.db.execute(sql`UPDATE receiving_orders_cn SET status = 'in_hand' WHERE id = ${orderId}`);
  const flag = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/flag`, { reason: "missing" });
  assert.equal(flag.status, 409);
  assert.match(await flag.text(), /order_not_scanning/);
});
