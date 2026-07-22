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

const supplierIdOf = (code: string) => idOf("suppliers", sql`code = ${code}`);

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
  const koaId = await supplierIdOf("KOA");

  const res = await upsertReceivingOrder(client.db, "RO-INGEST-1", receivingBody());
  assert.equal(res.created, true);
  assert.equal(res.changed, true);
  assert.equal(res.orderStatus, "pending");

  const order = (await queryGet<{
    id: string;
    batchNo: string;
    status: string;
    supplierId: string;
    dateCode: string;
    orgId: number;
  }>(
    client.db,
    sql`SELECT id, batch_no AS "batchNo", status, supplier_id AS "supplierId", date_code AS "dateCode",
               org_id AS "orgId"
        FROM receiving_orders WHERE batch_no = 'RO-INGEST-1'`
  ))!;
  assert.equal(order.id, res.id);
  assert.equal(order.batchNo, "RO-INGEST-1");
  assert.equal(order.status, "pending");
  assert.equal(order.supplierId, koaId);
  assert.equal(order.dateCode, "2610");
  assert.equal(order.orgId, 2); // schema default

  const invoices = await queryAll<{ id: string; invoiceNo: string; supplierId: string; totalQty: number; orgId: number }>(
    client.db,
    sql`SELECT id, invoice_no AS "invoiceNo", supplier_id AS "supplierId", total_qty AS "totalQty", org_id AS "orgId"
        FROM receiving_invoices WHERE receiving_order_id = ${res.id}`
  );
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].invoiceNo, "INV-ING-1");
  assert.equal(invoices[0].supplierId, koaId); // falls back to the order supplier
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
      { invoiceNo: "INV-ING-2", items: [{ partNo: "P413", lineQty: 25 }] },
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
    invoices: [{ invoiceNo: "INV-ING-2", items: [{ partNo: "P413", lineQty: 25 }] }],
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
    { partNo: "P413", poNo: "PO-ING-1", poLine: "3", lineQty: 10 }, // new
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
  assert.equal(items[1].partNo, "P413");
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

function pickingBody(qty1 = 500): IngestPickingBody {
  return {
    order: {
      poNo: "CUST-PO-ING",
      shipTo: "ACME Electronics (HK)",
      customerCode: "ACME",
      deliveryDate: "2026-07-25",
    },
    items: [
      { partNo: "RK73H1JTTD2202F", qty: qty1 },
      { partNo: "P413", qty: 10 },
    ],
  };
}

test("picking: create → re-PUT unchanged → reconcile (qty change, add, remove)", async () => {
  await reseed(client);
  const created = await upsertPickingOrder(client.db, "PO-INGEST-1", pickingBody());
  assert.equal(created.created, true);
  assert.equal(created.changed, true);
  assert.equal(created.orderStatus, "pending");

  const order = (await queryGet<{ status: string; customerCode: string; orderNo: string }>(
    client.db,
    sql`SELECT status, customer_code AS "customerCode", order_no AS "orderNo"
        FROM picking_orders WHERE order_no = 'PO-INGEST-1'`
  ))!;
  assert.equal(order.status, "pending");
  assert.equal(order.customerCode, "ACME");
  assert.equal(order.orderNo, "PO-INGEST-1");

  const same = await upsertPickingOrder(client.db, "PO-INGEST-1", pickingBody());
  assert.equal(same.created, false);
  assert.equal(same.changed, false);

  // reconcile: change qty of the P413 line, drop nothing yet → changed
  const qtyChanged = pickingBody();
  qtyChanged.items[1].qty = 12;
  const res1 = await upsertPickingOrder(client.db, "PO-INGEST-1", qtyChanged);
  assert.equal(res1.changed, true);

  // reconcile: remove the P413 line, add a new RK73H1JTTD1002F line
  const shuffled = pickingBody();
  shuffled.items = [
    { partNo: "RK73H1JTTD2202F", qty: 500 },
    { partNo: "RK73H1JTTD1002F", qty: 200 },
  ];
  const res2 = await upsertPickingOrder(client.db, "PO-INGEST-1", shuffled);
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
  const err = await catchHttp(upsertPickingOrder(client.db, "PO-INGEST-1", body));
  assert.equal(err.status, 400);
  assert.match(err.message, /^unknown_customer: NOPE$/);
});

test("picking: upserted pending order allocates from seeded lots via allocateAll", async () => {
  await reseed(client);
  const created = await upsertPickingOrder(client.db, "PO-INGEST-ALLOC", {
    order: {
      customerCode: "ACME",
    },
    items: [{ partNo: "RK73H1JTTD2202F", qty: 500 }],
  });

  await allocateAll(client.db);

  const item = (await queryGet<{ id: string; allocatedQty: number }>(
    client.db,
    sql`SELECT id, allocated_qty AS "allocatedQty" FROM picking_items WHERE picking_order_id = ${created.id}`
  ))!;
  assert.equal(item.allocatedQty, 500);
  const lotId = await idOf("inventory_lots", sql`part_no = 'RK73H1JTTD2202F' AND shelf_code = 'A-01-02'`);
  const allocs = await queryAll<{ qty: number; inventoryLotId: string | null }>(
    client.db,
    sql`SELECT qty, inventory_lot_id AS "inventoryLotId" FROM allocations WHERE picking_item_id = ${item.id}`
  );
  assert.equal(allocs.length, 1);
  assert.equal(allocs[0].qty, 500);
  assert.equal(allocs[0].inventoryLotId, lotId);
});
