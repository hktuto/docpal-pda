import { test, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryAll, queryGet } from "./query.js";
import { allocateAll } from "./allocate.js";
import { confirmReceivingArrival } from "./receiving.js";
import {
  upsertReceivingOrder,
  upsertPickingOrder,
  deleteReceivingOrder,
  deletePickingOrder,
  type IngestReceivingBody,
  type IngestPickingBody,
} from "./ingest.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

// --- business-key lookups (never hardcode seed UUIDs) ------------------------

async function idOf(table: string, where: ReturnType<typeof sql>): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM ${sql.raw(table)} WHERE ${where}`);
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

function receivingBody(qty2 = 50): IngestReceivingBody {
  return {
    order: {
      supplierCode: "KOA",
      deliveryDate: "2026-07-20",
      dateCode: "2610",
      subInventoryCode: "STORE1",
    },
    invoices: [
      {
        invoiceNo: "INV-ING-1",
        wclCompanyName: "WCL Components Ltd",
        totalQty: 100 + qty2,
        totalCtn: 2,
        items: [
          {
            partNo: "RK73H1JTTD1002F",
            poNo: "PO-ING-1",
            poLine: "1",
            lineQty: 100,
            dateCode: "2610",
            lotCode: "L-ING-A",
            coo: "JP",
            cow: "JP",
          },
          { partNo: "RK73H1JTTD2202F", poNo: "PO-ING-1", poLine: "2", lineQty: qty2 },
        ],
      },
    ],
  };
}

// --- receiving upsert ---------------------------------------------------------

test("receiving: create → created/changed, order + invoices + items written with schema defaults", async () => {
  await reseed(client);

  const res = await upsertReceivingOrder(client.db, "RO-INGEST-1", receivingBody());
  assert.equal(res.created, true);
  assert.equal(res.changed, true);
  assert.equal(res.orderStatus, "pending");

  const order = (await queryGet<{
    id: string;
    batchNo: string;
    status: string;
    supplierCode: string;
    dateCode: string;
    orgId: number;
    subInventoryCode: string;
  }>(
    client.db,
    sql`SELECT id, batch_no AS "batchNo", status, supplier_code AS "supplierCode", date_code AS "dateCode",
               org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
        FROM receiving_orders WHERE batch_no = 'RO-INGEST-1'`
  ))!;
  assert.equal(order.id, res.id);
  assert.equal(order.batchNo, "RO-INGEST-1");
  assert.equal(order.status, "pending");
  assert.equal(order.supplierCode, "KOA");
  assert.equal(order.dateCode, "2610");
  assert.equal(order.orgId, 2); // schema default
  assert.equal(order.subInventoryCode, "STORE1");

  const invoices = await queryAll<{ id: string; invoiceNo: string; supplierCode: string; totalQty: number; orgId: number }>(
    client.db,
    sql`SELECT id, invoice_no AS "invoiceNo", supplier_code AS "supplierCode", total_qty AS "totalQty", org_id AS "orgId"
        FROM receiving_invoices WHERE receiving_order_id = ${res.id}`
  );
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].invoiceNo, "INV-ING-1");
  assert.equal(invoices[0].supplierCode, "KOA"); // falls back to the order supplier
  assert.equal(invoices[0].orgId, 2); // schema default

  const items = await queryAll<{ partNo: string; poLine: string; lineQty: number; receivedQty: number; orgId: number }>(
    client.db,
    sql`SELECT part_no AS "partNo", po_line AS "poLine", line_qty AS "lineQty",
               received_qty AS "receivedQty", org_id AS "orgId"
        FROM receiving_invoice_items WHERE receiving_invoice_id = ${invoices[0].id} ORDER BY po_line`
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].partNo, "RK73H1JTTD1002F");
  assert.equal(items[0].lineQty, 100);
  assert.equal(items[0].receivedQty, 0);
  assert.equal(items[0].orgId, 2); // schema default
  assert.equal(items[1].lineQty, 50);
});

test("receiving: identical re-PUT → created:false changed:false", async () => {
  await reseed(client);
  await upsertReceivingOrder(client.db, "RO-INGEST-1", receivingBody());
  const res = await upsertReceivingOrder(client.db, "RO-INGEST-1", receivingBody());
  assert.equal(res.created, false);
  assert.equal(res.changed, false);
});

test("receiving: changed lineQty → changed:true and the line is updated", async () => {
  await reseed(client);
  await upsertReceivingOrder(client.db, "RO-INGEST-1", receivingBody(50));
  const res = await upsertReceivingOrder(client.db, "RO-INGEST-1", receivingBody(60));
  assert.equal(res.created, false);
  assert.equal(res.changed, true);
  const item = (await queryGet<{ lineQty: number }>(
    client.db,
    sql`SELECT rii.line_qty AS "lineQty" FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${res.id} AND rii.po_line = '2'`
  ))!;
  assert.equal(item.lineQty, 60);
});

test("receiving: invoice reconcile — add missing, delete removed (cascade items)", async () => {
  await reseed(client);
  await upsertReceivingOrder(client.db, "RO-INGEST-1", receivingBody());

  // add a second invoice
  const withSecond: IngestReceivingBody = {
    ...receivingBody(),
    invoices: [
      ...receivingBody().invoices,
      { invoiceNo: "INV-ING-2", items: [{ partNo: "RK73H1JTTD4702F", lineQty: 25 }] },
    ],
  };
  const added = await upsertReceivingOrder(client.db, "RO-INGEST-1", withSecond);
  assert.equal(added.changed, true);
  const invNos = await queryAll<{ invoiceNo: string }>(
    client.db,
    sql`SELECT invoice_no AS "invoiceNo" FROM receiving_invoices WHERE receiving_order_id = ${added.id} ORDER BY invoice_no`
  );
  assert.deepEqual(
    invNos.map((i) => i.invoiceNo),
    ["INV-ING-1", "INV-ING-2"]
  );

  // drop the first invoice again → it and its items are gone
  const onlySecond: IngestReceivingBody = {
    ...receivingBody(),
    invoices: [{ invoiceNo: "INV-ING-2", items: [{ partNo: "RK73H1JTTD4702F", lineQty: 25 }] }],
  };
  const removed = await upsertReceivingOrder(client.db, "RO-INGEST-1", onlySecond);
  assert.equal(removed.changed, true);
  const remaining = await queryAll<{ invoiceNo: string; itemCount: number }>(
    client.db,
    sql`SELECT ri.invoice_no AS "invoiceNo", COUNT(rii.id)::int AS "itemCount"
        FROM receiving_invoices ri
        LEFT JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
        WHERE ri.receiving_order_id = ${removed.id}
        GROUP BY ri.id`
  );
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].invoiceNo, "INV-ING-2");
  assert.equal(remaining[0].itemCount, 1);
});

test("receiving: item reconcile — add/remove lines by business key, keep untouched line ids", async () => {
  await reseed(client);
  const created = await upsertReceivingOrder(client.db, "RO-INGEST-1", receivingBody());
  const line2Before = (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${created.id} AND rii.po_line = '2'`
  ))!;

  const body = receivingBody();
  body.invoices[0].items = [
    { partNo: "RK73H1JTTD2202F", poNo: "PO-ING-1", poLine: "2", lineQty: 50 }, // unchanged
    { partNo: "RK73H1JTTD4702F", poNo: "PO-ING-1", poLine: "3", lineQty: 10 }, // new
  ]; // po_line '1' removed
  const res = await upsertReceivingOrder(client.db, "RO-INGEST-1", body);
  assert.equal(res.changed, true);

  const items = await queryAll<{ id: string; poLine: string; partNo: string }>(
    client.db,
    sql`SELECT rii.id, rii.po_line AS "poLine", rii.part_no AS "partNo"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${res.id} ORDER BY rii.po_line`
  );
  assert.deepEqual(
    items.map((i) => i.poLine),
    ["2", "3"]
  );
  assert.equal(items[0].id, line2Before.id); // same row, not re-inserted
  assert.equal(items[1].partNo, "RK73H1JTTD4702F");
});

