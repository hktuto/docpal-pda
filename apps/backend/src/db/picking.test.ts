import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { allocateAll } from "./allocate.js";
import { confirmReceivingArrival } from "./receiving.js";
import {
  acquireWorkLock,
  addAllUnboxedToShippingBox,
  addPackageToBox,
  cancelShippingBox,
  claimShelfBox,
  closeShippingBox,
  createShippingBox,
  finishPickingOrder,
  getPickingOrderDetail,
  listPickingOrderLogs,
  listPickingOrders,
  releaseWorkLock,
  removePackageFromBox,
  removeScannedPackage,
  reorderPickingOrders,
  reportPickingOrderIssues,
  resolvePickingOrderIssue,
  scanPickingItem,
  updateShippingBox,
  verifyPackage,
} from "./picking.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

// --- business-key lookups (never hardcode seed UUIDs) ------------------------

async function actorIdOf(username = "operator"): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = ${username}`);
  return row!.id;
}

async function pickingOrderIdOf(orderNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM picking_orders WHERE order_no = ${orderNo}`);
  return row!.id;
}

async function receivingOrderIdOf(batchNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM receiving_orders WHERE batch_no = ${batchNo}`);
  return row!.id;
}

async function pickingItemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT pi.id FROM picking_items pi
        WHERE pi.picking_order_id = ${orderId} AND pi.part_no = ${partNo}`
  );
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

interface AllocRow {
  id: string;
  qty: number;
  inventoryLotId: string | null;
  receivingInvoiceItemId: string | null;
  receivingOrderId: string | null;
}

async function allocationOf(pickingItemId: string): Promise<AllocRow> {
  const row = await queryGet<AllocRow>(
    client.db,
    sql`SELECT id, qty, inventory_lot_id AS "inventoryLotId",
               receiving_invoice_item_id AS "receivingInvoiceItemId", receiving_order_id AS "receivingOrderId"
        FROM allocations WHERE picking_item_id = ${pickingItemId}`
  );
  return row!;
}

