import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { decodeKoaQty, normalizePartNo, parseQrRaw } from "./scanParse.js";
import {
  cancelReceivingItemMismatch,
  confirmReceivingArrival,
  confirmReceivingItemMismatch,
  deleteReceivingInvoiceItem,
  editReceivingItemMismatch,
  getReceivingItemMismatch,
  listReceivingMismatches,
  listReceivingOrderLogs,
  reportReceivingItemMismatch,
  scanReceivingOrder,
} from "./receiving.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

// --- business-key lookups (never hardcode seed UUIDs) ------------------------

async function actorIdOf(username: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

async function orderIdOf(batchNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = ${batchNo}`);
  return row!.id;
}

async function itemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId} AND rii.part_no = ${partNo}`
  );
  return row!.id;
}

async function catchHttp(p: Promise<unknown>): Promise<HTTPException> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof HTTPException, `expected HTTPException, got ${err}`);
    return err;
  }
  assert.fail("expected HTTPException");
}

// --- scanParse unit cases ----------------------------------------------------

test("decodeKoaQty: last digit is the trailing-zero count", () => {
  assert.equal(decodeKoaQty("253"), 25000);
  assert.equal(decodeKoaQty("14"), 10000);
  assert.equal(decodeKoaQty("11"), 10);
  assert.equal(decodeKoaQty("00"), undefined);
  assert.equal(decodeKoaQty("0"), undefined);
  assert.equal(decodeKoaQty("abc"), undefined);
});

test("normalizePartNo: uppercase + collapse whitespace", () => {
  assert.equal(normalizePartNo("rk73b1 jttd181g"), "RK73B1JTTD181G");
  assert.equal(normalizePartNo("  RK73H1JTTD4702F "), "RK73H1JTTD4702F");
});

test("parseQrRaw: seeded KOA template parses raw and decodes koa_zeros qty", async () => {
  const profile = await queryGet<{ qrTemplate: string; qtyEncoding: string }>(
    client.db,
    sql`SELECT qr_template AS "qrTemplate", qty_encoding AS "qtyEncoding" FROM supplier_profiles WHERE supplier_code = 'KOA'`
  );
  assert.ok(profile?.qrTemplate);
  // template: ^:(?<itemId>[^:]+):(?<subId>[^:]*):(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<serialNo>[^:]+):(?<fullName>.+)$
  const parsed = parseQrRaw(":RK73H1JTTD1002F:S1:14:X:L2601A:602:KOA+RK73H1JTTD1002F", profile.qrTemplate, profile.qtyEncoding);
  assert.equal(parsed.partNo, "RK73H1JTTD1002F");
  assert.equal(parsed.qty, 10000); // "14" → 1 × 10^4
  assert.equal(parsed.lotCode, "L2601A");
  assert.equal(parsed.serialNo, "602"); // S-key serial from the serialNo group
  assert.equal(parsed.dateCode, undefined);

  // Outer package label: empty subId segment must also match (subId [^:]*).
  const outer = parseQrRaw(":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F", profile.qrTemplate, profile.qtyEncoding);
  assert.equal(outer.partNo, "RK73H2ATTD2403F");
  assert.equal(outer.qty, 25000); // "253" → 25 × 10^3
  assert.equal(outer.lotCode, "63048349");
  assert.equal(outer.serialNo, "S613");
});

test("parseQrRaw: apps-web KOA template variant (empty subId segment)", () => {
  // Verbatim from apps/web/tests/parseOcrScan.test.ts — no serialNo group:
  // older templates are tolerated and simply yield no serial.
  const template = "^:(?<itemId>[^:]+)::(?<qty>[^:]+):(?<ignore1>[^:]+):(?<lotCode>[^:]+):(?<ignore2>[^:]+):(?<fullName>.+)$";
  const parsed = parseQrRaw(":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F", template, "koa_zeros");
  assert.equal(parsed.partNo, "RK73H2ATTD2403F");
  assert.equal(parsed.qty, 25000); // "253" → 25 × 10^3
  assert.equal(parsed.lotCode, "63048349");
  assert.equal(parsed.serialNo, undefined);
});