test("receiving: missing order.subInventoryCode → 400", async () => {
  await reseed(client);
  const body = receivingBody();
  body.order.subInventoryCode = undefined as unknown as string;
  const err = await catchHttp(upsertReceivingOrder(client.db, "RO-INGEST-1", body));
  assert.equal(err.status, 400);
  assert.equal(err.message, "order.subInventoryCode is required");
});

test("receiving: changed subInventoryCode (order/invoice/item) → changed:true and updated", async () => {
  await reseed(client);
  await upsertReceivingOrder(client.db, "RO-INGEST-1", receivingBody());
  const body = receivingBody();
  body.order.subInventoryCode = "WSTORE1";
  body.invoices[0].subInventoryCode = "WSTORE1";
  body.invoices[0].items[0].subInventoryCode = "WSTORE1";
  const res = await upsertReceivingOrder(client.db, "RO-INGEST-1", body);
  assert.equal(res.created, false);
  assert.equal(res.changed, true);

  const order = (await queryGet<{ subInventoryCode: string }>(
    client.db,
    sql`SELECT sub_inventory_code AS "subInventoryCode" FROM receiving_orders WHERE id = ${res.id}`
  ))!;
  assert.equal(order.subInventoryCode, "WSTORE1");
  const inv = (await queryGet<{ subInventoryCode: string }>(
    client.db,
    sql`SELECT sub_inventory_code AS "subInventoryCode" FROM receiving_invoices WHERE receiving_order_id = ${res.id}`
  ))!;
  assert.equal(inv.subInventoryCode, "WSTORE1");
  const item = (await queryGet<{ subInventoryCode: string | null }>(
    client.db,
    sql`SELECT rii.sub_inventory_code AS "subInventoryCode" FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${res.id} AND rii.po_line = '1'`
  ))!;
  assert.equal(item.subInventoryCode, "WSTORE1");

  // re-PUT of the same body is a no-op again
  const same = await upsertReceivingOrder(client.db, "RO-INGEST-1", body);
  assert.equal(same.changed, false);
});