async function itemStateOf(pickingItemId: string): Promise<{ pickedQty: number; allocatedQty: number }> {
  const row = await queryGet<{ pickedQty: number; allocatedQty: number }>(
    client.db,
    sql`SELECT picked_qty AS "pickedQty", allocated_qty AS "allocatedQty" FROM picking_items WHERE id = ${pickingItemId}`
  );
  return row!;
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

/** The seeded pending order (SO-DEMO-0001) with allocations computed. */
async function seededOrderAllocated(): Promise<{ orderId: string; actorId: string }> {
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  return { orderId: await pickingOrderIdOf("SO-DEMO-0001"), actorId };
}

/** Insert a bare picking order via SQL (business-key parts). */
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

// --- list ----------------------------------------------------------------------

test("list: seeded order with item/qty counts; status filter", async () => {
  await reseed(client);
  const { orderId } = await seededOrderAllocated();
  // keep the demo world hermetic: drop the other seeded picking order
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${orderId}`);

  const rows = await listPickingOrders(client.db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, orderId);
  assert.equal(row.orderNo, "SO-DEMO-0001");
  assert.equal(row.status, "pending");
  assert.equal(row.poNo, "CUST-PO-9001");
  assert.equal(row.shipTo, "ACME Electronics (HK)");
  assert.equal(row.customerCode, "ACME");
  assert.ok(row.deliveryDate);
  assert.equal(row.itemCount, 3);
  assert.equal(row.totalQty, 1800);
  assert.equal(row.pickedQty, 0);

  assert.equal((await listPickingOrders(client.db, "pending")).length, 1);
  assert.equal((await listPickingOrders(client.db, "finished")).length, 0);
});

// --- detail ---------------------------------------------------------------------

test("detail: nested shape — order, measuringTask, items with allocations/packages, boxes; 404", async () => {
  await reseed(client);
  const { orderId } = await seededOrderAllocated();

  const detail = await getPickingOrderDetail(client.db, orderId);
  assert.equal(detail.orderNo, "SO-DEMO-0001");
  assert.equal(detail.status, "pending");
  assert.equal(detail.customerCode, "ACME");
  assert.equal(detail.issueReason, null);
  assert.equal(detail.issueReportedBy, null);
  assert.equal(detail.measuringTask, null);
  assert.equal(detail.boxes.length, 0);

  assert.equal(detail.items.length, 3);
  const [item1, item2, item3] = detail.items;
  assert.equal(item1.partNo, "RK73H1JTTD1002F");
  assert.equal(item1.wclItemNo, "RK73H1JTTD1002F");
  assert.equal(item1.qty, 1000);
  assert.equal(item1.pickedQty, 0);
  assert.equal(item1.allocatedQty, 1000);
  assert.equal(item2.partNo, "RK73H1JTTD2202F");
  assert.equal(item2.qty, 500);
  assert.equal(item2.allocatedQty, 500);
  assert.equal(item3.partNo, "RK73B1JTTD181G");
  assert.equal(item3.qty, 300);
  assert.equal(item3.allocatedQty, 300);

  assert.equal(item1.allocations.length, 1);
  const alloc = item1.allocations[0];
  assert.equal(alloc.qty, 1000);
  assert.equal(alloc.receivingInvoiceItemId, null);
  assert.equal(alloc.receivingOrderId, null);
  assert.equal(alloc.boxId, null);
  assert.ok(alloc.lot);
  assert.equal(alloc.lot.shelfCode, "A-01-01");
  assert.equal(alloc.lot.boxId, "BOX-H-20260701-0001");
  assert.equal(alloc.lot.dateCode, "2603");
  assert.equal(alloc.lot.lotCode, "L2603A");
  assert.equal(alloc.lot.coo, "JP");
  assert.equal(alloc.lot.cow, "JP");
  assert.equal(alloc.lot.totalQty, 1000);
  assert.equal(alloc.lot.allocatedQty, 1000);
  assert.equal(alloc.lot.availableQty, 0);
  assert.equal(item1.packages.length, 0);

  // the 181G item allocates from the A-01-02 lot, which SO-DEMO-0002 also
  // draws on (300 + 400 = the full 700)
  assert.equal(item3.allocations.length, 1);
  const alloc3 = item3.allocations[0];
  assert.equal(alloc3.qty, 300);
  assert.ok(alloc3.lot);
  assert.equal(alloc3.lot.shelfCode, "A-01-02");
  assert.equal(alloc3.lot.boxId, "BOX-H-20260701-0002");
  assert.equal(alloc3.lot.dateCode, "2604");
  assert.equal(alloc3.lot.lotCode, "L2604A");
  assert.equal(alloc3.lot.totalQty, 700);
  assert.equal(alloc3.lot.allocatedQty, 700);
  assert.equal(alloc3.lot.availableQty, 0);
  assert.equal(item3.packages.length, 0);

  const notFound = await catchHttp(getPickingOrderDetail(client.db, randomUUID()));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "picking_order_not_found");
});

// --- scan (lot source) -----------------------------------------------------------

test("scan: lot source — package + batch snapshot, lot/allocation shrink, PICK ledger, recompute, transitions", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();
  const itemId = await pickingItemIdOf(orderId, "RK73H1JTTD1002F");
  const alloc = await allocationOf(itemId);
  assert.equal(alloc.qty, 1000);
  assert.ok(alloc.inventoryLotId);
  const lotId = alloc.inventoryLotId;

  const { packageIds } = await scanPickingItem(client.db, itemId, { actorId, allocationId: alloc.id, qty: 500 });
  assert.equal(packageIds.length, 1);

  // package with source + batch snapshot from the lot
  const pkg = await queryGet<{
    id: string;
    pickingOrderId: string;
    sourceType: string;
    sourceId: string;
    qty: number;
    dateCode: string | null;
    lotCode: string | null;
    coo: string | null;
    cow: string | null;
    verified: boolean;
    shippingBoxId: string | null;
  }>(
    client.db,
    sql`SELECT id, picking_order_id AS "pickingOrderId", source_type AS "sourceType", source_id AS "sourceId",
               qty, date_code AS "dateCode", lot_code AS "lotCode", coo, cow, verified,
               shipping_box_id AS "shippingBoxId"
        FROM picking_packages WHERE id = ${packageIds[0]}`
  );
  assert.ok(pkg);
  assert.equal(pkg.pickingOrderId, orderId);
  assert.equal(pkg.sourceType, "inventory_lot");
  assert.equal(pkg.sourceId, lotId);
  assert.equal(pkg.qty, 500);
  assert.equal(pkg.dateCode, "2603");
  assert.equal(pkg.lotCode, "L2603A");
  assert.equal(pkg.coo, "JP");
  assert.equal(pkg.cow, "JP");
  assert.equal(pkg.verified, false);
  assert.equal(pkg.shippingBoxId, null);

  // lot total/allocated decremented; allocation shrunk; item recomputed
  const lot = await queryGet<{ totalQty: number; allocatedQty: number }>(
    client.db,
    sql`SELECT total_qty AS "totalQty", allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = ${lotId}`
  );
  assert.deepEqual(lot, { totalQty: 500, allocatedQty: 500 });
  assert.equal((await allocationOf(itemId)).qty, 500);
  assert.deepEqual(await itemStateOf(itemId), { pickedQty: 0, allocatedQty: 500 }); // unboxed ⇒ not picked

  // PICK ledger rows: reserved −qty AND on_hand −qty
  const txns = await queryAll<{
    qtyType: string;
    qtyDelta: number;
    lotId: string | null;
    shelfCode: string | null;
    boxId: string | null;
    referenceType: string | null;
    referenceId: string | null;
    actorId: string | null;
    dateCode: string | null;
    txnReason: string | null;
  }>(
    client.db,
    sql`SELECT qty_type AS "qtyType", qty_delta AS "qtyDelta", inventory_lot_id AS "lotId",
               shelf_code AS "shelfCode", box_id AS "boxId",
               reference_type AS "referenceType", reference_id AS "referenceId",
               actor_id AS "actorId", date_code AS "dateCode", txn_reason AS "txnReason"
        FROM inventory_transactions WHERE txn_type = 'PICK'`
  );
  assert.equal(txns.length, 2);
  const byType = new Map(txns.map((t) => [t.qtyType, t]));
  assert.equal(byType.get("reserved")!.qtyDelta, -500);
  assert.equal(byType.get("on_hand")!.qtyDelta, -500);
  for (const t of txns) {
    assert.equal(t.lotId, lotId);
    assert.equal(t.shelfCode, "A-01-01");
    assert.equal(t.boxId, "BOX-H-20260701-0001");
    assert.equal(t.referenceType, "picking_item");
    assert.equal(t.referenceId, itemId);
    assert.equal(t.actorId, actorId);
    assert.equal(t.dateCode, "2603");
    assert.equal(t.txnReason, "pick");
  }

  // order pending → picking + transition logs
  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "picking");
  const orderLogs = await queryAll<{ fromState: string | null; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId}`
  );
  assert.deepEqual(orderLogs, [{ fromState: "pending", toState: "picking", actorId }]);
  const itemLog = await queryGet<{ fromState: string; toState: string; metadata: { qty: number } }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", metadata
        FROM transaction_logs WHERE entity_type = 'picking_item' AND entity_id = ${itemId}`
  );
  assert.equal(itemLog!.fromState, "picking");
  assert.equal(itemLog!.toState, "scanned");
  assert.equal(itemLog!.metadata.qty, 500);

  // explicit batch-attr overrides win over the source snapshot
  const scan2 = await scanPickingItem(client.db, itemId, {
    actorId,
    allocationId: alloc.id,
    qty: 100,
    lotCode: "L-OVR",
    coo: "CN",
  });
  const pkg2 = await queryGet<{ lotCode: string | null; coo: string | null; dateCode: string | null }>(
    client.db,
    sql`SELECT lot_code AS "lotCode", coo, date_code AS "dateCode" FROM picking_packages WHERE id = ${scan2.packageIds[0]}`
  );
  assert.equal(pkg2!.lotCode, "L-OVR");
  assert.equal(pkg2!.coo, "CN");
  assert.equal(pkg2!.dateCode, "2603"); // untouched fields still snapshot the source
});

test("scan guards: over-allocation, over-required, ownership, actor, qty, order status", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 1000
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F");
  const alloc1 = await allocationOf(item1);
  const alloc2 = await allocationOf(item2);

  const badQty = await catchHttp(scanPickingItem(client.db, item1, { actorId, allocationId: alloc1.id, qty: 0 }));
  assert.equal(badQty.status, 400);
  assert.equal(badQty.message, "qty_must_be_positive_integer");

  const overAlloc = await catchHttp(scanPickingItem(client.db, item1, { actorId, allocationId: alloc1.id, qty: 2001 }));
  assert.equal(overAlloc.status, 409);
  assert.equal(overAlloc.message, "scanned_qty_exceeds_allocation");

  // allocation of another item → 404
  const wrongItem = await catchHttp(scanPickingItem(client.db, item1, { actorId, allocationId: alloc2.id, qty: 1 }));
  assert.equal(wrongItem.status, 404);
  assert.equal(wrongItem.message, "allocation_not_found");

  const noAlloc = await catchHttp(scanPickingItem(client.db, item1, { actorId, allocationId: randomUUID(), qty: 1 }));
  assert.equal(noAlloc.status, 404);
  assert.equal(noAlloc.message, "allocation_not_found");

  const badActor = await catchHttp(scanPickingItem(client.db, item1, { actorId: randomUUID(), allocationId: alloc1.id, qty: 1 }));
  assert.equal(badActor.status, 400);
  assert.equal(badActor.message, "actor_not_found");

  // shrink the allocation, then qty > remaining allocation → 409
  await scanPickingItem(client.db, item1, { actorId, allocationId: alloc1.id, qty: 500 });
  const overRemaining = await catchHttp(scanPickingItem(client.db, item1, { actorId, allocationId: alloc1.id, qty: 501 }));
  assert.equal(overRemaining.status, 409);
  assert.equal(overRemaining.message, "scanned_qty_exceeds_allocation");

  // packaged (1000 = item qty after the next scan) + qty > item.qty with a
  // second allocation present → 409 scan_qty_exceeds_required
  const lot2 = (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0002' AND part_no = 'RK73B1JTTD181G'`
  ))!;
  await client.db.execute(
    sql`INSERT INTO allocations (id, picking_item_id, inventory_lot_id, qty, created_date, last_update_date)
        VALUES (${randomUUID()}, ${item1}, ${lot2.id}, 100, now(), now())`
  );
  const extraAlloc = (await queryAll<AllocRow>(
    client.db,
    sql`SELECT id, qty, inventory_lot_id AS "inventoryLotId",
               receiving_invoice_item_id AS "receivingInvoiceItemId", receiving_order_id AS "receivingOrderId"
        FROM allocations WHERE picking_item_id = ${item1} AND inventory_lot_id = ${lot2.id}`
  ))[0];
  await scanPickingItem(client.db, item1, { actorId, allocationId: alloc1.id, qty: 500 }); // packaged = 1000
  const overRequired = await catchHttp(scanPickingItem(client.db, item1, { actorId, allocationId: extraAlloc.id, qty: 100 }));
  assert.equal(overRequired.status, 409);
  assert.equal(overRequired.message, "scan_qty_exceeds_required");

  // order with an open issue rejects scans
  await reportPickingOrderIssues(client.db, {
    actorId,
    entries: [{ pickingOrderId: orderId, reason: "other" }],
  });
  const issued = await catchHttp(scanPickingItem(client.db, item1, { actorId, allocationId: extraAlloc.id, qty: 100 }));
  assert.equal(issued.status, 409);
  assert.equal(issued.message, "picking_order_has_open_issue");
});

// --- remove package ----------------------------------------------------------------

