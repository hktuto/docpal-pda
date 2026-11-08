// internalTransfer read queries — fixtures insert into the real
// internal_transfer_orders/items tables (created by migration 0017; upstream
// sync fills them on deployed instances). The tables are not in the seed
// ALL_TABLES wipe, so the fixtures are cleared per test.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "./test-helper.js";
import { listInternalTransferOrders, getInternalTransferOrder } from "./internalTransfer.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

beforeEach(async () => {
  await client.db.execute(sql`DELETE FROM internal_transfer_items`);
  await client.db.execute(sql`DELETE FROM internal_transfer_orders`);
});

async function insertOrder(
  orderNo: string,
  status = "pending",
  customerName: string | null = null
): Promise<string> {
  const id = randomUUID();
  await client.db.execute(
    sql`INSERT INTO internal_transfer_orders (id, order_no, status, customer_name)
        VALUES (${id}, ${orderNo}, ${status}, ${customerName})`
  );
  return id;
}

async function insertItem(
  transferOrderId: string,
  partNo: string,
  qty: number,
  pickedQty = 0,
  allocatedQty = 0
): Promise<string> {
  const id = randomUUID();
  await client.db.execute(
    sql`INSERT INTO internal_transfer_items (id, transfer_order_id, part_no, qty, picked_qty, allocated_qty)
        VALUES (${id}, ${transferOrderId}, ${partNo}, ${qty}, ${pickedQty}, ${allocatedQty})`
  );
  return id;
}

type ListRow = {
  id: string;
  orderNo: string;
  status: string;
  itemCount: number;
  totalQty: number;
  pickedQty: number;
  allocatedQty: number;
};

test("list returns per-order item aggregates, newest first", async () => {
  const old = await insertOrder("ITO-OLD");
  await insertItem(old, "PART-A", 10, 4, 6);
  await insertItem(old, "PART-B", 5);
  const fresh = await insertOrder("ITO-NEW", "allocated");
  await insertItem(fresh, "PART-C", 100, 0, 40);

  const page = await listInternalTransferOrders(client.db);
  const rows = page.rows as ListRow[];
  assert.equal(page.total, 2);
  assert.deepEqual(rows.map((r) => r.orderNo), ["ITO-NEW", "ITO-OLD"]);
  assert.deepEqual(
    { itemCount: rows[0].itemCount, totalQty: rows[0].totalQty, allocatedQty: rows[0].allocatedQty },
    { itemCount: 1, totalQty: 100, allocatedQty: 40 }
  );
  assert.deepEqual(
    { itemCount: rows[1].itemCount, totalQty: rows[1].totalQty, pickedQty: rows[1].pickedQty },
    { itemCount: 2, totalQty: 15, pickedQty: 4 }
  );
});

test("status filter and order-no/customer search", async () => {
  const a = await insertOrder("ITO-100", "pending", "创能电子(深圳)有限公司");
  await insertOrder("ITO-200", "allocated");
  await insertItem(a, "PART-A", 1);

  const allocated = (await listInternalTransferOrders(client.db, { status: "allocated" })).rows as ListRow[];
  assert.deepEqual(allocated.map((r) => r.orderNo), ["ITO-200"]);
  const byNo = (await listInternalTransferOrders(client.db, { search: "ito-10" })).rows as ListRow[];
  assert.deepEqual(byNo.map((r) => r.orderNo), ["ITO-100"]); // ILIKE, case-insensitive
  const byCustomer = (await listInternalTransferOrders(client.db, { search: "创能" })).rows as ListRow[];
  assert.deepEqual(byCustomer.map((r) => r.orderNo), ["ITO-100"]);
});

test("server paging: page size caps the rows, total counts the whole set", async () => {
  await insertOrder("ITO-P1");
  await insertOrder("ITO-P2");
  await insertOrder("ITO-P3");

  const p1 = await listInternalTransferOrders(client.db, { page: 1, pageSize: 2 });
  assert.equal(p1.rows.length, 2);
  assert.equal(p1.total, 3);
  const p2 = await listInternalTransferOrders(client.db, { page: 2, pageSize: 2 });
  assert.equal(p2.rows.length, 1);
  assert.equal(p2.total, 3);
  assert.equal(((p2.rows as ListRow[])[0]).orderNo, "ITO-P1"); // oldest on the last page
});

test("detail returns the order with its items ordered by line; unknown id → null", async () => {
  const id = await insertOrder("ITO-300");
  await insertItem(id, "PART-B", 2);
  await insertItem(id, "PART-A", 3);

  const detail = await getInternalTransferOrder(client.db, id);
  assert.ok(detail);
  assert.equal(detail.order.orderNo, "ITO-300");
  const items = detail.items as { partNo: string }[];
  assert.deepEqual(items.map((i) => i.partNo), ["PART-A", "PART-B"]);

  assert.equal(await getInternalTransferOrder(client.db, randomUUID()), null);
});
