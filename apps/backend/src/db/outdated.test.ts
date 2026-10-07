import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { allocateAll } from "./allocate.js";
import { confirmReceivingArrival } from "./receiving.js";
import { insertReceivingOrder } from "./test-fixtures.js";
import { dateCodeRank, dateToDateCode, outdatedThresholdRankMonths } from "./dateCode.js";
import {
  checkOutdatedDateCode,
  listOutdatedWarnings,
  recordOutdatedWarning,
  resolveOrderOutdatedWarnings,
  unresolvedOutdatedWarningCount,
} from "./outdated.js";
import {
  addAllUnboxedToShippingBox,
  addPackageToBox,
  createShippingBox,
  finishPickingOrder,
  getPickingOrderDetail,
  listPickingOrders,
  retryAutoFinishPickingOrder,
  scanIntoShippingBox,
  scanPickingItem,
} from "./picking.js";
import {
  commitPendingScansToShelf,
  getPutAwayAggregate,
  listPutAwayCandidates,
  recordPutAwayScan,
  retryReceivingOrderClear,
} from "./putaway.js";

// Supplier outdated date-code scan warnings (spec
// docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md).
// The reseeded demo world leaves supplier_profiles.outdated_limit_months NULL
// (no check) — tests that need a limit set it explicitly. "0101" (week 1 of
// 2001) is outdated under any plausible limit.

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

const REF = new Date(Date.UTC(2026, 9, 7)); // 2026-10-07 UTC
const OLD_CODE = "0101";

async function actorIdOf(username = "operator"): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

async function pickingOrderIdOf(orderNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM picking_orders WHERE order_no = ${orderNo}`);
  return row!.id;
}

async function pickingItemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_items WHERE picking_order_id = ${orderId} AND part_no = ${partNo}`
  );
  return row!.id;
}

async function allocationIdOf(pickingItemId: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  return row!.id;
}