test("remove package: reverses lot/allocation/ledger; guards", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();
  const itemId = await pickingItemIdOf(orderId, "RK73H1JTTD1002F");
  const alloc = await allocationOf(itemId);
  const lotId = alloc.inventoryLotId!;
  const { packageIds } = await scanPickingItem(client.db, itemId, { actorId, allocationId: alloc.id, qty: 500 });

  await removeScannedPackage(client.db, { packageId: packageIds[0], actorId });

  // lot + allocation + item restored
  const lot = await queryGet<{ totalQty: number; allocatedQty: number }>(
    client.db,
    sql`SELECT total_qty AS "totalQty", allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = ${lotId}`
  );
  assert.deepEqual(lot, { totalQty: 1000, allocatedQty: 1000 });
  assert.equal((await allocationOf(itemId)).qty, 1000);
  assert.deepEqual(await itemStateOf(itemId), { pickedQty: 0, allocatedQty: 1000 });
  assert.equal(await queryGet(client.db, sql`SELECT id FROM picking_packages WHERE id = ${packageIds[0]}`), undefined);

  // reverse ledger rows (+qty)
  const reverseTxns = await queryAll<{ qtyType: string; qtyDelta: number; lotId: string | null }>(
    client.db,
    sql`SELECT qty_type AS "qtyType", qty_delta AS "qtyDelta", inventory_lot_id AS "lotId"
        FROM inventory_transactions WHERE txn_type = 'PICK' AND txn_reason = 'remove package'`
  );
  assert.equal(reverseTxns.length, 2);
  const byType = new Map(reverseTxns.map((t) => [t.qtyType, t]));
  assert.equal(byType.get("reserved")!.qtyDelta, 500);
  assert.equal(byType.get("on_hand")!.qtyDelta, 500);
  assert.equal(byType.get("reserved")!.lotId, lotId);

  const itemLog = await queryGet<{ fromState: string; toState: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState"
        FROM transaction_logs WHERE entity_type = 'picking_item' AND entity_id = ${itemId} AND to_state = 'removed'`
  );
  assert.deepEqual(itemLog, { fromState: "scanned", toState: "removed" });

  // guards
  const notFound = await catchHttp(removeScannedPackage(client.db, { packageId: randomUUID(), actorId }));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.message, "package_not_found");

  const scan2 = await scanPickingItem(client.db, itemId, { actorId, allocationId: alloc.id, qty: 200 });
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addPackageToBox(client.db, { shippingBoxId: box.id, packageId: scan2.packageIds[0], actorId });
  const boxed = await catchHttp(removeScannedPackage(client.db, { packageId: scan2.packageIds[0], actorId }));
  assert.equal(boxed.status, 409);
  assert.equal(boxed.message, "package_already_in_box");
});

// --- create box with pre-printed id --------------------------------------------------

test("boxes: create with pre-printed boxId; duplicate and empty guards", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();

  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId, boxId: "BOX-HK1-2826-000001" });
  assert.equal(box.id, "BOX-HK1-2826-000001");
  assert.equal(box.status, "open");

  const dup = await catchHttp(createShippingBox(client.db, { pickingOrderId: orderId, actorId, boxId: "BOX-HK1-2826-000001" }));
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "box_id_exists");

  const empty = await catchHttp(createShippingBox(client.db, { pickingOrderId: orderId, actorId, boxId: "   " }));
  assert.equal(empty.status, 400);
  assert.equal(empty.message, "box_id_empty");

  // id is trimmed before use
  const padded = await createShippingBox(client.db, { pickingOrderId: orderId, actorId, boxId: "  BOX-HK1-2826-000002  " });
  assert.equal(padded.id, "BOX-HK1-2826-000002");
});

// --- box membership + cancel --------------------------------------------------------

test("boxes: membership add/remove, cancel; guards incl. different orders", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F");
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F");
  const p1 = (await scanPickingItem(client.db, item1, { actorId, allocationId: (await allocationOf(item1)).id, qty: 500 })).packageIds[0];
  const p2 = (await scanPickingItem(client.db, item2, { actorId, allocationId: (await allocationOf(item2)).id, qty: 300 })).packageIds[0];

  const boxA = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  assert.equal(boxA.status, "open");
  assert.equal(boxA.pickingOrderId, orderId);
  const openLog = await queryGet<{ fromState: string | null; toState: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState"
        FROM transaction_logs WHERE entity_type = 'shipping_box' AND entity_id = ${boxA.id}`
  );
  assert.deepEqual(openLog, { fromState: null, toState: "open" });

  await addPackageToBox(client.db, { shippingBoxId: boxA.id, packageId: p1, actorId });
  assert.equal((await itemStateOf(item1)).pickedQty, 500); // boxed ⇒ picked

  const already = await catchHttp(addPackageToBox(client.db, { shippingBoxId: boxA.id, packageId: p1, actorId }));
  assert.equal(already.status, 409);
  assert.equal(already.message, "package_already_in_box");

  const noPkg = await catchHttp(addPackageToBox(client.db, { shippingBoxId: boxA.id, packageId: randomUUID(), actorId }));
  assert.equal(noPkg.status, 404);
  assert.equal(noPkg.message, "package_not_found");

  // package of a different picking order → 409
  const otherOrderId = await insertPickingOrder("SO-X-OTHER", "pending");
  const otherItemId = await insertPickingItem(otherOrderId, "RK73H1JTTD1002F", 100);
  const lotId = (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0001' AND part_no = 'RK73H1JTTD1002F'`
  ))!.id;
  const otherPkgId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, created_date, last_update_date)
        VALUES (${otherPkgId}, ${otherItemId}, ${otherOrderId}, 'inventory_lot', ${lotId}, 100, now(), now())`
  );
  const otherOrder = await catchHttp(addPackageToBox(client.db, { shippingBoxId: boxA.id, packageId: otherPkgId, actorId }));
  assert.equal(otherOrder.status, 409);
  assert.equal(otherOrder.message, "different_picking_orders");

  // cancel: non-empty box → 409; emptied → cancelled + hard delete
  const boxB = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addPackageToBox(client.db, { shippingBoxId: boxB.id, packageId: p2, actorId });
  const notEmpty = await catchHttp(cancelShippingBox(client.db, { shippingBoxId: boxB.id, actorId }));
  assert.equal(notEmpty.status, 409);
  assert.equal(notEmpty.message, "shipping_box_not_empty");

  await removePackageFromBox(client.db, { shippingBoxId: boxB.id, packageId: p2, actorId });
  assert.equal((await itemStateOf(item2)).pickedQty, 0);
  const unboxed = await queryGet<{ shippingBoxId: string | null; verified: boolean }>(
    client.db,
    sql`SELECT shipping_box_id AS "shippingBoxId", verified FROM picking_packages WHERE id = ${p2}`
  );
  assert.deepEqual(unboxed, { shippingBoxId: null, verified: false });

  const notInBox = await catchHttp(removePackageFromBox(client.db, { shippingBoxId: boxB.id, packageId: p2, actorId }));
  assert.equal(notInBox.status, 404);
  assert.equal(notInBox.message, "package_not_found");

  await cancelShippingBox(client.db, { shippingBoxId: boxB.id, actorId });
  assert.equal(await queryGet(client.db, sql`SELECT id FROM shipping_boxes WHERE id = ${boxB.id}`), undefined);
  const cancelLog = await queryGet<{ fromState: string; toState: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState"
        FROM transaction_logs WHERE entity_type = 'shipping_box' AND entity_id = ${boxB.id} AND to_state = 'cancelled'`
  );
  assert.deepEqual(cancelLog, { fromState: "open", toState: "cancelled" });

  const gone = await catchHttp(cancelShippingBox(client.db, { shippingBoxId: boxB.id, actorId }));
  assert.equal(gone.status, 404);
  assert.equal(gone.message, "shipping_box_not_found");
});

// --- close flow + auto-finish ---------------------------------------------------------