test("parseQrRaw: admin editor config builds a matching-equivalent KOA regex", async () => {
  // Mirror of buildRegex (delimited mode) in apps/admin/utils/qrTemplate.ts —
  // guards generator/parser drift: editor-generated regexes must parse here.
  function buildDelimited(delimiter: string, roles: string[]): string {
    const d = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return "^" + roles.map((r) => (r === "ignore" ? `[^${d}]*` : `(?<${r}>[^${d}]*)`)).join(d) + "$";
  }
  const profile = await queryGet<{
    qrTemplateConfig: { delimiter: string; fields: { role: string }[] };
  }>(
    client.db,
    sql`SELECT qr_template_config AS "qrTemplateConfig" FROM supplier_profiles WHERE supplier_code = 'KOA'`
  );
  assert.ok(profile?.qrTemplateConfig, "seeded KOA profile carries a qr_template_config");
  const regex = buildDelimited(
    profile.qrTemplateConfig.delimiter,
    profile.qrTemplateConfig.fields.map((f) => f.role)
  );
  const inner = parseQrRaw(":RK73H1JTTD1002F:S1:14:X:L2601A:602:KOA+RK73H1JTTD1002F", regex, "koa_zeros");
  assert.equal(inner.partNo, "RK73H1JTTD1002F");
  assert.equal(inner.qty, 10000);
  assert.equal(inner.lotCode, "L2601A");
  assert.equal(inner.serialNo, "602");
  // outer label with an empty subId piece must match too
  const outer = parseQrRaw(":RK73H2ATTD2403F::253:M:63048349:S613:KOA*RK73H2ATTD 2403F", regex, "koa_zeros");
  assert.equal(outer.partNo, "RK73H2ATTD2403F");
  assert.equal(outer.qty, 25000);
  assert.equal(outer.lotCode, "63048349");
});

test("parseQrRaw: no template / no match / invalid regex → {}", () => {
  assert.deepEqual(parseQrRaw("whatever", null, null), {});
  assert.deepEqual(
    parseQrRaw("SOME-RANDOM-STRING", "^:(?<itemId>[^:]+)::(?<qty>[^:]+)", "koa_zeros"),
    {}
  );
  assert.deepEqual(parseQrRaw(":RK73H1JTTD4702F::11", "(?<itemId>[", null), {});
  // plain integer qty encoding (no koa_zeros)
  assert.equal(parseQrRaw(":RK73H1JTTD4702F::11", "^:(?<itemId>[^:]+)::(?<qty>[^:]+)$", null).qty, 11);
});

// --- scan --------------------------------------------------------------------