test("receiving: unknown part / supplier → 400 with the code in the message", async () => {
  await reseed(client);
  const badPart = receivingBody();
  badPart.invoices[0].items[0].partNo = "NOPE-123";
  const partErr = await catchHttp(upsertReceivingOrder(client.db, "RO-INGEST-1", badPart));
  assert.equal(partErr.status, 400);
  assert.match(partErr.message, /^unknown_part: NOPE-123$/);

  const badSupplier = receivingBody();
  badSupplier.order.supplierCode = "NOPE";
  const supErr = await catchHttp(upsertReceivingOrder(client.db, "RO-INGEST-1", badSupplier));
  assert.equal(supErr.status, 400);
  assert.match(supErr.message, /^unknown_supplier: NOPE$/);
});

test("receiving: re-PUT on an in_hand order updates expected fields but never derived state", async () => {
  await reseed(client);
  const created = await upsertReceivingOrder(client.db, "RO-INGEST-1", receivingBody());
  const actor = await idOf("users", sql`username = 'operator'`);
  await confirmReceivingArrival(client.db, created.id, actor); // received_qty = line_qty, status in_hand

  const body = receivingBody();
  body.invoices[0].items[0].lotCode = "L-ING-B"; // batch-attr change, same qtys
  const res = await upsertReceivingOrder(client.db, "RO-INGEST-1", body);
  assert.equal(res.changed, true);
  assert.equal(res.orderStatus, "in_hand");

  const item = (await queryGet<{ lineQty: number; receivedQty: number; lotCode: string }>(
    client.db,
    sql`SELECT rii.line_qty AS "lineQty", rii.received_qty AS "receivedQty", rii.lot_code AS "lotCode"
        FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${res.id} AND rii.po_line = '1'`
  ))!;
  assert.equal(item.lineQty, 100);
  assert.equal(item.receivedQty, 100); // derived state untouched
  assert.equal(item.lotCode, "L-ING-B");

  // qty decrease is rejected once past pending (old ingest guard)
  const decreased = receivingBody(40);
  const err = await catchHttp(upsertReceivingOrder(client.db, "RO-INGEST-1", decreased));
  assert.equal(err.status, 409);
  assert.equal(err.message, "qty_may_only_increase_once_in_hand");
});

// --- picking upsert -----------------------------------------------------------