test("close flow: add-all-unboxed auto-finishes; verify → measure → close cascade", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F");
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F");
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G");
  const p1 = (await scanPickingItem(client.db, item1, { actorId, allocationId: (await allocationOf(item1)).id, qty: 1000 })).packageIds[0];
  const p2 = (await scanPickingItem(client.db, item2, { actorId, allocationId: (await allocationOf(item2)).id, qty: 500 })).packageIds[0];
  const p3 = (await scanPickingItem(client.db, item3, { actorId, allocationId: (await allocationOf(item3)).id, qty: 300 })).packageIds[0];

  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  const emptyClose = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(emptyClose.status, 409);
  assert.equal(emptyClose.message, "cannot_close_empty_shipping_box");

  const { packed } = await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId });
  assert.equal(packed, 3);

  // last package boxed → order auto-finished + measuring task (exactly one)
  const order = await queryGet<{ status: string }>(client.db, sql`SELECT status FROM picking_orders WHERE id = ${orderId}`);
  assert.equal(order!.status, "finished");
  const tasks = await queryAll<{ id: string; status: string }>(
    client.db,
    sql`SELECT id, status FROM measuring_tasks WHERE picking_order_id = ${orderId}`
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "pending");
  const orderLogs = await queryAll<{ fromState: string | null; toState: string }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState"
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId} ORDER BY created_date, id`
  );
  assert.deepEqual(
    orderLogs.map((l) => [l.fromState, l.toState]),
    [
      ["pending", "picking"],
      ["picking", "finished"],
    ]
  );

  const unverified = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(unverified.status, 409);
  assert.equal(unverified.message, "all_packages_must_be_verified");

  await verifyPackage(client.db, { packageId: p1, actorId });
  await verifyPackage(client.db, { packageId: p2, actorId });
  await verifyPackage(client.db, { packageId: p3, actorId });

  // destination falls back to the order's ship_to, so the
  // first failing requirement is the missing box size
  const noSize = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(noSize.status, 409);
  assert.equal(noSize.message, "box_size_required");

  await updateShippingBox(client.db, box.id, { actorId, boxSize: "26 X 20 X 20" });
  const noWeights = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(noWeights.status, 409);
  assert.equal(noWeights.message, "weights_required");

  await updateShippingBox(client.db, box.id, { actorId, netWeightKg: 0.5 });
  const halfWeights = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(halfWeights.status, 409);
  assert.equal(halfWeights.message, "weights_required");

  await updateShippingBox(client.db, box.id, { actorId, grossWeightKg: 0.3 });
  const grossLtNet = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(grossLtNet.status, 409);
  assert.equal(grossLtNet.message, "gross_weight_must_be_gte_net_weight");

  const updated = await updateShippingBox(client.db, box.id, { actorId, grossWeightKg: 0.8 });
  assert.equal(updated.grossWeight, 0.8);
  assert.equal(updated.netWeight, 0.5);

  await closeShippingBox(client.db, { shippingBoxId: box.id, actorId });
  const closed = await queryGet<{ status: string; destinationCountry: string | null }>(
    client.db,
    sql`SELECT status, destination_country AS "destinationCountry" FROM shipping_boxes WHERE id = ${box.id}`
  );
  assert.deepEqual(closed, { status: "closed", destinationCountry: "ACME Electronics (HK)" });

  const detail = await getPickingOrderDetail(client.db, orderId);
  // last-box close auto-completed the measuring task (and spawned the verify task)
  assert.equal(detail.measuringTask?.status, "completed");
  const verifyTask = await queryGet<{ status: string }>(
    client.db,
    sql`SELECT status FROM verify_tasks WHERE picking_order_id = ${orderId}`
  );
  assert.equal(verifyTask!.status, "pending");
  assert.equal(detail.boxes.length, 1);
  assert.equal(detail.boxes[0].status, "closed");
  assert.equal(detail.boxes[0].boxSize, "26 X 20 X 20");
  assert.equal(detail.boxes[0].packageCount, 3);
  assert.equal(detail.items[0].pickedQty, 1000);
  assert.equal(detail.items[1].pickedQty, 500);
  assert.equal(detail.items[2].pickedQty, 300);

  const again = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(again.status, 409);
  assert.equal(again.message, "shipping_box_not_open");
});

// --- finish ------------------------------------------------------------------------

test("finish: explicit finish + guards (unfinished, empty, task exists, already finished)", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();

  const unfinished = await catchHttp(finishPickingOrder(client.db, { pickingOrderId: orderId, actorId }));
  assert.equal(unfinished.status, 409);
  assert.equal(unfinished.message, "not_all_items_fully_boxed");

  const emptyOrderId = await insertPickingOrder("SO-EMPTY", "pending");
  const noItems = await catchHttp(finishPickingOrder(client.db, { pickingOrderId: emptyOrderId, actorId }));
  assert.equal(noItems.status, 409);
  assert.equal(noItems.message, "no_items_to_pick");

  const taskOrderId = await insertPickingOrder("SO-MT", "picking");
  await client.db.execute(
    sql`INSERT INTO measuring_tasks (id, picking_order_id, status, created_date)
        VALUES (${randomUUID()}, ${taskOrderId}, 'pending', now())`
  );
  const taskExists = await catchHttp(finishPickingOrder(client.db, { pickingOrderId: taskOrderId, actorId }));
  assert.equal(taskExists.status, 409);
  assert.equal(taskExists.message, "measuring_task_exists");

  // finish the seeded order fully by hand: scan all + box all, then explicit finish
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F");
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F");
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G");
  await scanPickingItem(client.db, item1, { actorId, allocationId: (await allocationOf(item1)).id, qty: 1000 });
  await scanPickingItem(client.db, item2, { actorId, allocationId: (await allocationOf(item2)).id, qty: 500 });
  await scanPickingItem(client.db, item3, { actorId, allocationId: (await allocationOf(item3)).id, qty: 300 });
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId }); // auto-finishes here

  const already = await catchHttp(finishPickingOrder(client.db, { pickingOrderId: orderId, actorId }));
  assert.equal(already.status, 409);
  assert.equal(already.message, "picking_order_already_finished");

  const scanFinished = await catchHttp(
    scanPickingItem(client.db, item1, { actorId, allocationId: (await allocationOf(item1)).id, qty: 1 })
  );
  assert.equal(scanFinished.status, 409);
  assert.equal(scanFinished.message, "picking_order_already_finished");
});

// --- verify cascade --------------------------------------------------------------------

test("verify: guard cascade — unboxed, no task, ok, duplicate, closed box", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F");
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F");
  const p1 = (await scanPickingItem(client.db, item1, { actorId, allocationId: (await allocationOf(item1)).id, qty: 500 })).packageIds[0];

  const unboxed = await catchHttp(verifyPackage(client.db, { packageId: p1, actorId }));
  assert.equal(unboxed.status, 409);
  assert.equal(unboxed.message, "package_not_in_box");

  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await addPackageToBox(client.db, { shippingBoxId: box.id, packageId: p1, actorId });
  const noTask = await catchHttp(verifyPackage(client.db, { packageId: p1, actorId }));
  assert.equal(noTask.status, 409);
  assert.equal(noTask.message, "no_pending_measure_or_verify_task");

  // finish the order (auto) so the measuring task exists
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G");
  const p2 = (await scanPickingItem(client.db, item1, { actorId, allocationId: (await allocationOf(item1)).id, qty: 500 })).packageIds[0];
  const p3 = (await scanPickingItem(client.db, item2, { actorId, allocationId: (await allocationOf(item2)).id, qty: 500 })).packageIds[0];
  const p4 = (await scanPickingItem(client.db, item3, { actorId, allocationId: (await allocationOf(item3)).id, qty: 300 })).packageIds[0];
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId });

  await verifyPackage(client.db, { packageId: p1, actorId });
  const verified = await queryGet<{ verified: boolean }>(
    client.db,
    sql`SELECT verified FROM picking_packages WHERE id = ${p1}`
  );
  assert.equal(verified!.verified, true);
  const pkgLog = await queryGet<{ fromState: string; toState: string; actorId: string | null }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId"
        FROM transaction_logs WHERE entity_type = 'picking_package' AND entity_id = ${p1}`
  );
  assert.deepEqual(pkgLog, { fromState: "unverified", toState: "verified", actorId });

  const dup = await catchHttp(verifyPackage(client.db, { packageId: p1, actorId }));
  assert.equal(dup.status, 409);
  assert.equal(dup.message, "package_already_verified");

  await verifyPackage(client.db, { packageId: p2, actorId });
  await verifyPackage(client.db, { packageId: p3, actorId });
  await verifyPackage(client.db, { packageId: p4, actorId });
  await updateShippingBox(client.db, box.id, { actorId, boxSize: "26 X 20 X 20", netWeightKg: 0.5, grossWeightKg: 0.8 });
  await closeShippingBox(client.db, { shippingBoxId: box.id, actorId });

  // closing the last box auto-completed the measuring task and spawned the
  // verify task — scanning now runs in verify mode: closed box allowed, both
  // flags set
  await verifyPackage(client.db, { packageId: p1, actorId });
  const rescanned = await queryGet<{ verified: boolean; verifyVerified: boolean }>(
    client.db,
    sql`SELECT verified, verify_verified AS "verifyVerified" FROM picking_packages WHERE id = ${p1}`
  );
  assert.deepEqual(rescanned, { verified: true, verifyVerified: true });

  const dupRescan = await catchHttp(verifyPackage(client.db, { packageId: p1, actorId }));
  assert.equal(dupRescan.status, 409);
  assert.equal(dupRescan.message, "package_already_verified");
});