test("scan: happy path — partial receipt, provisional_received, ledger row", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002"); // pending KOA order
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 600

  const item = await scanReceivingOrder(client.db, orderId, {
    actorId,
    partNo: "RK73B1JTTD181G",
    qty: 200,
    dateCode: "2610",
    lotCode: "L-A",
  });
  assert.equal(item.id, itemId);
  assert.equal(item.receivedQty, 200);

  const order = await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM receiving_orders WHERE id = ${orderId}`
  );
  assert.equal(order!.status, "provisional_received");

  const logs = await queryAll<{ fromState: string; toState: string; actorId: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}`
  );
  assert.deepEqual(
    logs.map((l) => [l.fromState, l.toState, l.actorId]),
    [["pending", "provisional_received", actorId]]
  );

  // (SO-DEMO-0002 has open demand for this part, so allocation RESERVE
  // rows also reference the item — filter to the receipt rows.
  // SO-DEMO-0001's 181G×300 demand is fully covered by the A-01-02 shelf
  // lot, so dock receipts here only ever allocate to SO-DEMO-0002.)
  const txns = await queryAll<{
    txnType: string;
    qtyType: string;
    qtyDelta: number;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    referenceType: string;
    referenceId: string;
    receivingInvoiceItemId: string;
    actorId: string;
  }>(
    client.db,
    sql`SELECT txn_type AS "txnType", qty_type AS "qtyType", qty_delta AS "qtyDelta",
               date_code AS "dateCode", lot_code AS "lotCode", coo,
               reference_type AS "referenceType", reference_id AS "referenceId",
               receiving_invoice_item_id AS "receivingInvoiceItemId", actor_id AS "actorId"
        FROM inventory_transactions
        WHERE receiving_invoice_item_id = ${itemId} AND txn_type = 'RECEIVE_TO_DOCK'`
  );
  assert.equal(txns.length, 1);
  assert.deepEqual(
    [txns[0].txnType, txns[0].qtyType, txns[0].qtyDelta, txns[0].dateCode, txns[0].lotCode, txns[0].coo],
    ["RECEIVE_TO_DOCK", "dock", 200, "2610", "L-A", "JP"] // coo falls back to the item
  );
  assert.equal(txns[0].referenceType, "receiving_order");
  assert.equal(txns[0].referenceId, orderId);
  assert.equal(txns[0].actorId, actorId);

  // second scan: stays provisional_received, no extra transition log
  const again = await scanReceivingOrder(client.db, orderId, { actorId, partNo: "rk73b1jttd181g ", qty: 200 });
  assert.equal(again.receivedQty, 400);
  const logCount = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM transaction_logs WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}`
  );
  assert.equal(logCount!.c, 1);
});

test("scan: raw QR template parse applies receipt (KOA order)", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100001"); // KOA order

  // status guard: clear orders cannot be scanned
  await client.db.execute(sql`UPDATE receiving_orders SET status = 'clear' WHERE id = ${orderId}`);
  const err = await catchHttp(scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73H1JTTD1002F", qty: 1 }));
  assert.equal(err.status, 409);
  assert.equal(err.message, "cannot_scan_in_status_clear");

  // reopen the order for the scan-parse flow (received_qty is already 0)
  await client.db.execute(sql`UPDATE receiving_orders SET status = 'pending' WHERE id = ${orderId}`);

  // raw only: template parses part + koa_zeros qty (152 → 1500)
  const item = await scanReceivingOrder(client.db, orderId, {
    actorId,
    raw: ":RK73H1JTTD1002F:S1:152:X:L2601A:602:KOA+RK73H1JTTD1002F",
  });
  assert.equal(item.partNo, "RK73H1JTTD1002F");
  assert.equal(item.receivedQty, 1500);

  const txn = await queryGet<{ qtyDelta: number; lotCode: string | null; dateCode: string | null }>(
    client.db,
    sql`SELECT qty_delta AS "qtyDelta", lot_code AS "lotCode", date_code AS "dateCode"
        FROM inventory_transactions
        WHERE receiving_invoice_item_id = ${item.id} AND txn_type = 'RECEIVE_TO_DOCK'`
  );
  // dateCode falls back to the seeded item's date_code (the KOA template has no dateCode group)
  assert.deepEqual([txn!.qtyDelta, txn!.lotCode, txn!.dateCode], [1500, "L2601A", "2605"]);

  // explicit fields override parsed ones (part + qty from the body win; an
  // explicit serialNo also overrides the parsed one — the raw's 602 was
  // already scanned above and would be rejected as label_already_scanned)
  const other = await scanReceivingOrder(client.db, orderId, {
    actorId,
    raw: ":RK73H1JTTD1002F:S1:152:X:L2601A:602:KOA+RK73H1JTTD1002F",
    partNo: "RK73H1JTTD2202F",
    qty: 100,
    serialNo: "602-B",
  });
  assert.equal(other.partNo, "RK73H1JTTD2202F");
  assert.equal(other.receivedQty, 100);
  assert.equal(other.serialNo, "602-B");
});

test("scan: 409 when qty exceeds the remaining qty", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");

  const err = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 601 })
  );
  assert.equal(err.status, 409);
  assert.equal(err.message, "scanned_qty_exceeds_remaining");
});

test("scan: no match → 409 JSON with all order items as candidates", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");

  const err = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId, partNo: "NOPE-123", qty: 10 })
  );
  assert.equal(err.status, 409);
  const body = await err.getResponse().json();
  assert.equal(body.message, "no_match");
  assert.equal(body.candidates.length, 5);
  assert.deepEqual(
    body.candidates.map((c: { partNo: string }) => c.partNo).sort(),
    ["RK73B1JTTD181G", "RK73H1JTTD1002F", "RK73H1JTTD2202F", "RK73H1JTTD4702F", "RK73H2ATTD1372F"]
  );
  assert.deepEqual(Object.keys(body.candidates[0]).sort(), ["id", "lineQty", "partNo", "receivedQty", "wclItemNo"].sort());
});

test("scan: multiple matches → 409 JSON with the matching candidates", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");
  // make the RK73H1JTTD4702F item also match the scanned part number via its wcl_item_no
  const rk4702ItemId = await itemIdOf(orderId, "RK73H1JTTD4702F");
  await client.db.execute(
    sql`UPDATE receiving_invoice_items SET wcl_item_no = 'RK73B1JTTD181G' WHERE id = ${rk4702ItemId}`
  );

  const err = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 10 })
  );
  assert.equal(err.status, 409);
  const body = await err.getResponse().json();
  assert.equal(body.message, "multiple_matches");
  assert.equal(body.candidates.length, 2);
});

test("scan: validations — actorId, actor_not_found, order 404, qty", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");

  const notFound = await catchHttp(
    scanReceivingOrder(client.db, "00000000-0000-4000-8000-000000000099", { actorId, partNo: "RK73H1JTTD4702F", qty: 1 })
  );
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "receiving_order_not_found");

  const badActor = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId: "00000000-0000-4000-8000-000000000099", partNo: "RK73H1JTTD4702F", qty: 1 })
  );
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");

  const badQty = await catchHttp(scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73H1JTTD4702F", qty: 0 }));
  assert.equal(badQty.status, 400);
  assert.equal(badQty.message, "qty_must_be_positive_integer");
});

// --- S-key scan dedup (receiving_scan_labels) -----------------------------------

test("scan: serial dedup — repeat serial on the same order → 409 label_already_scanned", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100001"); // KOA order (has a serialNo template)
  const itemId = await itemIdOf(orderId, "RK73H1JTTD1002F");

  // first scan of the label: applies, records the serial (602), echoes it back
  const raw = ":RK73H1JTTD1002F:S1:152:X:L2601A:602:KOA+RK73H1JTTD1002F";
  const item = await scanReceivingOrder(client.db, orderId, { actorId, raw });
  assert.equal(item.receivedQty, 1500);
  assert.equal(item.serialNo, "602");

  const label = await queryGet<{ receivingOrderId: string; receivingInvoiceItemId: string; serialNo: string; qty: number; scannedBy: string }>(
    client.db,
    sql`SELECT receiving_order_id AS "receivingOrderId", receiving_invoice_item_id AS "receivingInvoiceItemId",
               serial_no AS "serialNo", qty, scanned_by AS "scannedBy"
        FROM receiving_scan_labels WHERE receiving_order_id = ${orderId}`
  );
  assert.deepEqual(label, { receivingOrderId: orderId, receivingInvoiceItemId: itemId, serialNo: "602", qty: 1500, scannedBy: actorId });

  // repeat scan of the same label: rejected even though it would also exceed
  // the remaining qty — the dedup error wins (pre-check before the qty guard)
  const dup = await catchHttp(scanReceivingOrder(client.db, orderId, { actorId, raw }));
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "label_already_scanned");

  // no extra receipt was applied
  const after = await queryGet<{ receivedQty: number }>(
    client.db,
    sql`SELECT received_qty AS "receivedQty" FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(after!.receivedQty, 1500);
});