// Caller-supplied UUID ids — the dedup keys (order_no is NOT unique).
const PO_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const PO_ALLOC = "aaaaaaaa-0000-4000-8000-000000000002";
const PO_SEQ_A = "aaaaaaaa-0000-4000-8000-000000000003";
const PO_SEQ_B = "aaaaaaaa-0000-4000-8000-000000000004";
const PO_SEQ_D = "aaaaaaaa-0000-4000-8000-000000000005";
const PO_SEQ_Z = "aaaaaaaa-0000-4000-8000-000000000006";
const PO_DEL = "aaaaaaaa-0000-4000-8000-000000000007";
const PO_DUP = "aaaaaaaa-0000-4000-8000-000000000008";
const PO_NOPE = "aaaaaaaa-0000-4000-8000-0000000000ff";

function pickingBody(qty1 = 500, orderNo = "PO-INGEST-1"): IngestPickingBody {
  return {
    order: {
      orderNo,
      poNo: "CUST-PO-ING",
      shipTo: "ACME Electronics (HK)",
      customerCode: "ACME",
      deliveryDate: "2026-07-25",
      orgId: 2,
      subInventoryCode: "STORE1",
    },
    items: [
      { partNo: "RK73H1JTTD2202F", qty: qty1, lineId: 8001, lineNumber: 1, shipmentNumber: 1 },
      { partNo: "RK73H1JTTD4702F", qty: 10, lineId: 8002, lineNumber: 2, shipmentNumber: 1 },
    ],
  };
}

test("picking: create → re-PUT unchanged → reconcile (qty change, add, remove)", async () => {
  await reseed(client);
  const created = await upsertPickingOrder(client.db, PO_1, pickingBody());
  assert.equal(created.created, true);
  assert.equal(created.changed, true);
  assert.equal(created.orderStatus, "pending");

  const order = (await queryGet<{ status: string; customerCode: string; orderNo: string; orgId: number; subInventoryCode: string }>(
    client.db,
    sql`SELECT status, customer_code AS "customerCode", order_no AS "orderNo",
               org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
        FROM picking_orders WHERE order_no = 'PO-INGEST-1'`
  ))!;
  assert.equal(order.status, "pending");
  assert.equal(order.customerCode, "ACME");
  assert.equal(order.orderNo, "PO-INGEST-1");
  assert.equal(order.orgId, 2);
  assert.equal(order.subInventoryCode, "STORE1");

  const same = await upsertPickingOrder(client.db, PO_1, pickingBody());
  assert.equal(same.created, false);
  assert.equal(same.changed, false);

  // reconcile: change the location pair → changed, pair updated
  const pairChanged = pickingBody();
  pairChanged.order.orgId = 143;
  pairChanged.order.subInventoryCode = "store1";
  const resPair = await upsertPickingOrder(client.db, PO_1, pairChanged);
  assert.equal(resPair.changed, true);
  const order2 = (await queryGet<{ orgId: number; subInventoryCode: string }>(
    client.db,
    sql`SELECT org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
        FROM picking_orders WHERE order_no = 'PO-INGEST-1'`
  ))!;
  assert.equal(order2.orgId, 143);
  assert.equal(order2.subInventoryCode, "store1");
  await upsertPickingOrder(client.db, PO_1, pickingBody()); // restore

  // reconcile: change qty of the RK73H1JTTD4702F line, drop nothing yet → changed
  const qtyChanged = pickingBody();
  qtyChanged.items[1].qty = 12;
  const res1 = await upsertPickingOrder(client.db, PO_1, qtyChanged);
  assert.equal(res1.changed, true);

  // reconcile: remove the RK73H1JTTD4702F line, add a new RK73H1JTTD1002F line
  const shuffled = pickingBody();
  shuffled.items = [
    { partNo: "RK73H1JTTD2202F", qty: 500, lineId: 8001, lineNumber: 1, shipmentNumber: 1 },
    { partNo: "RK73H1JTTD1002F", qty: 200, lineId: 8003, lineNumber: 3, shipmentNumber: 1 },
  ];
  const res2 = await upsertPickingOrder(client.db, PO_1, shuffled);
  assert.equal(res2.changed, true);
  const items = await queryAll<{ partNo: string; qty: number; pickedQty: number; allocatedQty: number }>(
    client.db,
    sql`SELECT part_no AS "partNo", qty, picked_qty AS "pickedQty", allocated_qty AS "allocatedQty"
        FROM picking_items WHERE picking_order_id = ${res2.id} ORDER BY qty DESC`
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].partNo, "RK73H1JTTD2202F");
  assert.equal(items[0].qty, 500);
  assert.equal(items[0].pickedQty, 0);
  assert.equal(items[0].allocatedQty, 0);
  assert.equal(items[1].partNo, "RK73H1JTTD1002F");
  assert.equal(items[1].qty, 200);
});

