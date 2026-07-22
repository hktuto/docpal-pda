import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import { allocateAll } from "./allocate.js";
import { confirmReceivingArrival } from "./receiving.js";
import { cancelShippingBox, createShippingBox } from "./picking.js";
import { cancelShelfBox, createShelfBox, recordPutAwayScan } from "./putaway.js";
import { boxIdPrefix, searchBoxes } from "./boxes.js";

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

async function receivingItemIdOf(receivingOrderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${receivingOrderId} AND rii.part_no = ${partNo}`
  );
  return row!.id;
}

// --- shipping box ids ---------------------------------------------------------

test("shipping box ids: BOX-S-<date>-<seq>, per-day seq, cancelled seq not reused", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const orderId = await pickingOrderIdOf("SO-2026-0001");

  const box1 = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  assert.match(box1.id, /^BOX-S-\d{8}-0001$/);
  assert.ok(box1.id.startsWith(boxIdPrefix("S")));

  const box2 = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  assert.match(box2.id, /^BOX-S-\d{8}-0002$/);

  // cancel (hard delete) must not free the seq — transaction_logs remembers it
  await cancelShippingBox(client.db, { shippingBoxId: box2.id, actorId });
  const box3 = await createShippingBox(client.db, { pickingOrderId: orderId, actorId });
  assert.match(box3.id, /^BOX-S-\d{8}-0003$/);
});

// --- shelf box ids ------------------------------------------------------------

test("shelf box ids: BOX-H-<date>-<seq>; staging and manual boxes share the daily seq", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  const orderId = await receivingOrderIdOf("04958210");
  await confirmReceivingArrival(client.db, orderId, actorId);

  // first put-away scan auto-creates the staging box → daily seq 0001
  const itemId = await receivingItemIdOf(orderId, "RK73B1JTTD181G");
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 100 });
  const staging = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT sbi.shelf_box_id AS id FROM shelf_box_items sbi
        JOIN shelf_boxes sb ON sb.id = sbi.shelf_box_id
        WHERE sb.shelf_code IS NULL AND sbi.receiving_invoice_item_id = ${itemId}`
  );
  assert.match(staging!.id, /^BOX-H-\d{8}-0001$/);

  const box = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  assert.match(box.id, /^BOX-H-\d{8}-0002$/);

  await cancelShelfBox(client.db, { shelfBoxId: box.id, actorId });
  const box2 = await createShelfBox(client.db, { receivingOrderId: orderId, shelfCode: "A-01-03", actorId });
  assert.match(box2.id, /^BOX-H-\d{8}-0003$/);
});

// --- search -------------------------------------------------------------------

test("searchBoxes: finds both kinds by full id and seq substring, with kind + orderNo", async () => {
  await reseed(client);
  const actorId = await actorIdOf();
  await allocateAll(client.db);
  const pickingOrderId = await pickingOrderIdOf("SO-2026-0001");
  const receivingOrderId = await receivingOrderIdOf("04958210");

  const shipping = await createShippingBox(client.db, { pickingOrderId, actorId });
  const shelf = await createShelfBox(client.db, { receivingOrderId, shelfCode: "A-01-03", actorId });

  // blank query → the latest boxes across both tables
  const all = await searchBoxes(client.db, "");
  assert.equal(all.length, 2);

  const byFullId = await searchBoxes(client.db, shipping.id);
  assert.deepEqual(
    byFullId.map((r) => ({ kind: r.kind, id: r.id, orderNo: r.orderNo })),
    [{ kind: "shipping", id: shipping.id, orderNo: "SO-2026-0001" }]
  );

  // bare seq substring matches either kind's daily seq; shelf boxes have no order
  const bySeq = await searchBoxes(client.db, "0001");
  const byId = new Map(bySeq.map((r) => [r.id, r]));
  assert.equal(byId.get(shipping.id)?.kind, "shipping");
  assert.equal(byId.get(shelf.id)?.kind, "shelf");
  assert.equal(byId.get(shelf.id)?.orderNo, null);
});
