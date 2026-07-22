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
  addAllUnboxedToShippingBox,
  addPackageToBox,
  cancelShippingBox,
  closeShippingBox,
  createShippingBox,
  finishPickingOrder,
  getPickingOrderDetail,
  listPickingOrders,
  removePackageFromBox,
  removeScannedPackage,
  reportPickingOrderIssues,
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

/** The seeded pending order (SO-2026-0001) with allocations computed. */
async function seededOrderAllocated(): Promise<{ orderId: string; actorId: string }> {
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  return { orderId: await pickingOrderIdOf("SO-2026-0001"), actorId };
}

/** Insert a bare picking order via SQL (business-key parts). */
async function insertPickingOrder(orderNo: string, status: string): Promise<string> {
  const id = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_orders (id, order_no, status, created_at, updated_at)
        VALUES (${id}, ${orderNo}, ${status}, now(), now())`
  );
  return id;
}

async function insertPickingItem(orderId: string, partNo: string, qty: number): Promise<string> {
  const id = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_items (id, picking_order_id, part_no, qty, created_at, updated_at)
        VALUES (${id}, ${orderId}, ${partNo}, ${qty}, now(), now())`
  );
  return id;
}

// --- list ----------------------------------------------------------------------

test("list: seeded order with item/qty counts; status filter", async () => {
  await reseed(client);
  const { orderId } = await seededOrderAllocated();
  // keep the demo world hermetic: drop the new_seed real-data picking orders
  await client.db.execute(sql`DELETE FROM picking_orders WHERE id <> ${orderId}`);

  const rows = await listPickingOrders(client.db);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, orderId);
  assert.equal(row.orderNo, "SO-2026-0001");
  assert.equal(row.status, "pending");
  assert.equal(row.poNo, "CUST-PO-8899");
  assert.equal(row.shipTo, "ACME Electronics (HK)");
  assert.equal(row.customerCode, "ACME");
  assert.ok(row.deliveryDate);
  assert.equal(row.itemCount, 2);
  assert.equal(row.totalQty, 3000);
  assert.equal(row.pickedQty, 0);

  assert.equal((await listPickingOrders(client.db, "pending")).length, 1);
  assert.equal((await listPickingOrders(client.db, "finished")).length, 0);
});

// --- detail ---------------------------------------------------------------------

test("detail: nested shape — order, measuringTask, items with allocations/packages, boxes; 404", async () => {
  await reseed(client);
  const { orderId } = await seededOrderAllocated();

  const detail = await getPickingOrderDetail(client.db, orderId);
  assert.equal(detail.orderNo, "SO-2026-0001");
  assert.equal(detail.status, "pending");
  assert.equal(detail.customerCode, "ACME");
  assert.equal(detail.issueReason, null);
  assert.equal(detail.issueReportedBy, null);
  assert.equal(detail.measuringTask, null);
  assert.equal(detail.boxes.length, 0);

  assert.equal(detail.items.length, 2);
  const [item1, item2] = detail.items;
  assert.equal(item1.partNo, "RK73H1JTTD1002F");
  assert.equal(item1.wclItemNo, "RK73H1JTTD1002F");
  assert.equal(item1.qty, 2000);
  assert.equal(item1.pickedQty, 0);
  assert.equal(item1.allocatedQty, 2000);
  assert.equal(item2.partNo, "RK73H1JTTD2202F");
  assert.equal(item2.qty, 1000);
  assert.equal(item2.allocatedQty, 1000);

  assert.equal(item1.allocations.length, 1);
  const alloc = item1.allocations[0];
  assert.equal(alloc.qty, 2000);
  assert.equal(alloc.receivingInvoiceItemId, null);
  assert.equal(alloc.receivingOrderId, null);
  assert.equal(alloc.boxId, null);
  assert.ok(alloc.lot);
  assert.equal(alloc.lot.shelfCode, "A-01-01");
  assert.equal(alloc.lot.boxId, "BOX-0001");
  assert.equal(alloc.lot.dateCode, "2601");
  assert.equal(alloc.lot.lotCode, "L2601A");
  assert.equal(alloc.lot.coo, "JP");
  assert.equal(alloc.lot.cow, "JP");
  assert.equal(alloc.lot.totalQty, 10000);
  assert.equal(alloc.lot.allocatedQty, 2000);
  assert.equal(alloc.lot.availableQty, 8000);
  assert.equal(item1.packages.length, 0);

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
  assert.equal(alloc.qty, 2000);
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
  assert.equal(pkg.dateCode, "2601");
  assert.equal(pkg.lotCode, "L2601A");
  assert.equal(pkg.coo, "JP");
  assert.equal(pkg.cow, "JP");
  assert.equal(pkg.verified, false);
  assert.equal(pkg.shippingBoxId, null);

  // lot total/allocated decremented; allocation shrunk; item recomputed
  const lot = await queryGet<{ totalQty: number; allocatedQty: number }>(
    client.db,
    sql`SELECT total_qty AS "totalQty", allocated_qty AS "allocatedQty" FROM inventory_lots WHERE id = ${lotId}`
  );
  assert.deepEqual(lot, { totalQty: 9500, allocatedQty: 1500 });
  assert.equal((await allocationOf(itemId)).qty, 1500);
  assert.deepEqual(await itemStateOf(itemId), { pickedQty: 0, allocatedQty: 1500 }); // unboxed ⇒ not picked

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
    assert.equal(t.boxId, "BOX-0001");
    assert.equal(t.referenceType, "picking_item");
    assert.equal(t.referenceId, itemId);
    assert.equal(t.actorId, actorId);
    assert.equal(t.dateCode, "2601");
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
  assert.equal(pkg2!.dateCode, "2601"); // untouched fields still snapshot the source
});