test("picking: unknown customer → 400 unknown_customer", async () => {
  await reseed(client);
  const body = pickingBody();
  body.order.customerCode = "NOPE";
  const err = await catchHttp(upsertPickingOrder(client.db, PO_1, body));
  assert.equal(err.status, 400);
  assert.match(err.message, /^unknown_customer: NOPE$/);
});

test("picking: upserted pending order allocates from seeded lots via allocateAll", async () => {
  await reseed(client);
  // Earlier delivery date than the seeded SO-DEMO orders (2026-07-30/08-01) so
  // this order wins priority_seq 1 — otherwise they consume all seeded stock.
  const created = await upsertPickingOrder(client.db, PO_ALLOC, {
    order: {
      orderNo: "PO-INGEST-ALLOC",
      customerCode: "ACME",
      deliveryDate: "2026-07-20",
    },
    items: [{ partNo: "RK73H1JTTD2202F", qty: 500, lineId: 8010, lineNumber: 1, shipmentNumber: 1 }],
  });

  await allocateAll(client.db);

  const item = (await queryGet<{ id: string; allocatedQty: number }>(
    client.db,
    sql`SELECT id, allocated_qty AS "allocatedQty" FROM picking_items WHERE picking_order_id = ${created.id}`
  ))!;
  assert.equal(item.allocatedQty, 500);
  const lotId = await idOf("inventory_lots", sql`part_no = 'RK73H1JTTD2202F' AND shelf_code = 'A-01-01'`);
  const allocs = await queryAll<{ qty: number; inventoryLotId: string | null }>(
    client.db,
    sql`SELECT qty, inventory_lot_id AS "inventoryLotId" FROM allocations WHERE picking_item_id = ${item.id}`
  );
  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].qty, 500);
  assert.equal(allocs[0].inventoryLotId, lotId);
});

test("picking: new order slots into the queue by delivery date; re-upsert keeps its seq", async () => {
  await reseed(client);
  const seqOf = async (orderNo: string) =>
    Number((await queryGet<{ seq: number }>(client.db, sql`SELECT priority_seq AS seq FROM picking_orders WHERE order_no = ${orderNo}`))!.seq);
  const mk = (orderNo: string, deliveryDate?: string) => ({
    order: { orderNo, customerCode: "ACME", ...(deliveryDate ? { deliveryDate } : {}) },
    items: [{ partNo: "RK73H1JTTD2202F", qty: 10, lineId: 8020, lineNumber: 1, shipmentNumber: 1 }],
  });

  // two undated orders: NULLS LAST, ordered by order_no between themselves
  await upsertPickingOrder(client.db, PO_SEQ_B, mk("PO-SEQ-B"));
  await upsertPickingOrder(client.db, PO_SEQ_D, mk("PO-SEQ-D"));
  const b1 = await seqOf("PO-SEQ-B");
  const d1 = await seqOf("PO-SEQ-D");
  assert.ok(d1 > b1, `undated orders order by order_no: B(${b1}) before D(${d1})`);

  // a dated order slots ahead of ALL undated ones (NULLS LAST) — and ahead of
  // the seeded orders when its date is earlier (seed SO-DEMO-0001 is 2026-07-30)
  await upsertPickingOrder(client.db, PO_SEQ_A, mk("PO-SEQ-A", "2026-07-20"));
  const a1 = await seqOf("PO-SEQ-A");
  assert.equal(a1, 1, "earliest delivery date takes position 1");
  assert.ok(a1 < b1, `dated order A(${a1}) slots ahead of undated B(${b1})`);
  assert.equal(await seqOf("PO-SEQ-B"), b1 + 1, "existing orders shift down by one");
  assert.equal(await seqOf("PO-SEQ-D"), d1 + 1);

  // a date after the seeded orders (SO-DEMO-0002 is 2026-08-01) still slots ahead of the undated ones
  await upsertPickingOrder(client.db, PO_SEQ_Z, mk("PO-SEQ-Z", "2026-08-02"));
  const zSeq = await seqOf("PO-SEQ-Z");
  assert.ok(zSeq > a1 && zSeq < (await seqOf("PO-SEQ-B")), "Z slots after the dated orders, before undated");

  // re-upsert does not move the order
  await upsertPickingOrder(client.db, PO_SEQ_Z, { order: { orderNo: "PO-SEQ-Z", customerCode: "ACME" }, items: [{ partNo: "RK73H1JTTD2202F", qty: 20, lineId: 8020, lineNumber: 1, shipmentNumber: 1 }] });
  assert.equal(await seqOf("PO-SEQ-Z"), zSeq);
});

