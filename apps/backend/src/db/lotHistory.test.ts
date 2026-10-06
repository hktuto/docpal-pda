import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import { confirmReceivingArrival } from "./receiving.js";
import { insertReceivingOrder } from "./test-fixtures.js";
import { recordPutAwayScan } from "./putaway.js";
import { listLotHistory } from "./lotHistory.js";
import { listReceivingOrderLogs, type OrderLogsPage } from "./receiving.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

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

/** Receive + put away one DAITO line onto shelf A0101 — enough ledger history
 *  (RECEIVE_TO_DOCK + PUT_AWAY pair) to exercise listLotHistory. */
async function receivedAndPutAwayWorld(): Promise<{ orderId: string; actorId: string; itemId: string; lotId: string }> {
  const actorId = await actorIdOf("operator");
  await insertReceivingOrder(client.db, "04958210", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-07-29", dateCode: "2610" },
    invoices: [
      {
        invoiceNo: "INV-04958210-01",
        wclCompanyName: "WCL Components Ltd",
        totalQty: 5000,
        totalCtn: 1,
        items: [
          { partNo: "RK73B1JTTD181G", poNo: "PO-DAI-301", poLine: "1", lineQty: 5000, dateCode: "2610", coo: "JP", cow: "JP", orgId: 2, subInventoryCode: "STORE1" },
        ],
      },
    ],
  });
  const orderId = await orderIdOf("04958210");
  await confirmReceivingArrival(client.db, orderId, actorId);
  const itemId = await itemIdOf(orderId, "RK73B1JTTD181G");
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 5000, shelfCode: "A0101" });
  const lot = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM inventory_lots WHERE part_no = 'RK73B1JTTD181G' AND shelf_code = 'A0101'`
  );
  return { orderId, actorId, itemId, lotId: lot!.id };
}

test("listLotHistory: lot identity, origin source, and ledger movements with actor + references", async () => {
  await reseed(client);
  const { orderId, actorId, itemId, lotId } = await receivedAndPutAwayWorld();

  const history = await listLotHistory(client.db, lotId);
  assert.equal(history.lot.id, lotId);
  assert.equal(history.lot.partNo, "RK73B1JTTD181G");
  assert.equal(history.lot.shelfCode, "A0101");
  assert.match(history.lot.boxId ?? "", /^BOX-H-/);
  assert.equal(history.lot.totalQty, 5000);

  assert.equal(history.sources.length, 1);
  assert.equal(history.sources[0]!.receivingOrderId, orderId);
  assert.equal(history.sources[0]!.batchNo, "04958210");
  assert.equal(history.sources[0]!.qty, 5000);

  // confirm-arrival's RECEIVE_TO_DOCK row has no lot yet (dock stock is
  // ledger-based) — history starts at the PUT_AWAY pair. The pair shares one
  // txn_at timestamp, so the tie order is not guaranteed — match by qtyType.
  const types = history.movements.map((m) => `${m.txnType}/${m.qtyType}`);
  assert.deepEqual([...types].sort(), ["PUT_AWAY/dock", "PUT_AWAY/on_hand"]);
  const byQtyType = new Map(history.movements.map((m) => [m.qtyType, m]));
  const dock = byQtyType.get("dock")!;
  const onHand = byQtyType.get("on_hand")!;
  for (const m of [dock, onHand]) {
    assert.equal(m.actorId, actorId);
    assert.equal(m.actorName, "Demo Operator");
    assert.equal(m.shelfCode, "A0101");
    assert.equal(m.receivingInvoiceItemId, itemId);
    assert.equal(m.txnReason, "put away");
  }
  assert.equal(dock.qtyDelta, -5000);
  assert.equal(onHand.qtyDelta, 5000);
  assert.equal(onHand.referenceType, "shelf_box");
  assert.equal(onHand.referenceId, history.lot.boxId);

  const missing = await catchHttp(listLotHistory(client.db, randomUUID()));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, "lot_not_found");
});

test("listReceivingOrderLogs paged response embeds the order's putAway rows", async () => {
  await reseed(client);
  const { actorId, lotId } = await receivedAndPutAwayWorld();
  const orderId = await orderIdOf("04958210");

  const res = await listReceivingOrderLogs(client.db, orderId, { page: 1, pageSize: 50 });
  assert.ok(!Array.isArray(res));
  const page = res as OrderLogsPage;
  assert.equal(page.putAway?.length, 1);
  const row = page.putAway![0]!;
  assert.equal(row.partNo, "RK73B1JTTD181G");
  assert.equal(row.qty, 5000);
  assert.equal(row.shelfCode, "A0101");
  assert.match(row.boxId ?? "", /^BOX-H-/);
  assert.equal(row.lotId, lotId);
  assert.equal(row.actorId, actorId);
  assert.equal(row.actorName, "Demo Operator");
});