async function receivingOrderIdOf(batchNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = ${batchNo}`);
  return row!.id;
}

async function receivingItemIdOf(receivingOrderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${receivingOrderId} AND rii.part_no = ${partNo}`
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

async function setSupplierLimit(supplierCode: string, months: number | null): Promise<void> {
  await client.db.execute(sql`UPDATE supplier_profiles SET outdated_limit_months = ${months} WHERE supplier_code = ${supplierCode}`);
}

async function eventsOfType(type: string): Promise<{ id: number; topics: string[]; data: Record<string, unknown> }[]> {
  const rows = await client.db.execute(sql`SELECT id, topics, data FROM app_events WHERE type = ${type} ORDER BY id`);
  return rows as unknown as { id: number; topics: string[]; data: Record<string, unknown> }[];
}

interface WarningRow {
  orderKind: string;
  orderId: string;
  orderItemId: string | null;
  packageId: string | null;
  supplierCode: string;
  wclItemNo: string | null;
  partNo: string | null;
  dateCode: string;
  limitMonths: number;
  qty: number | null;
  scannedBy: string;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

async function warningsOf(orderKind: string, orderId: string): Promise<WarningRow[]> {
  return queryAll<WarningRow>(
    client.db,
    sql`SELECT order_kind AS "orderKind", order_id AS "orderId", order_item_id AS "orderItemId",
               package_id AS "packageId", supplier_code AS "supplierCode", wcl_item_no AS "wclItemNo",
               part_no AS "partNo", date_code AS "dateCode", limit_months AS "limitMonths", qty,
               scanned_by AS "scannedBy", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy",
               resolution_note AS "resolutionNote"
        FROM outdated_scan_warnings WHERE order_kind = ${orderKind} AND order_id = ${orderId} ORDER BY scanned_at, id`
  );
}

/** Insert a bare picking order + item via SQL (business-key parts). */
async function insertPickingOrder(orderNo: string, status: string): Promise<string> {
  const id = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_orders (id, order_no, status, created_date, last_update_date)
        VALUES (${id}, ${orderNo}, ${status}, now(), now())`
  );
  return id;
}

async function insertPickingItem(orderId: string, partNo: string, qty: number): Promise<string> {
  const id = randomUUID();
  const lineId = 9000 + Math.floor(Math.random() * 100000);
  await client.db.execute(
    sql`INSERT INTO picking_items (id, picking_order_id, part_no, qty, line_id, line_number, shipment_number, created_date, last_update_date)
        VALUES (${id}, ${orderId}, ${partNo}, ${qty}, ${lineId}, 1, 1, now(), now())`
  );
  return id;
}

// --- WWYY helpers + check logic -------------------------------------------------

test("dateCodeRank: 2-digit-year window reads future YY a century earlier; invalid codes rank null", async () => {
  assert.equal(dateCodeRank("0198", REF), 199801); // 2098 > 2027 → 1998
  assert.equal(dateCodeRank("5326", REF), 202653);
  assert.equal(dateCodeRank("9999", REF), null); // week 99
  assert.equal(dateCodeRank("0061", REF), null); // week 00
  assert.equal(dateCodeRank("012", REF), null); // not WWYY
  assert.equal(dateCodeRank(null, REF), null);
});

test("check: boundary at exactly N months is clean, one week older is outdated", async () => {
  await reseed(client);
  await setSupplierLimit("KOA", 12);
  // The WWYY exactly 12 months before REF is the threshold — ranks below it
  // are outdated, the threshold itself is not.
  const thresholdDate = new Date(Date.UTC(2025, 9, 7));
  const boundaryCode = dateToDateCode(thresholdDate);
  const olderCode = dateToDateCode(new Date(thresholdDate.getTime() - 7 * 24 * 3600 * 1000));
  assert.equal(dateCodeRank(boundaryCode, REF), outdatedThresholdRankMonths(12, REF));

  assert.equal(await checkOutdatedDateCode(client.db, { supplierCode: "KOA", dateCode: boundaryCode, now: REF }), null);
  assert.deepEqual(await checkOutdatedDateCode(client.db, { supplierCode: "KOA", dateCode: olderCode, now: REF }), { limitMonths: 12 });
});

test("check: missing profile / NULL limit / invalid or missing date code pass silently", async () => {
  await reseed(client);
  // no profile for DAITO at all
  assert.equal(await checkOutdatedDateCode(client.db, { supplierCode: "DAITO", dateCode: OLD_CODE, now: REF }), null);
  // KOA profile exists but limit is NULL after reseed
  assert.equal(await checkOutdatedDateCode(client.db, { supplierCode: "KOA", dateCode: OLD_CODE, now: REF }), null);
  await setSupplierLimit("KOA", 12);
  // unparseable / missing date codes never warn
  assert.equal(await checkOutdatedDateCode(client.db, { supplierCode: "KOA", dateCode: "9999", now: REF }), null);
  assert.equal(await checkOutdatedDateCode(client.db, { supplierCode: "KOA", dateCode: null, now: REF }), null);
  assert.equal(await checkOutdatedDateCode(client.db, { supplierCode: null, dateCode: OLD_CODE, now: REF }), null);
  // and a valid old code warns again after the NULL-limit interlude
  assert.deepEqual(await checkOutdatedDateCode(client.db, { supplierCode: "KOA", dateCode: OLD_CODE, now: REF }), { limitMonths: 12 });
});

// --- picking scan ---------------------------------------------------------------

test("picking scan: outdated label warns (response + row + event + order surfaces); clean label does not", async () => {
  await reseed(client);
  await allocateAll(client.db);
  const actorId = await actorIdOf();
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  await setSupplierLimit("KOA", 12);

  // brand → profile: item part RK73H1JTTD1002F has parts.brand KOA, covered by
  // the KOA profile's brands.
  const itemId = await pickingItemIdOf(orderId, "RK73H1JTTD1002F");
  const res = await scanPickingItem(client.db, itemId, {
    actorId,
    allocationId: await allocationIdOf(itemId),
    qty: 10,
    dateCode: OLD_CODE,
  });
  assert.deepEqual(res.outdatedWarning, { supplierCode: "KOA", dateCode: OLD_CODE, limitMonths: 12 });

  const warnings = await warningsOf("picking", orderId);
  assert.equal(warnings.length, 1);
  const w = warnings[0];
  assert.equal(w.orderItemId, itemId);
  assert.equal(w.packageId, res.packageIds[0]);
  assert.equal(w.supplierCode, "KOA");
  assert.equal(w.partNo, "RK73H1JTTD1002F");
  assert.equal(w.wclItemNo, "RK73H1JTTD1002F");
  assert.equal(w.qty, 10);
  assert.equal(w.scannedBy, actorId);
  assert.equal(w.resolvedAt, null);

  const created = await eventsOfType("outdated.warning.created");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].topics, ["/admin/outdated-warnings", "/picking-orders"]);
  assert.equal(created[0].data.orderId, orderId);

  // order surfaces carry the unresolved count
  const list = await listPickingOrders(client.db);
  assert.equal(list.rows.find((r) => r.id === orderId)!.outdatedWarningCount, 1);
  const detail = await getPickingOrderDetail(client.db, orderId);
  assert.equal(detail.outdatedWarningCount, 1);

  // clean label (fresh WWYY) and no date code → no warning
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F");
  const clean = await scanPickingItem(client.db, item2, {
    actorId,
    allocationId: await allocationIdOf(item2),
    qty: 5,
    dateCode: dateToDateCode(new Date()),
  });
  assert.equal(clean.outdatedWarning, null);
  const noCode = await scanPickingItem(client.db, item2, {
    actorId,
    allocationId: await allocationIdOf(item2),
    qty: 5,
  });
  assert.equal(noCode.outdatedWarning, null);
  assert.equal((await warningsOf("picking", orderId)).length, 1);

  // scan-into-box path warns too when the caller threads the label date code
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  const boxed = await scanIntoShippingBox(client.db, {
    shippingBoxId: box.id,
    barcode: "RK73H1JTTD2202F",
    qty: 5,
    actorId,
    dateCode: OLD_CODE,
  });
  assert.deepEqual(boxed.outdatedWarning, { supplierCode: "KOA", dateCode: OLD_CODE, limitMonths: 12 });
  assert.equal(await unresolvedOutdatedWarningCount(client.db, "picking", orderId), 2);
});

test("picking finish: 409 unresolved_outdated_warnings while unresolved; succeeds after resolve; resolve idempotent", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  // A fully boxed single-item order built by hand (direct SQL — no
  // auto-finish), so finishPickingOrder itself is the finisher.
  const orderId = await insertPickingOrder("SO-OUTDATED-FINISH", "pending");
  const itemId = await insertPickingItem(orderId, "RK73H1JTTD1002F", 5);
  const boxId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO shipping_boxes (id, picking_order_id, status, created_date, last_update_date)
        VALUES (${boxId}, ${orderId}, 'open', now(), now())`
  );
  await client.db.execute(
    sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, shipping_box_id, created_date, last_update_date)
        VALUES (${randomUUID()}, ${itemId}, ${orderId}, 'inventory_lot', 'test-lot', 5, ${boxId}, now(), now())`
  );
  await client.db.execute(sql`UPDATE picking_items SET picked_qty = 5 WHERE id = ${itemId}`);

  await client.db.transaction(async (tx) => {
    await recordOutdatedWarning(tx, {
      orderKind: "picking",
      orderId,
      orderItemId: itemId,
      supplierCode: "KOA",
      wclItemNo: "RK73H1JTTD1002F",
      partNo: "RK73H1JTTD1002F",
      dateCode: OLD_CODE,
      limitMonths: 12,
      qty: 5,
      scannedBy: actorId,
    });
  });

  const blocked = await catchHttp(finishPickingOrder(client.db, { pickingOrderId: orderId, actorId }));
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.getResponse().json(), { error: "unresolved_outdated_warnings", count: 1 });

  const resolved = await resolveOrderOutdatedWarnings(client.db, { orderKind: "picking", orderId, note: "checked with supplier", actorId });
  assert.deepEqual(resolved, { resolved: 1 });
  const w = (await warningsOf("picking", orderId))[0];
  assert.ok(w.resolvedAt);
  assert.equal(w.resolvedBy, actorId);
  assert.equal(w.resolutionNote, "checked with supplier");
  const resolvedEvents = await eventsOfType("outdated.warning.resolved");
  assert.equal(resolvedEvents.length, 1);
  assert.deepEqual(resolvedEvents[0].topics, ["/admin/outdated-warnings", "/picking-orders"]);

  const done = await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });
  assert.deepEqual(done, { id: orderId, status: "finished" });

  // idempotent re-resolve: nothing stamped, no second event
  assert.deepEqual(await resolveOrderOutdatedWarnings(client.db, { orderKind: "picking", orderId, actorId }), { resolved: 0 });
  assert.equal((await eventsOfType("outdated.warning.resolved")).length, 1);

  const badKind = await catchHttp(resolveOrderOutdatedWarnings(client.db, { orderKind: "nope", orderId, actorId }));
  assert.equal(badKind.status, 400);
  assert.equal(badKind.message, "invalid_order_kind");
});

test("picking auto-finish: held while a warning is unresolved; resolve + re-check finishes", async () => {
  await reseed(client);
  await allocateAll(client.db);
  const actorId = await actorIdOf();
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  await setSupplierLimit("KOA", 12);

  // scan all three items in full — only the first label is outdated
  const scans: [string, number, string | undefined][] = [
    ["RK73H1JTTD1002F", 1000, OLD_CODE],
    ["RK73H1JTTD2202F", 500, undefined],
    ["RK73B1JTTD181G", 300, undefined],
  ];
  for (const [partNo, qty, dateCode] of scans) {
    const itemId = await pickingItemIdOf(orderId, partNo);
    await scanPickingItem(client.db, itemId, { actorId, allocationId: await allocationIdOf(itemId), qty, dateCode });
  }

  // boxing the last package normally auto-finishes the order — the
  // unresolved warning holds it in 'picking'
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId });
  const held = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(held!.status, "picking");

  // resolution itself doesn't finish the order; the route-layer re-check does
  await resolveOrderOutdatedWarnings(client.db, { orderKind: "picking", orderId, actorId });
  assert.equal((await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`))!.status, "picking");
  assert.equal(await retryAutoFinishPickingOrder(client.db, { pickingOrderId: orderId, actorId }), true);
  assert.equal((await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`))!.status, "finished");
});

// --- put-away scan ----------------------------------------------------------------

/** Insert the DAITO profile with a 12-month limit, then create + confirm the
 *  DAITO receiving order into in_hand (same fixture as putaway.test.ts). */
async function daitoInHandWithLimit(): Promise<{ orderId: string; actorId: string }> {
  const actorId = await actorIdOf("operator");
  await client.db.execute(
    sql`INSERT INTO supplier_profiles (id, supplier_code, outdated_limit_months, creation_date, last_update_date)
        VALUES (${randomUUID()}, 'DAITO', 12, now(), now())`
  );
  await insertReceivingOrder(client.db, "04958210", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-07-29", dateCode: "2610" },
    invoices: [
      {
        invoiceNo: "INV-04958210-01",
        wclCompanyName: "WCL Components Ltd",
        totalQty: 8000,
        totalCtn: 2,
        items: [
          { partNo: "RK73B1JTTD181G", poNo: "PO-DAI-301", poLine: "1", lineQty: 5000, dateCode: "2610", coo: "JP", cow: "JP", orgId: 2, subInventoryCode: "STORE1" },
        ],
      },
    ],
  });
  const orderId = await receivingOrderIdOf("04958210");
  await confirmReceivingArrival(client.db, orderId, actorId);
  return { orderId, actorId };
}

test("put-away scan: outdated label warns; commit stays allowed; order clear held until resolved; admin list + filters", async () => {
  await reseed(client);
  const { orderId, actorId } = await daitoInHandWithLimit();
  const itemId = await receivingItemIdOf(orderId, "RK73B1JTTD181G");

  const scan = await recordPutAwayScan(client.db, orderId, {
    actorId,
    receivingInvoiceItemId: itemId,
    qty: 100,
    dateCode: OLD_CODE,
  });
  assert.deepEqual(scan.outdatedWarning, { supplierCode: "DAITO", dateCode: OLD_CODE, limitMonths: 12 });

  const warnings = await warningsOf("putaway", orderId);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].orderItemId, itemId);
  assert.equal(warnings[0].packageId, scan.id); // the shelf_box_items scan row
  assert.equal(warnings[0].supplierCode, "DAITO");
  assert.equal(warnings[0].qty, 100);

  const created = await eventsOfType("outdated.warning.created");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].topics, ["/admin/outdated-warnings", "/receiving-orders"]);

  // clean scan of the rest of the line → no warning field value
  const clean = await recordPutAwayScan(client.db, orderId, {
    actorId,
    receivingInvoiceItemId: itemId,
    qty: 4900,
    dateCode: dateToDateCode(new Date()),
  });
  assert.equal(clean.outdatedWarning, null);

  // order surfaces carry the unresolved count
  const aggregate = await getPutAwayAggregate(client.db, orderId);
  assert.equal(aggregate.outdatedWarningCount, 1);
  const candidates = await listPutAwayCandidates(client.db);
  assert.equal(candidates.find((r) => r.id === orderId)!.outdatedWarningCount, 1);

  // admin list: filters + joined display fields
  const all = await listOutdatedWarnings(client.db);
  assert.equal(all.length, 1);
  assert.equal(all[0].orderNo, "04958210");
  assert.equal(all[0].orderKind, "putaway");
  assert.equal(all[0].supplierName, "DAITO");
  assert.equal(all[0].dateCode, OLD_CODE);
  assert.equal(all[0].limitMonths, 12);
  assert.equal((await listOutdatedWarnings(client.db, { resolved: false })).length, 1);
  assert.equal((await listOutdatedWarnings(client.db, { resolved: true })).length, 0);
  assert.equal((await listOutdatedWarnings(client.db, { orderKind: "putaway" })).length, 1);
  assert.equal((await listOutdatedWarnings(client.db, { orderKind: "picking" })).length, 0);

  // put-away commit is NOT blocked — the operator keeps working; what the
  // warning holds is the order's transition to 'clear'
  const committed = await commitPendingScansToShelf(client.db, orderId, { actorId, shelfCode: "A0101" });
  assert.equal(committed.count, 2);
  assert.equal(committed.qty, 5000);
  const held = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_orders WHERE id = ${orderId}`);
  assert.equal(held!.status, "in_hand"); // auto-clear held by the warning

  await resolveOrderOutdatedWarnings(client.db, { orderKind: "putaway", orderId, note: "ok", actorId });
  assert.equal((await listOutdatedWarnings(client.db, { resolved: true })).length, 1);
  // resolution itself doesn't clear the order; the route-layer re-check does
  assert.equal((await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_orders WHERE id = ${orderId}`))!.status, "in_hand");
  await retryReceivingOrderClear(client.db, { receivingOrderId: orderId, actorId });
  assert.equal((await queryGet<{ status: string }>(client.db, sql`SELECT status FROM receiving_orders WHERE id = ${orderId}`))!.status, "clear");
});

// A supplier with no profile never warns (put-away reads the order's
// supplier_code directly) — the seeded pending KOA order covers picking; the
// DAITO order without the profile insert covers put-away.
test("put-away scan: supplier without a profile passes silently", async () => {
  await reseed(client);
  const actorId = await actorIdOf("operator");
  await insertReceivingOrder(client.db, "04958210", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-07-29", dateCode: "2610" },
    invoices: [
      {
        invoiceNo: "INV-04958210-01",
        items: [{ partNo: "RK73B1JTTD181G", poNo: "PO-DAI-301", poLine: "1", lineQty: 100, orgId: 2, subInventoryCode: "STORE1" }],
      },
    ],
  });
  const orderId = await receivingOrderIdOf("04958210");
  await confirmReceivingArrival(client.db, orderId, actorId);
  const scan = await recordPutAwayScan(client.db, orderId, {
    actorId,
    receivingInvoiceItemId: await receivingItemIdOf(orderId, "RK73B1JTTD181G"),
    qty: 50,
    dateCode: OLD_CODE,
  });
  assert.equal(scan.outdatedWarning, null);
  assert.equal((await warningsOf("putaway", orderId)).length, 0);
});

// addPackageToBox import kept exercised: boxing the warned package is not
// blocked (only order completion — finish / auto-clear — is).
test("picking: boxing a warned package is allowed (only completion is blocked)", async () => {
  await reseed(client);
  await allocateAll(client.db);
  const actorId = await actorIdOf();
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  await setSupplierLimit("KOA", 12);
  const itemId = await pickingItemIdOf(orderId, "RK73H1JTTD1002F");
  const res = await scanPickingItem(client.db, itemId, {
    actorId,
    allocationId: await allocationIdOf(itemId),
    qty: 10,
    dateCode: OLD_CODE,
  });
  assert.ok(res.outdatedWarning);
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addPackageToBox(client.db, { shippingBoxId: box.id, packageId: res.packageIds[0], actorId });
  const detail = await getPickingOrderDetail(client.db, orderId);
  assert.equal(detail.items.find((i) => i.id === itemId)!.packages[0].shippingBoxId, box.id);
});