// --- receiving-source picking ------------------------------------------------------------

test("scan from receiving sources: order-level (no box) and box-level allocations", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  const roId = await receivingOrderIdOf("100002"); // KOA, pending in the seed

  // keep the world hermetic: the seeded orders compete for the same parts
  // (SO-DEMO-0001 now also demands 181G, and the seeded shelf stock would win
  // FIFO before the receiving sources under test)
  await client.db.execute(sql`DELETE FROM picking_orders WHERE order_no IN ('SO-DEMO-0001', 'SO-DEMO-0002')`);
  await client.db.execute(sql`DELETE FROM inventory_lots WHERE box_id = 'BOX-H-20260701-0002'`);

  // give the RK73H1JTTD4702F line a box → its allocation becomes box-level;
  // the 181G line (no box, qty raised to cover the demand) pools into an
  // order-level allocation
  const f4702ItemId = await receivingItemIdOf(roId, "RK73H1JTTD4702F");
  await client.db.execute(sql`UPDATE receiving_invoice_items SET ctn_no = 'BOX-KOA-1' WHERE id = ${f4702ItemId}`);
  const g181ItemId = await receivingItemIdOf(roId, "RK73B1JTTD181G");
  await client.db.execute(sql`UPDATE receiving_invoice_items SET ctn_no = NULL, line_qty = 1000 WHERE id = ${g181ItemId}`);

  const orderId = await insertPickingOrder("SO-2026-0002", "pending");
  const itemA = await insertPickingItem(orderId, "RK73B1JTTD181G", 1000); // order-level source
  const itemB = await insertPickingItem(orderId, "RK73H1JTTD4702F", 500); // box-level source

  await confirmReceivingArrival(client.db, roId, actorId);
  await allocateAll(client.db);

  const allocA = await allocationOf(itemA);
  assert.equal(allocA.qty, 1000);
  assert.equal(allocA.inventoryLotId, null);
  assert.equal(allocA.receivingInvoiceItemId, null);
  assert.equal(allocA.receivingOrderId, roId);
  const allocB = await allocationOf(itemB);
  assert.equal(allocB.qty, 500);
  assert.equal(allocB.receivingInvoiceItemId, f4702ItemId);
  assert.equal(allocB.receivingOrderId, null);

  // --- order-level scan: FIFO distribution across the order's lines for the part
  const scanA = await scanPickingItem(client.db, itemA, { actorId, allocationId: allocA.id, qty: 600 });
  assert.equal(scanA.packageIds.length, 1);
  const pkgA = await queryGet<{ sourceType: string; sourceId: string; qty: number; dateCode: string | null; coo: string | null }>(
    client.db,
    sql`SELECT source_type AS "sourceType", source_id AS "sourceId", qty, date_code AS "dateCode", coo
        FROM picking_packages WHERE id = ${scanA.packageIds[0]}`
  );
  assert.ok(pkgA);
  assert.equal(pkgA.sourceType, "receiving_order");
  assert.equal(pkgA.sourceId, roId);
  assert.equal(pkgA.qty, 600);
  assert.equal(pkgA.dateCode, "2607"); // batch snapshot from the consumed line
  assert.equal(pkgA.coo, "JP");

  const resItem = await receivingItemIdOf(roId, "RK73B1JTTD181G");
  const riiA = await queryGet<{ pickedQty: number }>(
    client.db,
    sql`SELECT picked_qty AS "pickedQty" FROM receiving_invoice_items WHERE id = ${resItem}`
  );
  assert.equal(riiA!.pickedQty, 600);
  assert.equal((await allocationOf(itemA)).qty, 400);
  assert.deepEqual(await itemStateOf(itemA), { pickedQty: 0, allocatedQty: 400 });

  const pickTxns = await queryAll<{ qtyType: string; qtyDelta: number; riiId: string | null; boxId: string | null; shelfCode: string | null }>(
    client.db,
    sql`SELECT qty_type AS "qtyType", qty_delta AS "qtyDelta",
               receiving_invoice_item_id AS "riiId", box_id AS "boxId", shelf_code AS "shelfCode"
        FROM inventory_transactions WHERE txn_type = 'PICK' AND reference_id = ${itemA}`
  );
  assert.equal(pickTxns.length, 2);
  const pickByType = new Map(pickTxns.map((t) => [t.qtyType, t]));
  assert.equal(pickByType.get("reserved")!.qtyDelta, -600);
  assert.equal(pickByType.get("on_hand")!.qtyDelta, -600);
  assert.equal(pickByType.get("on_hand")!.riiId, resItem);
  assert.equal(pickByType.get("on_hand")!.boxId, null); // order-level line has no box
  assert.equal(pickByType.get("on_hand")!.shelfCode, null);

  // --- box-level scan
  const scanB = await scanPickingItem(client.db, itemB, { actorId, allocationId: allocB.id, qty: 200 });
  const pkgB = await queryGet<{ sourceType: string; sourceId: string; dateCode: string | null }>(
    client.db,
    sql`SELECT source_type AS "sourceType", source_id AS "sourceId", date_code AS "dateCode"
        FROM picking_packages WHERE id = ${scanB.packageIds[0]}`
  );
  assert.equal(pkgB!.sourceType, "receiving_invoice_item");
  assert.equal(pkgB!.sourceId, f4702ItemId);
  assert.equal(pkgB!.dateCode, "2607");
  const riiB = await queryGet<{ pickedQty: number }>(
    client.db,
    sql`SELECT picked_qty AS "pickedQty" FROM receiving_invoice_items WHERE id = ${f4702ItemId}`
  );
  assert.equal(riiB!.pickedQty, 200);
  const boxTxn = await queryGet<{ boxId: string | null; riiId: string | null }>(
    client.db,
    sql`SELECT box_id AS "boxId", receiving_invoice_item_id AS "riiId"
        FROM inventory_transactions WHERE txn_type = 'PICK' AND reference_id = ${itemB} AND qty_type = 'on_hand'`
  );
  assert.equal(boxTxn!.boxId, "BOX-KOA-1");
  assert.equal(boxTxn!.riiId, f4702ItemId);

  // --- removal of an order-level package credits the line back + restores the allocation
  await removeScannedPackage(client.db, { packageId: scanA.packageIds[0], actorId });
  const riiA2 = await queryGet<{ pickedQty: number }>(
    client.db,
    sql`SELECT picked_qty AS "pickedQty" FROM receiving_invoice_items WHERE id = ${resItem}`
  );
  assert.equal(riiA2!.pickedQty, 0);
  assert.equal((await allocationOf(itemA)).qty, 1000);
  const reverseTxns = await queryAll<{ qtyType: string; qtyDelta: number; riiId: string | null }>(
    client.db,
    sql`SELECT qty_type AS "qtyType", qty_delta AS "qtyDelta", receiving_invoice_item_id AS "riiId"
        FROM inventory_transactions WHERE txn_type = 'PICK' AND txn_reason = 'remove package' AND reference_id = ${itemA}`
  );
  assert.equal(reverseTxns.length, 2);
  const revByType = new Map(reverseTxns.map((t) => [t.qtyType, t]));
  assert.equal(revByType.get("reserved")!.qtyDelta, 600);
  assert.equal(revByType.get("on_hand")!.qtyDelta, 600);
  assert.equal(revByType.get("on_hand")!.riiId, resItem);
});

// --- report issues --------------------------------------------------------------------------