// --- caller-supplied ids ------------------------------------------------------

const ID_ORDER = "11111111-1111-4111-8111-111111111111";
const ID_INVOICE = "22222222-2222-4222-8222-222222222222";
const ID_ITEM_1 = "33333333-3333-4333-8333-333333333333";
const ID_ITEM_2 = "44444444-4444-4444-8444-444444444444";

test("receiving: caller-supplied ids on create are used at every level", async () => {
  await reseed(client);
  const body = receivingBody();
  body.order.id = ID_ORDER;
  body.invoices[0].id = ID_INVOICE;
  body.invoices[0].items[0].id = ID_ITEM_1;
  body.invoices[0].items[1].id = ID_ITEM_2;

  const res = await upsertReceivingOrder(client.db, "RO-INGEST-IDS", body);
  assert.equal(res.created, true);
  assert.equal(res.id, ID_ORDER);

  const invoice = (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM receiving_invoices WHERE receiving_order_id = ${ID_ORDER}`
  ))!;
  assert.equal(invoice.id, ID_INVOICE);
  const itemIds = await queryAll<{ id: string }>(
    client.db,
    sql`SELECT id FROM receiving_invoice_items WHERE receiving_invoice_id = ${ID_INVOICE} ORDER BY id`
  );
  assert.deepEqual(
    itemIds.map((i) => i.id),
    [ID_ITEM_1, ID_ITEM_2].sort()
  );
});

test("receiving: re-PUT with different supplied ids → reconcile keeps the server ids", async () => {
  await reseed(client);
  const body = receivingBody();
  body.order.id = ID_ORDER;
  body.invoices[0].id = ID_INVOICE;
  body.invoices[0].items[0].id = ID_ITEM_1;
  body.invoices[0].items[1].id = ID_ITEM_2;
  await upsertReceivingOrder(client.db, "RO-INGEST-IDS", body);

  // same natural keys, different supplied ids → ignored, no error, no change
  const again = receivingBody();
  again.order.id = "55555555-5555-4555-8555-555555555555";
  again.invoices[0].id = "66666666-6666-4666-8666-666666666666";
  again.invoices[0].items[0].id = "77777777-7777-4777-8777-777777777777";
  again.invoices[0].items[1].id = "88888888-8888-4888-8888-888888888888";
  const res = await upsertReceivingOrder(client.db, "RO-INGEST-IDS", again);
  assert.equal(res.created, false);
  assert.equal(res.changed, false);
  assert.equal(res.id, ID_ORDER);
  const invoice = (await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM receiving_invoices WHERE receiving_order_id = ${ID_ORDER}`
  ))!;
  assert.equal(invoice.id, ID_INVOICE);
});

test("receiving: malformed supplied id → 400 invalid_id", async () => {
  await reseed(client);
  const body = receivingBody();
  body.order.id = "not-a-uuid";
  const err = await catchHttp(upsertReceivingOrder(client.db, "RO-INGEST-1", body));
  assert.equal(err.status, 400);
  assert.equal(err.message, "invalid_id");

  const empty = receivingBody();
  empty.invoices[0].items[0].id = "";
  const err2 = await catchHttp(upsertReceivingOrder(client.db, "RO-INGEST-1", empty));
  assert.equal(err2.status, 400);
  assert.equal(err2.message, "invalid_id");
});