test("scan: same serial on a DIFFERENT order is allowed", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const koaOrderId = await orderIdOf("100001");
  const secondOrderId = await orderIdOf("100002"); // also KOA — serial dedup is per order

  // KOA order: serial from the raw template parse
  await scanReceivingOrder(client.db, koaOrderId, {
    actorId,
    raw: ":RK73H1JTTD1002F:S1:152:X:L2601A:602:KOA+RK73H1JTTD1002F",
  });

  // second order: same serial value via the explicit body field — allowed
  // (uniqueness is per receiving order)
  const other = await scanReceivingOrder(client.db, secondOrderId, {
    actorId,
    partNo: "RK73B1JTTD181G",
    qty: 100,
    serialNo: "602",
  });
  assert.equal(other.receivedQty, 100);
  assert.equal(other.serialNo, "602");

  const count = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM receiving_scan_labels WHERE serial_no = '602'`
  );
  assert.equal(count!.c, 2);

  // ...but the repeat on the second order is still rejected
  const dup = await catchHttp(
    scanReceivingOrder(client.db, secondOrderId, { actorId, partNo: "RK73B1JTTD181G", qty: 100, serialNo: "602" })
  );
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "label_already_scanned");
});

test("scan: no serial → no dedup row, repeat scans still apply", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002"); // explicit fields, no raw template parse

  const first = await scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73H1JTTD4702F", qty: 100 });
  assert.equal(first.serialNo, null);
  const second = await scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73H1JTTD4702F", qty: 100 });
  assert.equal(second.receivedQty, 200);
  assert.equal(second.serialNo, null);

  const count = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM receiving_scan_labels WHERE receiving_order_id = ${orderId}`
  );
  assert.equal(count!.c, 0);
});