test("report-issues: reported/skipped, issue fields + log; validations", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();
  const finishedId = await insertPickingOrder("SO-DONE", "finished");

  // validations first (all roll back)
  const noOrders = await catchHttp(reportPickingOrderIssues(client.db, { actorId, entries: [] }));
  assert.equal(noOrders.status, 400);
  assert.equal(noOrders.message, "no_orders_selected");

  const badReason = await catchHttp(
    reportPickingOrderIssues(client.db, {
      actorId,
      entries: [{ pickingOrderId: orderId, reason: "bogus" as never }],
    })
  );
  assert.equal(badReason.status, 400);
  assert.equal(badReason.message, "unhandled_issue_reason");

  const noQty = await catchHttp(
    reportPickingOrderIssues(client.db, { actorId, entries: [{ pickingOrderId: orderId, reason: "insufficient_stock" }] })
  );
  assert.equal(noQty.status, 400);
  assert.equal(noQty.message, "actual_quantity_required");

  const fullQty = await catchHttp(
    reportPickingOrderIssues(client.db, {
      actorId,
      entries: [{ pickingOrderId: orderId, reason: "insufficient_stock", qty: 1800 }], // = totalQty
    })
  );
  assert.equal(fullQty.status, 400);
  assert.equal(fullQty.message, "actual_qty_must_be_less_than_requested");

  const noPackSize = await catchHttp(
    reportPickingOrderIssues(client.db, { actorId, entries: [{ pickingOrderId: orderId, reason: "cannot_divide" }] })
  );
  assert.equal(noPackSize.status, 400);
  assert.equal(noPackSize.message, "pack_size_required");

  const mergeSingle = await catchHttp(
    reportPickingOrderIssues(client.db, { actorId, entries: [{ pickingOrderId: orderId, reason: "merge" }] })
  );
  assert.equal(mergeSingle.status, 400);
  assert.equal(mergeSingle.message, "select_at_least_two_orders_to_merge");

  const unknownId = randomUUID();
  const noneReportable = await catchHttp(
    reportPickingOrderIssues(client.db, { actorId, entries: [{ pickingOrderId: unknownId, reason: "other" }] })
  );
  assert.equal(noneReportable.status, 400);
  assert.equal(noneReportable.message, "no_reportable_orders_selected");

  // happy path: one reported, unknown + finished skipped
  const result = await reportPickingOrderIssues(client.db, {
    actorId,
    entries: [
      { pickingOrderId: orderId, reason: "insufficient_stock", qty: 500, note: "only 500 on shelf", remark: "partial ship" },
      { pickingOrderId: unknownId, reason: "other" },
      { pickingOrderId: finishedId, reason: "other" },
    ],
  });
  assert.deepEqual(result, { reported: [orderId], skipped: [unknownId, finishedId] });

  const order = await queryGet<{
    status: string;
    issueReason: string | null;
    issueQty: number | null;
    issuePackSize: number | null;
    issueNote: string | null;
    issueRemark: string | null;
    issueReportedBy: string | null;
    issueReportedAt: Date | null;
  }>(
    client.db,
    sql`SELECT status, issue_reason AS "issueReason", issue_qty AS "issueQty",
               issue_pack_size AS "issuePackSize", issue_note AS "issueNote", issue_remark AS "issueRemark",
               issue_reported_by AS "issueReportedBy", issue_reported_at AS "issueReportedAt"
        FROM picking_orders WHERE id = ${orderId}`
  );
  assert.equal(order!.status, "issue");
  assert.equal(order!.issueReason, "insufficient_stock");
  assert.equal(order!.issueQty, 500);
  assert.equal(order!.issuePackSize, null);
  assert.equal(order!.issueNote, "only 500 on shelf");
  assert.equal(order!.issueRemark, "partial ship");
  assert.equal(order!.issueReportedBy, actorId);
  assert.ok(order!.issueReportedAt);

  const log = await queryGet<{ fromState: string; toState: string; metadata: { reason: string; qty: number } }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", metadata
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId} AND to_state = 'issue'`
  );
  assert.equal(log!.fromState, "pending");
  assert.equal(log!.metadata.reason, "insufficient_stock");
  assert.equal(log!.metadata.qty, 500);
});

test("resolve-issue: report → resolve → pending, issue fields cleared, log; allocation restored", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();
  // keep the demo world hermetic: drop the other seeded picking order so the
  // demand counts below only reflect this order
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${orderId}`);
  const itemId = await pickingItemIdOf(orderId, "RK73H1JTTD1002F");
  assert.ok((await itemStateOf(itemId)).allocatedQty > 0);

  // report → the order is no longer an allocation demand
  await reportPickingOrderIssues(client.db, {
    actorId,
    entries: [{ pickingOrderId: orderId, reason: "other", note: "label unreadable" }],
  });
  const whileIssue = await allocateAll(client.db);
  assert.equal(whileIssue.demands, 0);

  // resolve → back to pending with every issue field cleared
  const resolved = await resolvePickingOrderIssue(client.db, {
    orderId,
    actorId,
    resolutionNote: " label re-printed ",
  });
  assert.deepEqual(resolved, { id: orderId, orderNo: "SO-DEMO-0001", status: "pending" });

  const order = await queryGet<{
    status: string;
    issueReason: string | null;
    issueQty: number | null;
    issuePackSize: number | null;
    issueNote: string | null;
    issueRemark: string | null;
    issueReportedBy: string | null;
    issueReportedAt: Date | null;
  }>(
    client.db,
    sql`SELECT status, issue_reason AS "issueReason", issue_qty AS "issueQty",
               issue_pack_size AS "issuePackSize", issue_note AS "issueNote", issue_remark AS "issueRemark",
               issue_reported_by AS "issueReportedBy", issue_reported_at AS "issueReportedAt"
        FROM picking_orders WHERE id = ${orderId}`
  );
  assert.deepEqual(order, {
    status: "pending",
    issueReason: null,
    issueQty: null,
    issuePackSize: null,
    issueNote: null,
    issueRemark: null,
    issueReportedBy: null,
    issueReportedAt: null,
  });

  // transition log: issue → pending with the old reason + resolution note
  const log = await queryGet<{
    fromState: string;
    toState: string;
    actorId: string;
    metadata: { reason: string; resolutionNote: string };
  }>(
    client.db,
    sql`SELECT from_state AS "fromState", to_state AS "toState", actor_id AS "actorId", metadata
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId} AND to_state = 'pending'`
  );
  assert.equal(log!.fromState, "issue");
  assert.equal(log!.actorId, actorId);
  assert.deepEqual(log!.metadata, { reason: "other", resolutionNote: "label re-printed" });

  // SSE event for open pages
  const evt = await queryGet<{ type: string; topics: string[] }>(
    client.db,
    sql`SELECT type, topics FROM app_events WHERE type = 'picking_order.updated' AND data->>'id' = ${orderId}`
  );
  assert.deepEqual(evt!.topics, ["/picking-orders"]);

  // participates in allocation again (the route runs allocateAll post-commit)
  const afterResolve = await allocateAll(client.db);
  assert.equal(afterResolve.demands, 3);
  assert.ok((await itemStateOf(itemId)).allocatedQty > 0);

  // error paths
  const noIssue = await catchHttp(resolvePickingOrderIssue(client.db, { orderId, actorId }));
  assert.equal(noIssue.status, 409);
  assert.equal(noIssue.message, "picking_order_no_open_issue");

  const missing = await catchHttp(resolvePickingOrderIssue(client.db, { orderId: randomUUID(), actorId }));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "picking_order_not_found");
});

// --- page work lock + priority reorder (2026-07-23 design) -------------------

