// CN receiving scan task routes (spec
// docs/superpowers/plans/2026-11-01-cn-receiving-scan.md): the pdf path's
// confirm/cron finalize moves a CN order to `scanning`; the PDA resolves each
// item (scan → ok/qty-mismatch warning, flag → error, reset) and finalize
// receives only the clean items into the CN put-away world. Seeds the
// scanning order directly (no DocPal workflow needed).

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
  lineQty: number;
  wclItemNo?: string;
  poNo?: string;
  dateCode?: string;
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
      sql`INSERT INTO receiving_invoice_items_cn (id, receiving_invoice_id, part_no, wcl_item_no, po_no, line_qty, received_qty, date_code, org_id, sub_inventory_code)
          VALUES (${itemId}, ${`cn-inv-${batchNo}`}, ${it.partNo}, ${it.wclItemNo ?? null}, ${it.poNo ?? "PO-1"}, ${it.lineQty}, 0, ${it.dateCode ?? null}, 2, 'STORE1')`
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
  const { itemIds } = await seedScanningOrder("CN-SCAN-L2", [{ partNo: "PART-C", lineQty: 10 }]);
  // Non-scanning orders are excluded.
  await client.db.execute(
    sql`INSERT INTO receiving_orders_cn (id, batch_no, status, org_id) VALUES ('cn-order-ih', 'CN-IH-1', 'in_hand', 2)`
  );
  // Resolve one item on L2 to check the resolved count.
  await call(token, "POST", `/receiving-cn/scan-tasks/cn-order-CN-SCAN-L2/items/${itemIds[0]}/scan`, { qty: 10 });

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

test("scan: qty == line_qty → ok with the scanned batch fields; mismatch → warning/qty_mismatch; validation 400s", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-S1", [
    { partNo: "PART-A", lineQty: 100, dateCode: "2641" },
    { partNo: "PART-B", lineQty: 50 },
  ]);

  const ok = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/scan`, {
    qty: 100,
    dateCode: "2645",
    lotCode: "L9",
    coo: "JP",
    raw: ":RAW-1:",
  });
  assert.equal(ok.status, 200);
  const okItem = (await ok.json()) as {
    scanStatus: string;
    scanQty: number;
    scanReason: string | null;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    scannedBy: string | null;
    scannedAt: string | null;
  };
  assert.equal(okItem.scanStatus, "ok");
  assert.equal(okItem.scanQty, 100);
  assert.equal(okItem.scanReason, null);
  assert.equal(okItem.dateCode, "2645"); // the physical truth overwrote the OCR value
  assert.equal(okItem.lotCode, "L9");
  assert.equal(okItem.coo, "JP");
  assert.ok(okItem.scannedBy);
  assert.ok(okItem.scannedAt);

  const warn = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[1]}/scan`, { qty: 45 });
  assert.equal(warn.status, 200);
  const warnItem = (await warn.json()) as { scanStatus: string; scanQty: number; scanReason: string | null };
  assert.equal(warnItem.scanStatus, "warning");
  assert.equal(warnItem.scanQty, 45);
  assert.equal(warnItem.scanReason, "qty_mismatch");

  // A re-scan overwrites the previous state (warning → ok).
  const rescan = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[1]}/scan`, { qty: 50 });
  assert.equal((await rescan.json() as { scanStatus: string }).scanStatus, "ok");

  for (const bad of [{ qty: 0 }, { qty: -1 }, { qty: 1.5 }, { qty: "abc" }, {}]) {
    const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/scan`, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(await res.text(), /invalid_payload/);
  }

  // Item of a different order → 404.
  const other = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/nope/scan`, { qty: 1 });
  assert.equal(other.status, 404);
  assert.match(await other.text(), /receiving_invoice_item_cn_not_found/);
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
  const mirror = await queryGet<{ reportedMismatch: number; mismatchReason: string; mismatchNote: string }>(
    client.db,
    sql`SELECT reported_mismatch AS "reportedMismatch", mismatch_reason AS "mismatchReason", mismatch_note AS "mismatchNote"
        FROM receiving_invoice_items_cn WHERE id = ${itemIds[0]}`
  );
  assert.equal(mirror!.reportedMismatch, 1);
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

test("reset: clears the scan state and the mirrored mismatch columns back to unresolved", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-R1", [{ partNo: "PART-A", lineQty: 100 }]);
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/flag`, { reason: "missing", note: "少了" });

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
  const mirror = await queryGet<{ reportedMismatch: number; mismatchReason: string | null; mismatchNote: string | null }>(
    client.db,
    sql`SELECT reported_mismatch AS "reportedMismatch", mismatch_reason AS "mismatchReason", mismatch_note AS "mismatchNote"
        FROM receiving_invoice_items_cn WHERE id = ${itemIds[0]}`
  );
  assert.equal(mirror!.reportedMismatch, 0);
  assert.equal(mirror!.mismatchReason, null);
  assert.equal(mirror!.mismatchNote, null);
});