// --- mismatch lifecycle --------------------------------------------------------

test("mismatch: report → edit → confirm → cancel (+ logs, no qty effect)", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const otherItemId = await itemIdOf(orderId, "RK73H1JTTD4702F");

  assert.equal(await getReceivingItemMismatch(client.db, itemId), null);

  const reported = await reportReceivingItemMismatch(client.db, itemId, {
    actorId,
    reason: "qty_mismatch",
    mismatchQty: 100,
    note: " short ",
  });
  assert.deepEqual(reported, { reason: "qty_mismatch", mismatchQty: 100, wrongPartNo: null, note: "short" });

  const dup = await catchHttp(
    reportReceivingItemMismatch(client.db, itemId, { actorId, reason: "damaged", mismatchQty: 1 })
  );
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "mismatch_already_reported");

  assert.deepEqual(await getReceivingItemMismatch(client.db, itemId), {
    reason: "qty_mismatch",
    mismatchQty: 100,
    wrongPartNo: null,
    note: "short",
  });

  // edit: absent fields unchanged, present fields replaced
  const edited = await editReceivingItemMismatch(client.db, itemId, { actorId, mismatchQty: 200, wrongPartNo: "X-1" });
  assert.deepEqual(edited, { reason: "qty_mismatch", mismatchQty: 200, wrongPartNo: "X-1", note: "short" });

  // confirm: stays flagged, writes the transition log
  const confirmed = await confirmReceivingItemMismatch(client.db, itemId, actorId);
  assert.deepEqual(confirmed, edited);
  assert.notEqual(await getReceivingItemMismatch(client.db, itemId), null);

  // cancel: clears flag + fields
  assert.equal(await cancelReceivingItemMismatch(client.db, itemId, actorId), null);
  assert.equal(await getReceivingItemMismatch(client.db, itemId), null);
  const stored = await queryGet<{ reportedMismatch: boolean; mismatchReason: string | null; mismatchQty: number | null }>(
    client.db,
    sql`SELECT reported_mismatch AS "reportedMismatch", mismatch_reason AS "mismatchReason", mismatch_qty AS "mismatchQty"
        FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.deepEqual(stored, { reportedMismatch: false, mismatchReason: null, mismatchQty: null });

  // logs: reported → updated → confirmed → cancelled on the item
  const states = await queryAll<{ fromState: string | null; toState: string; actorId: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'receiving_invoice_item' AND entity_id = ${itemId}
        ORDER BY created_date, id`
  );
  assert.deepEqual(
    states.map((l) => [l.fromState, l.toState, l.actorId]),
    [
      [null, "mismatch_reported", actorId],
      ["mismatch_reported", "mismatch_updated", actorId],
      ["mismatch_reported", "mismatch_confirmed", actorId],
      ["mismatch_reported", "mismatch_cancelled", actorId],
    ]
  );

  // error paths
  const editNone = await catchHttp(editReceivingItemMismatch(client.db, otherItemId, { actorId, mismatchQty: 5 }));
  assert.equal(editNone.status, 404);
  assert.equal(editNone.message, "mismatch_not_found");

  const confirmNone = await catchHttp(confirmReceivingItemMismatch(client.db, otherItemId, actorId));
  assert.equal(confirmNone.status, 404);
  assert.equal(confirmNone.message, "mismatch_not_found");

  const cancelNone = await catchHttp(cancelReceivingItemMismatch(client.db, otherItemId, actorId));
  assert.equal(cancelNone.status, 404);
  assert.equal(cancelNone.message, "mismatch_not_found");

  const missing = await catchHttp(getReceivingItemMismatch(client.db, "00000000-0000-4000-8000-000000000099"));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "receiving_invoice_item_not_found");

  // mismatch reporting never touches received_qty (pending order stays at 0)
  const qtyRow = await queryGet<{ receivedQty: number }>(
    client.db,
    sql`SELECT received_qty AS "receivedQty" FROM receiving_invoice_items WHERE id = ${itemId}`
  );
  assert.equal(qtyRow!.receivedQty, 0);
});

