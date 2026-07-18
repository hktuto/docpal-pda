import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { decodeKoaQty, normalizePartNo, parseQrRaw } from "./scanParse.js";
import {
  cancelReceivingItemMismatch,
  confirmReceivingArrival,
  confirmReceivingItemMismatch,
  editReceivingItemMismatch,
  getReceivingItemMismatch,
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

async function orderIdOf(refNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE ref_no = ${refNo}`);
  return row!.id;
}

async function itemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        JOIN parts p ON p.id = rii.part_id
        WHERE ri.receiving_order_id = ${orderId} AND p.part_no = ${partNo}`
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
  assert.equal(normalizePartNo("  P413 "), "P413");
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

test("parseQrRaw: no template / no match / invalid regex → {}", () => {
  assert.deepEqual(parseQrRaw("whatever", null, null), {});
  assert.deepEqual(
    parseQrRaw("SOME-RANDOM-STRING", "^:(?<itemId>[^:]+)::(?<qty>[^:]+)", "koa_zeros"),
    {}
  );
  assert.deepEqual(parseQrRaw(":P413::11", "(?<itemId>[", null), {});
  // plain integer qty encoding (no koa_zeros)
  assert.equal(parseQrRaw(":P413::11", "^:(?<itemId>[^:]+)::(?<qty>[^:]+)$", null).qty, 11);
});

// --- scan --------------------------------------------------------------------

test("scan: happy path — partial receipt, provisional_received, ledger row", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("04958210"); // pending DAITO order
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 5000

  const item = await scanReceivingOrder(client.db, orderId, {
    actorId,
    partNo: "RK73B1JTTD181G",
    qty: 2000,
    dateCode: "2610",
    lotCode: "L-A",
  });
  assert.equal(item.id, itemId);
  assert.equal(item.receivedQty, 2000);

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
        FROM inventory_transactions WHERE receiving_invoice_item_id = ${itemId}`
  );
  assert.equal(txns.length, 1);
  assert.deepEqual(
    [txns[0].txnType, txns[0].qtyType, txns[0].qtyDelta, txns[0].dateCode, txns[0].lotCode, txns[0].coo],
    ["RECEIVE_TO_DOCK", "dock", 2000, "2610", "L-A", "JP"] // coo falls back to the item
  );
  assert.equal(txns[0].referenceType, "receiving_order");
  assert.equal(txns[0].referenceId, orderId);
  assert.equal(txns[0].actorId, actorId);

  // second scan: stays provisional_received, no extra transition log
  const again = await scanReceivingOrder(client.db, orderId, { actorId, partNo: "rk73b1jttd181g ", qty: 2000 });
  assert.equal(again.receivedQty, 4000);
  const logCount = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM transaction_logs WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}`
  );
  assert.equal(logCount!.c, 1);
});

test("scan: raw QR template parse applies receipt (KOA order)", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("04958166"); // cleared KOA order

  // status guard: clear orders cannot be scanned
  const err = await catchHttp(scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73H1JTTD1002F", qty: 1 }));
  assert.equal(err.status, 409);
  assert.equal(err.message, "cannot_scan_in_status_clear");

  // reopen the order for the scan-parse flow
  await client.db.execute(sql`UPDATE receiving_orders SET status = 'pending' WHERE id = ${orderId}`);
  await client.db.execute(
    sql`UPDATE receiving_invoice_items rii SET received_qty = 0
        FROM receiving_invoices ri
        WHERE rii.receiving_invoice_id = ri.id AND ri.receiving_order_id = ${orderId}`
  );

  // raw only: template parses part + koa_zeros qty (14 → 10000)
  const item = await scanReceivingOrder(client.db, orderId, {
    actorId,
    raw: ":RK73H1JTTD1002F:S1:14:X:L2601A:602:KOA+RK73H1JTTD1002F",
  });
  assert.equal(item.partNo, "RK73H1JTTD1002F");
  assert.equal(item.receivedQty, 10000);

  const txn = await queryGet<{ qtyDelta: number; lotCode: string | null; dateCode: string | null }>(
    client.db,
    sql`SELECT qty_delta AS "qtyDelta", lot_code AS "lotCode", date_code AS "dateCode"
        FROM inventory_transactions WHERE receiving_invoice_item_id = ${item.id}`
  );
  assert.deepEqual([txn!.qtyDelta, txn!.lotCode, txn!.dateCode], [10000, "L2601A", "2601"]);

  // explicit fields override parsed ones (part + qty from the body win; an
  // explicit serialNo also overrides the parsed one — the raw's 602 was
  // already scanned above and would be rejected as label_already_scanned)
  const other = await scanReceivingOrder(client.db, orderId, {
    actorId,
    raw: ":RK73H1JTTD1002F:S1:14:X:L2601A:602:KOA+RK73H1JTTD1002F",
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
  const orderId = await orderIdOf("04958210");

  const err = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 5001 })
  );
  assert.equal(err.status, 409);
  assert.equal(err.message, "scanned_qty_exceeds_remaining");
});