test("finalize: unresolved items → 409 unresolved_items; unresolvedAs 'missing' receives only the clean items", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-Z1", [
    { partNo: "PART-A", lineQty: 100 }, // will scan ok
    { partNo: "PART-B", lineQty: 50 }, // will scan mismatch (warning)
    { partNo: "PART-C", lineQty: 25 }, // will flag damaged (error)
    { partNo: "PART-D", lineQty: 10 }, // left unresolved
  ]);
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/scan`, { qty: 100, dateCode: "2645" });
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[1]}/scan`, { qty: 40 });
  await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[2]}/flag`, { reason: "damaged" });

  // Unresolved item blocks the finalize, with the count in the message.
  const blocked = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/finalize`, {});
  assert.equal(blocked.status, 409);
  assert.match(await blocked.text(), /unresolved_items: 1/);

  const res = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/finalize`, { unresolvedAs: "missing" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: string; batchNo: string; putAwayTaskId: string | null };
  assert.equal(body.batchNo, "CN-SCAN-Z1");
  assert.ok(body.putAwayTaskId); // one ok item → task created

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
      [itemIds[1], 0, "warning", "qty_mismatch"], // held back
      [itemIds[2], 0, "error", "damaged"], // held back
      [itemIds[3], 0, "error", "missing"], // auto-flagged by the finalize
    ]
  );

  // The CN put-away detail only offers the clean item (remaining = received −
  // picked − put_away → 0 for the held-back ones).
  const detail = await getCnPutAwayTaskDetail(client.db, body.putAwayTaskId!);
  assert.equal(detail.order.batchNo, "CN-SCAN-Z1");
  const byPart = new Map(detail.items.map((i) => [i.partNo, i.remainingQty]));
  assert.deepEqual(
    [...byPart.entries()].sort(),
    [
      ["PART-A", 100],
      ["PART-B", 0],
      ["PART-C", 0],
      ["PART-D", 0],
    ]
  );

  // After the finalize the task is closed: scan/flag/reset/detail 409/404.
  const scanAgain = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/scan`, { qty: 100 });
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

test("finalize: all-flagged order completes without a put-away task", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-Z2", [{ partNo: "PART-A", lineQty: 100 }]);
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

test("scan/flag/reset on a non-scanning order → 409 order_not_scanning", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const { orderId, itemIds } = await seedScanningOrder("CN-SCAN-G1", [{ partNo: "PART-A", lineQty: 100 }]);
  await client.db.execute(sql`UPDATE receiving_orders_cn SET status = 'in_hand' WHERE id = ${orderId}`);
  const scan = await call(token, "POST", `/receiving-cn/scan-tasks/${orderId}/items/${itemIds[0]}/scan`, { qty: 100 });
  assert.equal(scan.status, 409);
  assert.match(await scan.text(), /order_not_scanning/);
});