test("receiving: supplied id colliding with another row's PK → 409 id_already_exists", async () => {
  await reseed(client);
  const first = receivingBody();
  first.order.id = ID_ORDER;
  first.invoices[0].id = ID_INVOICE;
  await upsertReceivingOrder(client.db, "RO-INGEST-1", first);

  // same order id under a different natural key
  const clash = receivingBody();
  clash.order.id = ID_ORDER;
  const err = await catchHttp(upsertReceivingOrder(client.db, "RO-INGEST-2", clash));
  assert.equal(err.status, 409);
  assert.equal(err.message, "id_already_exists");

  // same invoice id under a different order
  const invClash = receivingBody();
  invClash.invoices[0].id = ID_INVOICE;
  const err2 = await catchHttp(upsertReceivingOrder(client.db, "RO-INGEST-3", invClash));
  assert.equal(err2.status, 409);
  assert.equal(err2.message, "id_already_exists");
});

test("picking: caller-supplied ids on create; reconcile ignores them", async () => {
  await reseed(client);
  // the order id is the upsert arg itself; item supplied ids ride in the body
  const body = pickingBody();
  body.items[0].id = ID_ITEM_1;
  body.items[1].id = ID_ITEM_2;

  const res = await upsertPickingOrder(client.db, ID_ORDER, body);
  assert.equal(res.created, true);
  assert.equal(res.id, ID_ORDER);
  const itemIds = await queryAll<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_items WHERE picking_order_id = ${ID_ORDER} ORDER BY id`
  );
  assert.deepEqual(
    itemIds.map((i) => i.id),
    [ID_ITEM_1, ID_ITEM_2].sort()
  );

  // re-PUT with different supplied item ids → ignored
  const again = pickingBody();
  again.items[0].id = "66666666-6666-4666-8666-666666666666";
  again.items[1].id = "77777777-7777-4777-8777-777777777777";
  const res2 = await upsertPickingOrder(client.db, ID_ORDER, again);
  assert.equal(res2.created, false);
  assert.equal(res2.changed, false);
  assert.equal(res2.id, ID_ORDER);
});

test("picking: malformed route/item id → 400 invalid_id", async () => {
  await reseed(client);
  const bad = pickingBody();
  bad.items[0].id = "xyz";
  const err = await catchHttp(upsertPickingOrder(client.db, PO_1, bad));
  assert.equal(err.status, 400);
  assert.equal(err.message, "invalid_id");

  // the route id is the dedup key — a non-UUID one is rejected up front
  const err2 = await catchHttp(upsertPickingOrder(client.db, "PO-INGEST-1", pickingBody()));
  assert.equal(err2.status, 400);
  assert.equal(err2.message, "invalid_id");
});

test("picking: re-upsert of the same id with a different orderNo renames the order", async () => {
  await reseed(client);
  await upsertPickingOrder(client.db, PO_1, pickingBody());
  const res = await upsertPickingOrder(client.db, PO_1, pickingBody(500, "PO-INGEST-1-RENAMED"));
  assert.equal(res.created, false);
  assert.equal(res.changed, true);
  assert.equal(res.id, PO_1);
  const row = (await queryGet<{ orderNo: string }>(
    client.db,
    sql`SELECT order_no AS "orderNo" FROM picking_orders WHERE id = ${PO_1}`
  ))!;
  assert.equal(row.orderNo, "PO-INGEST-1-RENAMED");
});

test("picking: same orderNo under two different ids both insert (order_no not unique)", async () => {
  await reseed(client);
  const r1 = await upsertPickingOrder(client.db, PO_1, pickingBody());
  const r2 = await upsertPickingOrder(client.db, PO_DUP, pickingBody());
  assert.equal(r1.created, true);
  assert.equal(r2.created, true);
  const rows = await queryAll<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_orders WHERE order_no = 'PO-INGEST-1'`
  );
  assert.equal(rows.length, 2);
});

// --- whole-order delete --------------------------------------------------------