test("mismatch list: items across two orders returned with order/invoice joins", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const secondOrderId = await orderIdOf("100002");
  const koaOrderId = await orderIdOf("100001");
  const secondItemId = await itemIdOf(secondOrderId, "RK73B1JTTD181G");
  const koaItemId = await itemIdOf(koaOrderId, "RK73H1JTTD1002F");
  const invoiceIdOf = async (invoiceNo: string) =>
    (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_invoices WHERE invoice_no = ${invoiceNo}`))!.id;

  assert.deepEqual(await listReceivingMismatches(client.db), []);

  await reportReceivingItemMismatch(client.db, secondItemId, {
    actorId,
    reason: "qty_mismatch",
    mismatchQty: 100,
    note: "short",
  });
  await reportReceivingItemMismatch(client.db, koaItemId, {
    actorId,
    reason: "wrong_part",
    wrongPartNo: "RK73H1JTTD9999F",
  });

  const rows = await listReceivingMismatches(client.db);
  assert.equal(rows.length, 2);
  const byItem = new Map(rows.map((r) => [r.itemId, r]));
  assert.deepEqual(byItem.get(secondItemId), {
    itemId: secondItemId,
    receivingOrderId: secondOrderId,
    batchNo: "100002",
    invoiceId: await invoiceIdOf("INV-100002-01"),
    invoiceNo: "INV-100002-01",
    partNo: "RK73B1JTTD181G",
    supplierCode: "KOA",
    reason: "qty_mismatch",
    mismatchQty: 100,
    wrongPartNo: null,
    note: "short",
  });
  assert.deepEqual(byItem.get(koaItemId), {
    itemId: koaItemId,
    receivingOrderId: koaOrderId,
    batchNo: "100001",
    invoiceId: await invoiceIdOf("INV-100001-01"),
    invoiceNo: "INV-100001-01",
    partNo: "RK73H1JTTD1002F",
    supplierCode: "KOA",
    reason: "wrong_part",
    mismatchQty: null,
    wrongPartNo: "RK73H1JTTD9999F",
    note: null,
  });

  // cancelling drops the item from the open list
  await cancelReceivingItemMismatch(client.db, secondItemId, actorId);
  const after = await listReceivingMismatches(client.db);
  assert.deepEqual(after.map((r) => r.itemId), [koaItemId]);
});

// --- confirm-arrival from provisional_received ---------------------------------

test("confirm-arrival: provisional_received completes the remaining receipt", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");
  // seed insert order (also the id order): RK73H1JTTD4702F, RK73B1JTTD181G, RK73H2ATTD1372F, RK73H1JTTD1002F, RK73H1JTTD2202F
  const rk4702ItemId = await itemIdOf(orderId, "RK73H1JTTD4702F"); // qty 1200
  const scannedItemId = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 600
  const h2aItemId = await itemIdOf(orderId, "RK73H2ATTD1372F"); // qty 900
  const h1002ItemId = await itemIdOf(orderId, "RK73H1JTTD1002F"); // qty 400
  const h2202ItemId = await itemIdOf(orderId, "RK73H1JTTD2202F"); // qty 300

  await scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 200 });

  const result = await confirmReceivingArrival(client.db, orderId, actorId);
  assert.equal(result.status, "in_hand");

  const items = await queryAll<{ id: string; receivedQty: number; lineQty: number }>(
    client.db,
    sql`SELECT rii.id, rii.received_qty AS "receivedQty", rii.line_qty AS "lineQty"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId} ORDER BY rii.id`
  );
  assert.deepEqual(
    items.map((i) => [i.id, i.receivedQty, i.lineQty]),
    [
      [rk4702ItemId, 1200, 1200],
      [scannedItemId, 600, 600],
      [h2aItemId, 900, 900],
      [h1002ItemId, 400, 400],
      [h2202ItemId, 300, 300],
    ]
  );

  // ledger: confirm-arrival tops up only the remaining deltas per item
  const deltas = await queryAll<{ itemId: string; delta: number }>(
    client.db,
    sql`SELECT receiving_invoice_item_id AS "itemId", SUM(qty_delta)::int AS delta
        FROM inventory_transactions WHERE txn_type = 'RECEIVE_TO_DOCK' AND reference_id = ${orderId}
        GROUP BY receiving_invoice_item_id ORDER BY receiving_invoice_item_id`
  );
  assert.deepEqual(
    deltas.map((d) => [d.itemId, d.delta]),
    [
      [rk4702ItemId, 1200],
      [scannedItemId, 600], // 200 scanned + 400 confirmed
      [h2aItemId, 900],
      [h1002ItemId, 400],
      [h2202ItemId, 300],
    ]
  );

  const logs = await queryAll<{ fromState: string; toState: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState"
        FROM transaction_logs WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}
        ORDER BY created_date, id`
  );
  assert.deepEqual(
    logs.map((l) => [l.fromState, l.toState]),
    [
      ["pending", "provisional_received"],
      ["provisional_received", "in_hand"],
    ]
  );

  const again = await catchHttp(confirmReceivingArrival(client.db, orderId, actorId));
  assert.equal(again.status, 409);
  assert.equal(again.message, "cannot_confirm_arrival_from_in_hand");
});