test("work lock: acquire, same-user refresh, 409 other user, release, expired re-acquire", async () => {
  await reseed(client);
  const orderId = await pickingOrderIdOf("SO-DEMO-0001");
  const operator = await actorIdOf("operator");
  const admin = await actorIdOf("admin");

  const lock = await acquireWorkLock(client.db, { orderId, actorId: operator });
  assert.equal(lock.workingBy, operator);

  // same-user refresh is idempotent
  const again = await acquireWorkLock(client.db, { orderId, actorId: operator });
  assert.equal(again.workingBy, operator);

  // another user → 409 lock_held with holder info in the JSON body
  const err = await catchHttp(acquireWorkLock(client.db, { orderId, actorId: admin }));
  assert.equal(err.status, 409);
  const body = (await err.res!.json()) as { error: string; holderId: string };
  assert.equal(body.error, "lock_held");
  assert.equal(body.holderId, operator);

  // non-holder release is a silent no-op
  await releaseWorkLock(client.db, { orderId, actorId: admin });
  const stillHeld = await catchHttp(acquireWorkLock(client.db, { orderId, actorId: admin }));
  assert.equal(stillHeld.status, 409);

  // holder release clears the lock
  await releaseWorkLock(client.db, { orderId, actorId: operator });
  const reacquired = await acquireWorkLock(client.db, { orderId, actorId: admin });
  assert.equal(reacquired.workingBy, admin);

  // an expired lock (> 10 min) can be taken by anyone
  await client.db.execute(
    sql`UPDATE picking_orders SET working_at = now() - interval '20 minutes' WHERE id = ${orderId}`
  );
  const taken = await acquireWorkLock(client.db, { orderId, actorId: operator });
  assert.equal(taken.workingBy, operator);
});

test("work lock: finished order cannot be locked", async () => {
  await reseed(client);
  const orderId = await insertPickingOrder("SO-LOCK-FIN", "finished");
  const err = await catchHttp(acquireWorkLock(client.db, { orderId, actorId: await actorIdOf() }));
  assert.equal(err.status, 409);
});

test("work lock: finishing the order clears the lock", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  const orderId = await insertPickingOrder("SO-LOCK-FINISH", "picking");
  const itemId = await insertPickingItem(orderId, "RK73H1JTTD1002F", 5);
  await acquireWorkLock(client.db, { orderId, actorId });
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

  const task = await finishPickingOrder(client.db, { pickingOrderId: orderId, actorId });
  assert.equal(task.status, "pending");
  const row = await queryGet<{ w: string | null }>(
    client.db,
    sql`SELECT working_by AS w FROM picking_orders WHERE id = ${orderId}`
  );
  assert.equal(row!.w, null);
});

test("reorder: rewrites priority_seq, emits event, list follows, rejects bad ids", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  const a = await pickingOrderIdOf("SO-DEMO-0001");
  const b = await insertPickingOrder("SO-REORDER-B", "pending");
  const cOrder = await insertPickingOrder("SO-REORDER-C", "pending");

  const res = await reorderPickingOrders(client.db, { actorId, orderIds: [cOrder, a, b] });
  assert.equal(res.reordered, 3);
  const seqOf = async (id: string) =>
    Number((await queryGet<{ seq: number }>(client.db, sql`SELECT priority_seq AS seq FROM picking_orders WHERE id = ${id}`))!.seq);
  assert.equal(await seqOf(cOrder), 1);
  assert.equal(await seqOf(a), 2);
  assert.equal(await seqOf(b), 3);

  const ev = await queryGet<{ type: string }>(
    client.db,
    sql`SELECT type FROM app_events WHERE type = 'picking.reordered' ORDER BY id DESC LIMIT 1`
  );
  assert.ok(ev);

  const list = await listPickingOrders(client.db);
  const wanted = list.map((o) => o.id).filter((id) => [cOrder, a, b].includes(id));
  assert.deepEqual(wanted, [cOrder, a, b]);

  const fin = await insertPickingOrder("SO-REORDER-FIN", "finished");
  const err = await catchHttp(reorderPickingOrders(client.db, { actorId, orderIds: [a, fin] }));
  assert.equal(err.status, 400);
  assert.match(err.message, /invalid_order_ids/);
});

// --- admin audit logs (2026-07-27 design) --------------------------------------

test("picking order logs: order + item/package/box rows with actor name, newest first; 404 unknown order", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 1000
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F"); // qty 500
  const item3 = await pickingItemIdOf(orderId, "RK73B1JTTD181G"); // qty 300

  assert.deepEqual(await listPickingOrderLogs(client.db, orderId), []);

  // full flow: box → scan all items in full → box everything (auto-finish
  // creates the measuring task) → verify one package
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  const p1 = (
    await scanPickingItem(client.db, item1, { actorId, allocationId: (await allocationOf(item1)).id, qty: 1000 })
  ).packageIds[0]!;
  await scanPickingItem(client.db, item2, { actorId, allocationId: (await allocationOf(item2)).id, qty: 500 });
  await scanPickingItem(client.db, item3, { actorId, allocationId: (await allocationOf(item3)).id, qty: 300 });
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId });
  await verifyPackage(client.db, { packageId: p1, actorId });

  // logs can share a millisecond — make the order deterministic
  await client.db.execute(
    sql`UPDATE transaction_logs SET created_date = created_date - interval '1 minute' WHERE to_state <> 'verified'`
  );

  const logs = await listPickingOrderLogs(client.db, orderId);
  assert.ok(logs.length >= 5);
  for (const l of logs) {
    assert.equal(l.actorId, actorId);
    assert.equal(l.actorName, "Demo Operator");
  }

  // newest first: the package verification is the latest entry
  assert.equal(logs[0]!.entityType, "picking_package");
  assert.equal(logs[0]!.entityId, p1);
  assert.equal(logs[0]!.fromState, "unverified");
  assert.equal(logs[0]!.toState, "verified");

  const byType = new Map<string, string[]>();
  for (const l of logs) byType.set(l.entityType, [...(byType.get(l.entityType) ?? []), l.entityId]);
  assert.ok(byType.get("picking_order")!.includes(orderId));
  assert.deepEqual(new Set(byType.get("picking_item")), new Set([item1, item2, item3]));
  assert.deepEqual(byType.get("picking_package"), [p1]);
  assert.deepEqual(byType.get("shipping_box"), [box.id]);

  const missing = await catchHttp(listPickingOrderLogs(client.db, randomUUID()));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "picking_order_not_found");
});


// --- whole-box exact-match claim ------------------------------------------------

interface ClaimWorld {
  actorId: string;
  boxId: string;
  lotIds: string[];
  orderId: string;
}

/** Controlled world: one shelf box (500 × RK73H1JTTD1002F + 300 ×
 *  RK73H1JTTD2202F, sourced from receiving lines carrying carton metadata in
 *  additional_data) and a pending order with exactly that demand. */
