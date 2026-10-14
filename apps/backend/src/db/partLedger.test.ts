import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import { confirmReceivingArrival } from "./receiving.js";
import { insertReceivingOrder } from "./test-fixtures.js";
import { recordPutAwayScan } from "./putaway.js";
import { getPartLedger } from "./partLedger.js";

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

test("getPartLedger: stock + totals + in/out movements with receiving refs", async () => {
  await reseed(client);
  // Unique part no so the demo world's rows can never pollute the result.
  const actorId = await actorIdOf("operator");
  await insertReceivingOrder(client.db, "04958300", {
    order: { supplierCode: "DAITO", deliveryDate: "2026-07-29", dateCode: "2610" },
    invoices: [
      {
        invoiceNo: "INV-04958300-01",
        wclCompanyName: "WCL Components Ltd",
        totalQty: 5000,
        totalCtn: 1,
        items: [
          { partNo: "LEDGER-TEST-PART", poNo: "PO-DAI-301", poLine: "1", lineQty: 5000, dateCode: "2610", coo: "JP", cow: "JP", orgId: 2, subInventoryCode: "STORE1" },
        ],
      },
    ],
  });
  const orderId = await orderIdOf("04958300");
  await confirmReceivingArrival(client.db, orderId, actorId);
  const itemId = await itemIdOf(orderId, "LEDGER-TEST-PART");
  await recordPutAwayScan(client.db, orderId, { actorId, receivingInvoiceItemId: itemId, qty: 5000, shelfCode: "A0101" });

  const res = await getPartLedger(client.db, "LEDGER-TEST-PART", "");
  assert.equal(res.part, null); // no parts-master row for the ad-hoc part
  assert.equal(res.stock.length, 1);
  assert.equal(res.stock[0]!.shelfCode, "A0101");
  assert.equal(res.totals.totalQty, 5000);
  assert.equal(res.totals.allocatedQty, 0);
  assert.equal(res.totals.availableQty, 5000);

  // Movements: RECEIVE_TO_DOCK (+dock) then the PUT_AWAY pair (dock - / on_hand +).
  assert.equal(res.transactions.length, 3);
  const kinds = res.transactions.map((m) => `${m.txnType}/${m.qtyType}/${m.qtyDelta}`);
  assert.deepEqual(
    [...kinds].sort(),
    ["PUT_AWAY/dock/-5000", "PUT_AWAY/on_hand/5000", "RECEIVE_TO_DOCK/dock/5000"]
  );
  // Every row resolves the receiving order — the PUT_AWAY pair only carries
  // receiving_invoice_item_id, so it resolves through the invoice item.
  for (const m of res.transactions) {
    assert.equal(m.receivingOrderId, orderId);
    assert.equal(m.receivingBatchNo, "04958300");
    assert.equal(m.actorName, "Demo Operator");
    assert.equal(m.dateCode, "2610");
    assert.equal(m.coo, "JP");
    assert.equal(m.cow, "JP");
    assert.equal(m.pickingOrderId, null);
  }
  // Newest first.
  const ats = res.transactions.map((m) => new Date(m.txnAt).getTime());
  assert.ok(ats.every((v, i) => i === 0 || ats[i - 1]! >= v));

  const blank = await catchHttp(getPartLedger(client.db, "", ""));
  assert.equal(blank.status, 400);
  assert.equal(blank.message, "part_no_required");
});

test("getPartLedger: parts-master info + stock resolved by wcl item no alone", async () => {
  await reseed(client);
  const res = await getPartLedger(client.db, "", "RK73B1JTTD181G");
  assert.equal(res.part?.partNo, "RK73B1JTTD181G");
  assert.equal(res.part?.wclItemNo, "RK73B1JTTD181G");
  assert.equal(res.part?.brand, "KOA");
  assert.ok(res.stock.length > 0);
  assert.ok(res.stock.every((s) => s.wclItemNo === "RK73B1JTTD181G"));
  assert.equal(res.totals.totalQty, res.stock.reduce((sum, s) => sum + s.totalQty, 0));
});