// --- admin audit logs + item removal (2026-07-27 design) ---------------------

test("receiving order logs: order + item rows with actor name, newest first; 404 unknown order", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("100002");
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");

  assert.deepEqual(await listReceivingOrderLogs(client.db, orderId), []);

  await reportReceivingItemMismatch(client.db, itemId, { actorId, reason: "damaged", note: "wet carton" });
  await confirmReceivingArrival(client.db, orderId, actorId);
  // rows logged against another order must not leak in
  const otherItemId = await itemIdOf(await orderIdOf("100001"), "RK73H1JTTD1002F");
  await reportReceivingItemMismatch(client.db, otherItemId, { actorId, reason: "not_found" });

  // both logs can share a millisecond — make the order deterministic
  await client.db.execute(
    sql`UPDATE transaction_logs SET created_date = created_date - interval '1 minute' WHERE to_state = 'mismatch_reported'`
  );

  const logs = await listReceivingOrderLogs(client.db, orderId);
  assert.equal(logs.length, 2);

  const [orderLog, itemLog] = logs;
  assert.equal(orderLog!.entityType, "receiving_order");
  assert.equal(orderLog!.entityId, orderId);
  assert.equal(orderLog!.fromState, "pending");
  assert.equal(orderLog!.toState, "in_hand");
  assert.equal(orderLog!.actorId, actorId);
  assert.equal(orderLog!.actorName, "Demo Operator");
  assert.ok(orderLog!.createdDate > itemLog!.createdDate);

  assert.equal(itemLog!.entityType, "receiving_invoice_item");
  assert.equal(itemLog!.entityId, itemId);
  assert.equal(itemLog!.fromState, null);
  assert.equal(itemLog!.toState, "mismatch_reported");
  assert.equal(itemLog!.actorId, actorId);
  assert.equal(itemLog!.actorName, "Demo Operator");
  assert.equal(itemLog!.metadata.reason, "damaged");
  assert.equal(itemLog!.metadata.note, "wet carton");

  const missing = await catchHttp(listReceivingOrderLogs(client.db, randomUUID()));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "receiving_order_not_found");
});