async function seedClaimWorld(): Promise<ClaimWorld> {
  await reseed(client);
  const actorId = await actorIdOf();
  const boxId = "BOX-H-TEST-CLAIM-1";
  await client.db.execute(
    sql`INSERT INTO shelf_boxes (id, shelf_code, org_id, sub_inventory_code, status, created_date, last_update_date)
        VALUES (${boxId}, 'A-01-01', 2, 'STORE1', 'closed', now(), now())`
  );
  const roId = randomUUID();
  const riId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO receiving_orders (id, batch_no, org_id, sub_inventory_code, status, created_date, last_update_date)
        VALUES (${roId}, 'TEST-CLAIM-BATCH', 2, 'STORE1', 'clear', now(), now())`
  );
  await client.db.execute(
    sql`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, org_id, created_date, last_update_date)
        VALUES (${riId}, ${roId}, 'INV-CLAIM-1', 2, now(), now())`
  );
  const lines: { partNo: string; ad: string }[] = [
    { partNo: "RK73H1JTTD1002F", ad: JSON.stringify({ boxSize: "33 X 24 X 18", netWeight: 1200, grossWeight: 1500, weightUnit: "g" }) },
    { partNo: "RK73H1JTTD2202F", ad: JSON.stringify({ netWeight: 0.8, grossWeight: 1.1 }) },
  ];
  const lotIds: string[] = [];
  const qtys = [500, 300];
  for (let i = 0; i < lines.length; i++) {
    const riiId = randomUUID();
    const lotId = randomUUID();
    lotIds.push(lotId);
    await client.db.execute(
      sql`INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_no, line_qty, received_qty, put_away_qty,
                                               org_id, additional_data, created_date, last_update_date)
          VALUES (${riiId}, ${riId}, ${lines[i]!.partNo}, ${qtys[i]}, ${qtys[i]}, ${qtys[i]}, 2,
                  ${lines[i]!.ad}::jsonb, now(), now())`
    );
    await client.db.execute(
      sql`INSERT INTO inventory_lots (id, part_no, shelf_code, box_id, org_id, sub_inventory_code, total_qty,
                                     created_date, last_update_date)
          VALUES (${lotId}, ${lines[i]!.partNo}, 'A-01-01', ${boxId}, 2, 'STORE1', ${qtys[i]}, now(), now())`
    );
    await client.db.execute(
      sql`INSERT INTO inventory_lot_sources (id, inventory_lot_id, receiving_invoice_item_id, qty, created_date, last_update_date)
          VALUES (${randomUUID()}, ${lotId}, ${riiId}, ${qtys[i]}, now(), now())`
    );
  }
  const orderId = await insertPickingOrder("SO-TEST-CLAIM", "pending");
  await insertPickingItem(orderId, "RK73H1JTTD1002F", 500);
  await insertPickingItem(orderId, "RK73H1JTTD2202F", 300);
  return { actorId, boxId, lotIds, orderId };
}

test("claim-shelf-box: detail hints the exact-match box, claim reuses the carton as a prefilled shipping box", async () => {
  const { actorId, boxId, lotIds, orderId } = await seedClaimWorld();

  const before = await getPickingOrderDetail(client.db, orderId);
  assert.equal(before.suggestedBox?.id, boxId);
  assert.deepEqual(
    new Map(before.suggestedBox!.contents.map((c) => [c.partNo, c.qty])),
    new Map([
      ["RK73H1JTTD1002F", 500],
      ["RK73H1JTTD2202F", 300],
    ])
  );

  const result = await claimShelfBox(client.db, { orderId, shelfBoxId: boxId, actorId });
  assert.ok(result.shippingBoxId.startsWith("BOX-S-"));
  assert.equal(result.packageIds.length, 2);

  const shipBox = await queryGet<{
    status: string;
    boxSize: string | null;
    netWeight: number | null;
    grossWeight: number | null;
    sourceShelfBoxId: string | null;
  }>(
    client.db,
    sql`SELECT status, box_size AS "boxSize", net_weight AS "netWeight", gross_weight AS "grossWeight",
               source_shelf_box_id AS "sourceShelfBoxId"
        FROM shipping_boxes WHERE id = ${result.shippingBoxId}`
  );
  assert.equal(shipBox!.status, "open");
  assert.equal(shipBox!.boxSize, "33 X 24 X 18");
  assert.equal(shipBox!.netWeight, 2); // 1200 g → 1.2 kg + 0.8 kg
  assert.equal(shipBox!.grossWeight, 2.6); // 1500 g → 1.5 kg + 1.1 kg
  assert.equal(shipBox!.sourceShelfBoxId, boxId);

  // packages are boxed, sourced from the box's lots
  const packages = await queryAll<{ qty: number; shippingBoxId: string | null; sourceId: string }>(
    client.db,
    sql`SELECT qty, shipping_box_id AS "shippingBoxId", source_id AS "sourceId"
        FROM picking_packages WHERE picking_order_id = ${orderId}`
  );
  assert.equal(packages.length, 2);
  for (const p of packages) {
    assert.equal(p.shippingBoxId, result.shippingBoxId);
    assert.ok(lotIds.includes(p.sourceId));
  }

  // lots emptied, allocations gone, order auto-finished with a measuring task
  for (const lotId of lotIds) {
    const lot = await queryGet<{ totalQty: number; allocatedQty: number }>(
      client.db,
      sql`SELECT total_qty AS "totalQty", allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = ${lotId}`
    );
    assert.equal(lot!.totalQty, 0);
    assert.equal(lot!.allocatedQty, 0);
  }
  const allocCount = await queryGet<{ c: number }>(
    client.db,
    sql`SELECT COUNT(*)::int AS c FROM allocations a JOIN picking_items pi ON pi.id = a.picking_item_id
        WHERE pi.picking_order_id = ${orderId}`
  );
  assert.equal(allocCount!.c, 0);

  const after = await getPickingOrderDetail(client.db, orderId);
  assert.equal(after.status, "finished");
  assert.equal(after.measuringTask?.status, "pending");
  assert.equal(after.suggestedBox, null); // finished orders never hint
});

test("claim-shelf-box: non-exact box is rejected", async () => {
  const { actorId, boxId } = await seedClaimWorld();
  const orderId = await insertPickingOrder("SO-TEST-CLAIM-NOMATCH", "pending");
  await insertPickingItem(orderId, "RK73H1JTTD1002F", 500);
  await insertPickingItem(orderId, "RK73H1JTTD2202F", 301); // off by one

  const detail = await getPickingOrderDetail(client.db, orderId);
  assert.equal(detail.suggestedBox, null);

  const err = await catchHttp(claimShelfBox(client.db, { orderId, shelfBoxId: boxId, actorId }));
  assert.equal(err.status, 409);
  assert.equal(err.message, "box_not_exact_match");
});

test("claim-shelf-box: box partially reserved by another order is rejected", async () => {
  const { actorId, boxId, lotIds, orderId } = await seedClaimWorld();
  // another order holds a reservation on the 1002F box lot
  const otherOrderId = await insertPickingOrder("SO-TEST-CLAIM-HOLDER", "pending");
  const otherItemId = await insertPickingItem(otherOrderId, "RK73H1JTTD1002F", 100);
  await client.db.execute(
    sql`INSERT INTO allocations (id, picking_item_id, inventory_lot_id, qty, created_date, last_update_date)
        VALUES (${randomUUID()}, ${otherItemId}, ${lotIds[0]}, 100, now(), now())`
  );
  await client.db.execute(sql`UPDATE inventory_lots SET allocated_qty = 100 WHERE id = ${lotIds[0]}`);

  const detail = await getPickingOrderDetail(client.db, orderId);
  assert.equal(detail.suggestedBox, null); // matched but not fully claimable → no hint

  const err = await catchHttp(claimShelfBox(client.db, { orderId, shelfBoxId: boxId, actorId }));
  assert.equal(err.status, 409);
  assert.equal(err.message, "box_not_fully_available");

  // the holder's reservation is untouched
  const alloc = await queryGet<{ qty: number }>(
    client.db,
    sql`SELECT qty FROM allocations WHERE picking_item_id = ${otherItemId}`
  );
  assert.equal(alloc!.qty, 100);
});

test("claim-shelf-box: unknown shelf box → 404", async () => {
  const { actorId, orderId } = await seedClaimWorld();
  const err = await catchHttp(claimShelfBox(client.db, { orderId, shelfBoxId: "BOX-H-NOPE", actorId }));
  assert.equal(err.status, 404);
  assert.equal(err.message, "shelf_box_not_found");
});

test("pack path: boxing packages prefills the box from the source carton's additional_data (no clobber)", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  // case-1 demo world: receiving 100003's carton C3001 == SO-DEMO-0003 exactly;
  // the 3302F line carries { boxSize, netWeight 1100 g, grossWeight 1250 g }
  await confirmReceivingArrival(client.db, await receivingOrderIdOf("100003"), actorId);
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-DEMO-0003");

  // pick both lines straight from the receiving carton (scan path)
  for (const [partNo, qty] of [["RK73H1JTTD3302F", 500], ["RK73H1JTTD6802F", 800]] as const) {
    const itemId = await pickingItemIdOf(orderId, partNo);
    const alloc = await allocationOf(itemId);
    assert.ok(alloc.receivingInvoiceItemId, `${partNo} should allocate from a receiving line`);
    await scanPickingItem(client.db, itemId, { actorId, allocationId: alloc.id, qty });
  }

  // an operator-set field is kept; NULL fields are filled from the carton
  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  await updateShippingBox(client.db, box.id, { actorId, netWeightKg: 9 });
  const { packed } = await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId });
  assert.equal(packed, 2);

  const filled = await queryGet<{ boxSize: string | null; netWeight: number | null; grossWeight: number | null }>(
    client.db,
    sql`SELECT box_size AS "boxSize", net_weight AS "netWeight", gross_weight AS "grossWeight"
        FROM shipping_boxes WHERE id = ${box.id}`
  );
  assert.equal(filled!.boxSize, "30 X 24 X 20");
  assert.equal(filled!.netWeight, 9); // operator value wins
  assert.equal(filled!.grossWeight, 1.25); // 1250 g → kg
});