test("scan: no match → 409 JSON with all order items as candidates", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("04958210");

  const err = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId, partNo: "NOPE-123", qty: 10 })
  );
  assert.equal(err.status, 409);
  const body = await err.getResponse().json();
  assert.equal(body.message, "no_match");
  assert.equal(body.candidates.length, 2);
  assert.deepEqual(
    body.candidates.map((c: { partNo: string }) => c.partNo).sort(),
    ["P413", "RK73B1JTTD181G"]
  );
  assert.deepEqual(Object.keys(body.candidates[0]).sort(), ["id", "partId", "partNo", "qty", "receivedQty", "wclItemNo"].sort());
});

test("scan: multiple matches → 409 JSON with the matching candidates", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("04958210");
  // make the P413 item also match the scanned part number via its wcl_item_no
  const p413ItemId = await itemIdOf(orderId, "P413");
  await client.db.execute(
    sql`UPDATE receiving_invoice_items SET wcl_item_no = 'RK73B1JTTD181G' WHERE id = ${p413ItemId}`
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
  const orderId = await orderIdOf("04958210");

  const notFound = await catchHttp(
    scanReceivingOrder(client.db, "00000000-0000-4000-8000-000000000099", { actorId, partNo: "P413", qty: 1 })
  );
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "receiving_order_not_found");

  const badActor = await catchHttp(
    scanReceivingOrder(client.db, orderId, { actorId: "00000000-0000-4000-8000-000000000099", partNo: "P413", qty: 1 })
  );
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");

  const badQty = await catchHttp(scanReceivingOrder(client.db, orderId, { actorId, partNo: "P413", qty: 0 }));
  assert.equal(badQty.status, 400);
  assert.equal(badQty.message, "qty_must_be_positive_integer");
});

// --- S-key scan dedup (receiving_scan_labels) -----------------------------------

test("scan: serial dedup — repeat serial on the same order → 409 label_already_scanned", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("04958166"); // KOA order (has a serialNo template)

  // reopen the cleared order for scanning (same pattern as the parse test)
  await client.db.execute(sql`UPDATE receiving_orders SET status = 'pending' WHERE id = ${orderId}`);
  await client.db.execute(
    sql`UPDATE receiving_invoice_items rii SET received_qty = 0
        FROM receiving_invoices ri
        WHERE rii.receiving_invoice_id = ri.id AND ri.receiving_order_id = ${orderId}`
  );
  const itemId = await itemIdOf(orderId, "RK73H1JTTD1002F");

  // first scan of the label: applies, records the serial (602), echoes it back
  const raw = ":RK73H1JTTD1002F:S1:14:X:L2601A:602:KOA+RK73H1JTTD1002F";
  const item = await scanReceivingOrder(client.db, orderId, { actorId, raw });
  assert.equal(item.receivedQty, 10000);
  assert.equal(item.serialNo, "602");

  const label = await queryGet<{ receivingOrderId: string; receivingInvoiceItemId: string; serialNo: string; qty: number; scannedBy: string }>(
    client.db,
    sql`SELECT receiving_order_id AS "receivingOrderId", receiving_invoice_item_id AS "receivingInvoiceItemId",
               serial_no AS "serialNo", qty, scanned_by AS "scannedBy"
        FROM receiving_scan_labels WHERE receiving_order_id = ${orderId}`
  );
  assert.deepEqual(label, { receivingOrderId: orderId, receivingInvoiceItemId: itemId, serialNo: "602", qty: 10000, scannedBy: actorId });

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
  assert.equal(after!.receivedQty, 10000);
});