test("delete receiving: unknown batchNo → 404 not_found", async () => {
  await reseed(client);
  const err = await catchHttp(deleteReceivingOrder(client.db, "RO-NOPE"));
  assert.equal(err.status, 404);
  assert.equal(err.message, "not_found");
});

test("delete receiving: pending order → order + invoices + items gone", async () => {
  await reseed(client);
  const created = await upsertReceivingOrder(client.db, "RO-INGEST-DEL", receivingBody());

  const res = await deleteReceivingOrder(client.db, "RO-INGEST-DEL");
  assert.equal(res.id, created.id);

  const order = await queryGet(client.db, sql`SELECT id FROM receiving_orders WHERE id = ${created.id}`);
  assert.equal(order, undefined);
  const invoices = await queryAll(client.db, sql`SELECT id FROM receiving_invoices WHERE receiving_order_id = ${created.id}`);
  assert.equal(invoices.length, 0);
  const items = await queryAll(
    client.db,
    sql`SELECT rii.id FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${created.id}`
  );
  assert.equal(items.length, 0);
});

test("delete receiving: past pending → 409 cannot_delete_once_<status>", async () => {
  await reseed(client);
  const created = await upsertReceivingOrder(client.db, "RO-INGEST-DEL", receivingBody());
  const actor = await idOf("users", sql`username = 'operator'`);
  await confirmReceivingArrival(client.db, created.id, actor); // status in_hand

  const err = await catchHttp(deleteReceivingOrder(client.db, "RO-INGEST-DEL"));
  assert.equal(err.status, 409);
  assert.equal(err.message, "cannot_delete_once_in_hand");
});

test("delete receiving: work started on a line → 409 cannot_delete_after_work_started", async () => {
  await reseed(client);
  const created = await upsertReceivingOrder(client.db, "RO-INGEST-DEL", receivingBody());
  const itemId = await idOf(
    "receiving_invoice_items",
    sql`receiving_invoice_id IN (SELECT id FROM receiving_invoices WHERE receiving_order_id = ${created.id})`
  );
  await client.db.execute(sql`UPDATE receiving_invoice_items SET received_qty = 1 WHERE id = ${itemId}`);

  const err = await catchHttp(deleteReceivingOrder(client.db, "RO-INGEST-DEL"));
  assert.equal(err.status, 409);
  assert.equal(err.message, "cannot_delete_after_work_started");
});

test("delete picking: unknown id → 404 not_found", async () => {
  await reseed(client);
  const err = await catchHttp(deletePickingOrder(client.db, PO_NOPE));
  assert.equal(err.status, 404);
  assert.equal(err.message, "not_found");
});

test("delete picking: pending order → order + items gone", async () => {
  await reseed(client);
  const created = await upsertPickingOrder(client.db, PO_DEL, pickingBody());

  const res = await deletePickingOrder(client.db, PO_DEL);
  assert.equal(res.id, created.id);

  const order = await queryGet(client.db, sql`SELECT id FROM picking_orders WHERE id = ${created.id}`);
  assert.equal(order, undefined);
  const items = await queryAll(client.db, sql`SELECT id FROM picking_items WHERE picking_order_id = ${created.id}`);
  assert.equal(items.length, 0);
});

test("delete picking: past pending → 409 cannot_delete_once_<status>", async () => {
  await reseed(client);
  const created = await upsertPickingOrder(client.db, PO_DEL, pickingBody());
  await client.db.execute(sql`UPDATE picking_orders SET status = 'picking' WHERE id = ${created.id}`);

  const err = await catchHttp(deletePickingOrder(client.db, PO_DEL));
  assert.equal(err.status, 409);
  assert.equal(err.message, "cannot_delete_once_picking");
});

test("delete picking: work started on a line → 409 cannot_delete_after_work_started", async () => {
  await reseed(client);
  const created = await upsertPickingOrder(client.db, PO_DEL, pickingBody());
  const itemId = await idOf("picking_items", sql`picking_order_id = ${created.id}`);
  await client.db.execute(sql`UPDATE picking_items SET picked_qty = 5 WHERE id = ${itemId}`);

  const err = await catchHttp(deletePickingOrder(client.db, PO_DEL));
  assert.equal(err.status, 409);
  assert.equal(err.message, "cannot_delete_after_work_started");
});