test("scan guards: over-allocation, over-required, ownership, actor, qty, order status", async () => {
  await reseed(client);
  const { orderId, actorId } = await seededOrderAllocated();
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F"); // qty 2000
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
  await scanPickingItem(client.db, item1, { actorId, allocationId: alloc1.id, qty: 1500 });
  const overRemaining = await catchHttp(scanPickingItem(client.db, item1, { actorId, allocationId: alloc1.id, qty: 501 }));
  assert.equal(overRemaining.status, 409);
  assert.equal(overRemaining.message, "scanned_qty_exceeds_allocation");

  // packaged (2000 = item qty after the next scan) + qty > item.qty with a
  // second allocation present → 409 scan_qty_exceeds_required
  const lot2 = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-0002'`))!;
  await client.db.execute(
    sql`INSERT INTO allocations (id, picking_item_id, inventory_lot_id, qty, created_at, updated_at)
        VALUES (${randomUUID()}, ${item1}, ${lot2.id}, 100, now(), now())`
  );
  const extraAlloc = (await queryAll<AllocRow>(
    client.db,
    sql`SELECT id, qty, inventory_lot_id AS "inventoryLotId",
               receiving_invoice_item_id AS "receivingInvoiceItemId", receiving_order_id AS "receivingOrderId"
        FROM allocations WHERE picking_item_id = ${item1} AND inventory_lot_id = ${lot2.id}`
  ))[0];
  await scanPickingItem(client.db, item1, { actorId, allocationId: alloc1.id, qty: 500 }); // packaged = 2000
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
  assert.deepEqual(lot, { totalQty: 10000, allocatedQty: 2000 });
  assert.equal((await allocationOf(itemId)).qty, 2000);
  assert.deepEqual(await itemStateOf(itemId), { pickedQty: 0, allocatedQty: 2000 });
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
  const lotId = (await queryGet<{ id: string }>(client.db, sql`SELECT id FROM inventory_lots WHERE box_id = 'BOX-0001'`))!.id;
  const otherPkgId = randomUUID();
  await client.db.execute(
    sql`INSERT INTO picking_packages (id, picking_item_id, picking_order_id, source_type, source_id, qty, created_at, updated_at)
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
  const p1 = (await scanPickingItem(client.db, item1, { actorId, allocationId: (await allocationOf(item1)).id, qty: 2000 })).packageIds[0];
  const p2 = (await scanPickingItem(client.db, item2, { actorId, allocationId: (await allocationOf(item2)).id, qty: 1000 })).packageIds[0];

  const box = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  const emptyClose = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(emptyClose.status, 409);
  assert.equal(emptyClose.message, "cannot_close_empty_shipping_box");

  const { packed } = await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId });
  assert.equal(packed, 2);

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
        FROM transaction_logs WHERE entity_type = 'picking_order' AND entity_id = ${orderId} ORDER BY created_at, id`
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

  // destination falls back to the order's ship_to, so the
  // first failing requirement is the missing box size
  const noSize = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(noSize.status, 409);
  assert.equal(noSize.message, "box_size_required");

  await updateShippingBox(client.db, box.id, { actorId, boxSize: "26 X 20 X 20" });
  const noWeights = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(noWeights.status, 409);
  assert.equal(noWeights.message, "weights_required");

  await updateShippingBox(client.db, box.id, { actorId, netWeightG: 500 });
  const halfWeights = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(halfWeights.status, 409);
  assert.equal(halfWeights.message, "weights_required");

  await updateShippingBox(client.db, box.id, { actorId, grossWeightG: 300 });
  const grossLtNet = await catchHttp(closeShippingBox(client.db, { shippingBoxId: box.id, actorId }));
  assert.equal(grossLtNet.status, 409);
  assert.equal(grossLtNet.message, "gross_weight_must_be_gte_net_weight");

  const updated = await updateShippingBox(client.db, box.id, { actorId, grossWeightG: 800 });
  assert.equal(updated.grossWeight, 800);
  assert.equal(updated.netWeight, 500);

  await closeShippingBox(client.db, { shippingBoxId: box.id, actorId });
  const closed = await queryGet<{ status: string; destinationCountry: string | null }>(
    client.db,
    sql`SELECT status, destination_country AS "destinationCountry" FROM shipping_boxes WHERE id = ${box.id}`
  );
  assert.deepEqual(closed, { status: "closed", destinationCountry: "ACME Electronics (HK)" });

  const detail = await getPickingOrderDetail(client.db, orderId);
  assert.equal(detail.measuringTask?.status, "pending");
  assert.equal(detail.boxes.length, 1);
  assert.equal(detail.boxes[0].status, "closed");
  assert.equal(detail.boxes[0].boxSize, "26 X 20 X 20");
  assert.equal(detail.boxes[0].packageCount, 2);
  assert.equal(detail.items[0].pickedQty, 2000);
  assert.equal(detail.items[1].pickedQty, 1000);

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
    sql`INSERT INTO measuring_tasks (id, picking_order_id, status, created_at)
        VALUES (${randomUUID()}, ${taskOrderId}, 'pending', now())`
  );
  const taskExists = await catchHttp(finishPickingOrder(client.db, { pickingOrderId: taskOrderId, actorId }));
  assert.equal(taskExists.status, 409);
  assert.equal(taskExists.message, "measuring_task_exists");

  // finish the seeded order fully by hand: scan all + box all, then explicit finish
  const item1 = await pickingItemIdOf(orderId, "RK73H1JTTD1002F");
  const item2 = await pickingItemIdOf(orderId, "RK73H1JTTD2202F");
  await scanPickingItem(client.db, item1, { actorId, allocationId: (await allocationOf(item1)).id, qty: 2000 });
  await scanPickingItem(client.db, item2, { actorId, allocationId: (await allocationOf(item2)).id, qty: 1000 });
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
  assert.equal(noTask.message, "measuring_task_not_pending");

  // finish the order (auto) so the measuring task exists
  const p2 = (await scanPickingItem(client.db, item1, { actorId, allocationId: (await allocationOf(item1)).id, qty: 1500 })).packageIds[0];
  const p3 = (await scanPickingItem(client.db, item2, { actorId, allocationId: (await allocationOf(item2)).id, qty: 1000 })).packageIds[0];
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
  await updateShippingBox(client.db, box.id, { actorId, boxSize: "26 X 20 X 20", netWeightG: 500, grossWeightG: 800 });
  await closeShippingBox(client.db, { shippingBoxId: box.id, actorId });

  const closedBox = await catchHttp(verifyPackage(client.db, { packageId: p1, actorId }));
  assert.equal(closedBox.status, 409);
  assert.equal(closedBox.message, "shipping_box_not_open");
});