test("delete receiving item: row gone, order log row + event written", async () => {
  await reseed(client);
  const actorId = await actorIdOf("admin");
  const orderId = await orderIdOf("100002");
  const itemId = await itemIdOf(orderId, "RK73H1JTTD4702F");

  await reportReceivingItemMismatch(client.db, itemId, { actorId, reason: "over_shipment" });
  const before = await queryGet<{ invoiceId: string }>(
    client.db,
    sql`SELECT receiving_invoice_id AS "invoiceId" FROM receiving_invoice_items WHERE id = ${itemId}`
  );

  const result = await deleteReceivingInvoiceItem(client.db, { itemId, actorId });
  assert.deepEqual(result, { id: itemId, receivingOrderId: orderId });

  // row gone
  assert.equal(
    await queryGet(client.db, sql`SELECT id FROM receiving_invoice_items WHERE id = ${itemId}`),
    undefined
  );

  // audit trail survives on the order
  const log = await queryGet<{
    fromState: string | null;
    toState: string;
    actorId: string;
    metadata: Record<string, unknown>;
  }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId", metadata
        FROM transaction_logs
        WHERE entity_type = 'receiving_order' AND entity_id = ${orderId} AND to_state = 'item_removed'`
  );
  assert.equal(log!.fromState, null);
  assert.equal(log!.actorId, actorId);
  assert.deepEqual(log!.metadata, {
    itemId,
    invoiceId: before!.invoiceId,
    partNo: "RK73H1JTTD4702F",
    poNo: "PO-DAI-201",
    poLine: "1",
    hadMismatch: true,
  });

  // SSE event for open pages
  const evt = await queryGet<{ topics: string[]; data: Record<string, unknown> }>(
    client.db,
    sql`SELECT topics, data FROM app_events WHERE type = 'receiving_order.item_removed'`
  );
  assert.deepEqual(evt!.topics, ["/receiving-orders"]);
  assert.equal(evt!.data.orderId, orderId);
  assert.equal(evt!.data.itemId, itemId);

  // the removed item no longer appears in the order's audit-log item ids
  const logs = await listReceivingOrderLogs(client.db, orderId);
  assert.deepEqual(logs.map((l) => l.toState), ["item_removed"]);
});

test("delete receiving item: 409 item_work_started for each guard; 404 unknown", async () => {
  await reseed(client);
  const actorId = await actorIdOf("admin");
  const orderId = await orderIdOf("100002");
  const scannedItemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const itemId = await itemIdOf(orderId, "RK73H1JTTD4702F");

  const missing = await catchHttp(deleteReceivingInvoiceItem(client.db, { itemId: randomUUID(), actorId }));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "receiving_invoice_item_not_found");

  const expectBlocked = async () => {
    const err = await catchHttp(deleteReceivingInvoiceItem(client.db, { itemId, actorId }));
    assert.equal(err.status, 409);
    assert.equal(err.message, "item_work_started");
  };

  // received_qty > 0 (a real scan on the other line)
  await scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 10 });
  const scanBlocked = await catchHttp(deleteReceivingInvoiceItem(client.db, { itemId: scannedItemId, actorId }));
  assert.equal(scanBlocked.status, 409);
  assert.equal(scanBlocked.message, "item_work_started");

  // picked_qty > 0
  await client.db.execute(sql`UPDATE receiving_invoice_items SET picked_qty = 1 WHERE id = ${itemId}`);
  await expectBlocked();
  await client.db.execute(sql`UPDATE receiving_invoice_items SET picked_qty = 0 WHERE id = ${itemId}`);

  // put_away_qty > 0
  await client.db.execute(sql`UPDATE receiving_invoice_items SET put_away_qty = 1 WHERE id = ${itemId}`);
  await expectBlocked();
  await client.db.execute(sql`UPDATE receiving_invoice_items SET put_away_qty = 0 WHERE id = ${itemId}`);

  // allocations reference the item
  const pickingItem = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT pi.id FROM picking_items pi JOIN picking_orders po ON po.id = pi.picking_order_id
        WHERE po.order_no = 'SO-DEMO-0001' LIMIT 1`
  );
  const allocId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO allocations (id, picking_item_id, receiving_invoice_item_id, qty, created_date, last_update_date)
        VALUES (${allocId}, ${pickingItem!.id}, ${itemId}, 1, now(), now())`
  );
  await expectBlocked();
  await client.db.execute(sql`DELETE FROM allocations WHERE id = ${allocId}`);

  // shelf_box_items reference the item (use a throwaway box, not a seeded one)
  await client.db.execute(
    sql`INSERT INTO shelf_boxes (id, status, created_date) VALUES ('BOX-H-TEST-0001', 'open', now())`
  );
  const sbiId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO shelf_box_items (id, shelf_box_id, receiving_invoice_item_id, part_no, qty)
        VALUES (${sbiId}, 'BOX-H-TEST-0001', ${itemId}, 'RK73H1JTTD4702F', 1)`
  );
  await expectBlocked();
  await client.db.execute(sql`DELETE FROM shelf_box_items WHERE id = ${sbiId}`);

  // all guards clear → delete succeeds
  const result = await deleteReceivingInvoiceItem(client.db, { itemId, actorId });
  assert.deepEqual(result, { id: itemId, receivingOrderId: orderId });
});