test("scan: same serial on a DIFFERENT order is allowed", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const koaOrderId = await orderIdOf("04958166");
  const daitoOrderId = await orderIdOf("04958210"); // DAITO: no QR template

  await client.db.execute(sql`UPDATE receiving_orders SET status = 'pending' WHERE id = ${koaOrderId}`);
  await client.db.execute(
    sql`UPDATE receiving_invoice_items rii SET received_qty = 0
        FROM receiving_invoices ri
        WHERE rii.receiving_invoice_id = ri.id AND ri.receiving_order_id = ${koaOrderId}`
  );

  // KOA order: serial from the raw template parse
  await scanReceivingOrder(client.db, koaOrderId, {
    actorId,
    raw: ":RK73H1JTTD1002F:S1:14:X:L2601A:602:KOA+RK73H1JTTD1002F",
  });

  // DAITO order: same serial value via the explicit body field — allowed
  // (uniqueness is per receiving order)
  const other = await scanReceivingOrder(client.db, daitoOrderId, {
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

  // ...but the repeat on the DAITO order is still rejected
  const dup = await catchHttp(
    scanReceivingOrder(client.db, daitoOrderId, { actorId, partNo: "RK73B1JTTD181G", qty: 100, serialNo: "602" })
  );
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "label_already_scanned");
});

test("scan: no serial → no dedup row, repeat scans still apply", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("04958210"); // DAITO order, no template

  const first = await scanReceivingOrder(client.db, orderId, { actorId, partNo: "P413", qty: 100 });
  assert.equal(first.serialNo, null);
  const second = await scanReceivingOrder(client.db, orderId, { actorId, partNo: "P413", qty: 100 });
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
  const orderId = await orderIdOf("04958210");
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  const otherItemId = await itemIdOf(orderId, "P413");

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
        ORDER BY created_at, id`
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

// --- confirm-arrival from provisional_received ---------------------------------

test("confirm-arrival: provisional_received completes the remaining receipt", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  const orderId = await orderIdOf("04958210");
  const scannedItemId = await itemIdOf(orderId, "RK73B1JTTD181G"); // qty 5000
  const otherItemId = await itemIdOf(orderId, "P413"); // qty 3000

  await scanReceivingOrder(client.db, orderId, { actorId, partNo: "RK73B1JTTD181G", qty: 2000 });

  const result = await confirmReceivingArrival(client.db, orderId, actorId);
  assert.equal(result.status, "in_hand");

  const items = await queryAll<{ id: string; receivedQty: number; qty: number }>(
    client.db,
    sql`SELECT rii.id, rii.received_qty AS "receivedQty", rii.qty
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${orderId} ORDER BY rii.id`
  );
  assert.deepEqual(
    items.map((i) => [i.id, i.receivedQty, i.qty]),
    [
      [scannedItemId, 5000, 5000],
      [otherItemId, 3000, 3000],
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
      [scannedItemId, 5000], // 2000 scanned + 3000 confirmed
      [otherItemId, 3000],
    ]
  );

  const logs = await queryAll<{ fromState: string; toState: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState"
        FROM transaction_logs WHERE entity_type = 'receiving_order' AND entity_id = ${orderId}
        ORDER BY created_at, id`
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