// --- receiving-source picking ------------------------------------------------------------

test("scan from receiving sources: order-level (no box) and box-level allocations", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  const roId = await receivingOrderIdOf("04958210"); // DAITO, pending in the seed

  // give the P413 line a box → its allocation becomes box-level; the other
  // line (no box) pools into an order-level allocation
  const p413ItemId = await receivingItemIdOf(roId, "P413");
  await client.db.execute(sql`UPDATE receiving_invoice_items SET ctn_no = 'BOX-DAI-1' WHERE id = ${p413ItemId}`);

  const orderId = await insertPickingOrder("SO-2026-0002", "pending");
  const itemA = await insertPickingItem(orderId, "RK73B1JTTD181G", 1000); // order-level source
  const itemB = await insertPickingItem(orderId, "P413", 500); // box-level source

  await confirmReceivingArrival(client.db, roId, actorId);
  await allocateAll(client.db);

  const allocA = await allocationOf(itemA);
  assert.equal(allocA.qty, 1000);
  assert.equal(allocA.inventoryLotId, null);
  assert.equal(allocA.receivingInvoiceItemId, null);
  assert.equal(allocA.receivingOrderId, roId);
  const allocB = await allocationOf(itemB);
  assert.equal(allocB.qty, 500);
  assert.equal(allocB.receivingInvoiceItemId, p413ItemId);
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
  assert.equal(pkgA.dateCode, "2610"); // batch snapshot from the consumed line
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
  assert.equal(pkgB!.sourceId, p413ItemId);
  assert.equal(pkgB!.dateCode, "2612");
  const riiB = await queryGet<{ pickedQty: number }>(
    client.db,
    sql`SELECT picked_qty AS "pickedQty" FROM receiving_invoice_items WHERE id = ${p413ItemId}`
  );
  assert.equal(riiB!.pickedQty, 200);
  const boxTxn = await queryGet<{ boxId: string | null; riiId: string | null }>(
    client.db,
    sql`SELECT box_id AS "boxId", receiving_invoice_item_id AS "riiId"
        FROM inventory_transactions WHERE txn_type = 'PICK' AND reference_id = ${itemB} AND qty_type = 'on_hand'`
  );
  assert.equal(boxTxn!.boxId, "BOX-DAI-1");
  assert.equal(boxTxn!.riiId, p413ItemId);

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
      entries: [{ pickingOrderId: orderId, reason: "insufficient_stock", qty: 3000 }], // = totalQty
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
