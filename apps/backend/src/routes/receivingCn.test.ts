// PDA CN manual receiving (手動收貨) route (spec
// docs/superpowers/specs/2026-10-27-manual-receiving-pda-design.md): config
// gate, payload validation, and the one-tx commit — _cn order (in_hand) + ONE
// branded invoice + items (po_no → org/sub rules) + put-away task + audit
// rows. No DocPal workflow is involved, so no fake workflow server is needed.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, reseed, TEST_DATABASE_URL, type TestDb } from "../db/test-helper.js";
import { _setCnReceivingForTests, _resetFlowConfigForTests } from "../config.js";
import { queryAll, queryGet } from "../db/query.js";

process.env.DATABASE_URL = TEST_DATABASE_URL;

let client: TestDb;
let app: (typeof import("../index.js"))["app"];

before(async () => {
  client = await setupTestDb();
  ({ app } = await import("../index.js"));
  _setCnReceivingForTests(true); // the route 404s while the receiving-cn step is off
});

after(() => {
  _resetFlowConfigForTests();
});

async function login(username: string, password: string): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token as string;
}

/** The po_no prefix rules write org/sub pairs the item FK needs in org_info. */
async function seedOrgInfoPairs() {
  for (const [id, orgId, sub] of [
    ["test-orginfo-mr-1", 14, "GZSZ"],
    ["test-orginfo-mr-2", 7, "SZSZ1"],
    ["test-orginfo-mr-3", 7, "STORE1"],
  ] as const) {
    await client.db.execute(
      sql`INSERT INTO org_info (id, org_id, secondary_inventory_name) VALUES (${id}, ${orgId}, ${sub})
          ON CONFLICT ON CONSTRAINT org_info_org_subinv_unique DO NOTHING`
    );
  }
}

const VALID_BODY = {
  orders: [
    {
      orderNo: "329063176T3", // → org 14 / GZSZ
      items: [
        {
          partNo: "RK73B1JTTD181G",
          wclItemNo: "RK73B1JTTD181G",
          qty: 30000,
          dateCode: "2641",
          lotCode: "L1",
          coo: "JP",
          supplierCode: "KOA",
          brand: "KOA",
          raw: ":RAW-LABEL-1:",
        },
        { partNo: "RK73H1JTTD1002F", qty: "5000", dateCode: "2640", supplierCode: "KOA", brand: "KOA" },
      ],
    },
    {
      orderNo: "319000001T1", // → org 7 / SZSZ1
      items: [{ partNo: "UNKNOWN-PART-9", qty: 100, supplierCode: "KOA", brand: "KOA" }],
    },
  ],
};

async function postManual(token: string, body: unknown) {
  return app.request("/receiving-cn/manual-receipts", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("config gate: 404 while the receiving-cn step is off", async () => {
  await reseed(client);
  _setCnReceivingForTests(false);
  try {
    const token = await login("operator", "DocPal2026!");
    const res = await postManual(token, VALID_BODY);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /not_found/);
  } finally {
    _setCnReceivingForTests(true);
  }
});

test("validation: shape errors → 400 invalid_payload", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const cases: unknown[] = [
    {},
    { orders: [] },
    { orders: "nope" },
    { orders: [{ items: [{ partNo: "X", qty: 1 }] }] }, // missing orderNo
    { orders: [{ orderNo: "  ", items: [{ partNo: "X", qty: 1 }] }] }, // blank orderNo
    { orders: [{ orderNo: "A", items: [] }] }, // no items
    { orders: [{ orderNo: "A", items: [{ qty: 1 }] }] }, // missing partNo
    { orders: [{ orderNo: "A", items: [{ partNo: "X", qty: 0 }] }] },
    { orders: [{ orderNo: "A", items: [{ partNo: "X", qty: 1.5 }] }] },
    { orders: [{ orderNo: "A", items: [{ partNo: "X", qty: "abc" }] }] },
    { orders: [{ orderNo: "A", items: [{ partNo: "X", qty: 1, dateCode: 42 }] }] }, // non-string field
    // duplicate orderNo — space/case-insensitive
    {
      orders: [
        { orderNo: "329063176T3", items: [{ partNo: "X", qty: 1, brand: "KOA" }] },
        { orderNo: "329063176t3 ", items: [{ partNo: "Y", qty: 1, brand: "KOA" }] },
      ],
    },
  ];
  for (const body of cases) {
    const res = await postManual(token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(await res.text(), /invalid_payload/);
  }
});

test("validation: first item without a brand → 400 invalid_payload", async () => {
  await reseed(client);
  const token = await login("operator", "DocPal2026!");
  const res = await postManual(token, {
    orders: [{ orderNo: "329063176T3", items: [{ partNo: "X", qty: 1 }] }],
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /invalid_payload/);
});

test("happy path: one order + ONE branded invoice; batch_no = invoice_no; items carry po_no + derived org/sub", async () => {
  await reseed(client);
  await seedOrgInfoPairs();
  const token = await login("operator", "DocPal2026!");
  const res = await postManual(token, VALID_BODY);
  assert.equal(res.status, 201);
  const created = (await res.json()) as { id: string; batchNo: string; putAwayTaskId: string };
  assert.match(created.batchNo, /^KOA-\d{8}-01$/); // [brand]-yyyymmdd-[seq]
  assert.ok(created.putAwayTaskId);

  const order = await queryGet<{
    batchNo: string;
    status: string;
    orgId: number;
    deliveryDate: string | null;
    arrivedAt: string | null;
    arrivedByName: string;
  }>(
    client.db,
    sql`SELECT ro.batch_no AS "batchNo", ro.status, ro.org_id AS "orgId",
               ro.delivery_date AS "deliveryDate", ro.arrived_at AS "arrivedAt",
               u.display_name AS "arrivedByName"
        FROM receiving_orders_cn ro LEFT JOIN users u ON u.id = ro.arrived_by
        WHERE ro.id = ${created.id}`
  );
  assert.equal(order!.batchNo, created.batchNo);
  assert.equal(order!.status, "in_hand"); // confirm IS the receipt moment
  assert.equal(order!.orgId, 14); // first po_no (329…) → org 14
  assert.ok(order!.deliveryDate); // = the creation date
  assert.ok(order!.arrivedAt);
  assert.equal(order!.arrivedByName, "Demo Operator");

  // Exactly ONE invoice for the whole task, invoice_no = batch_no.
  const invoices = await queryAll<{ invoiceNo: string; totalQty: number | null }>(
    client.db,
    sql`SELECT invoice_no AS "invoiceNo", total_qty AS "totalQty"
        FROM receiving_invoices_cn WHERE receiving_order_id = ${created.id}`
  );
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].invoiceNo, created.batchNo);
  assert.equal(invoices[0].totalQty, 35100);

  const items = await queryAll<{
    partNo: string;
    wclItemNo: string | null;
    poNo: string | null;
    lineQty: number;
    receivedQty: number;
    dateCode: string | null;
    orgId: number;
    subInventoryCode: string | null;
    additionalData: Record<string, unknown> | null;
  }>(
    client.db,
    sql`SELECT part_no AS "partNo", wcl_item_no AS "wclItemNo", po_no AS "poNo",
               line_qty AS "lineQty", received_qty AS "receivedQty", date_code AS "dateCode",
               org_id AS "orgId", sub_inventory_code AS "subInventoryCode",
               additional_data AS "additionalData"
        FROM receiving_invoice_items_cn
        WHERE receiving_invoice_id IN (SELECT id FROM receiving_invoices_cn WHERE receiving_order_id = ${created.id})
        ORDER BY created_date, id`
  );
  assert.equal(items.length, 3);
  // The user's order numbers are the items' po_no, driving org/sub.
  assert.equal(items[0].poNo, "329063176T3");
  assert.equal(items[0].orgId, 14);
  assert.equal(items[0].subInventoryCode, "GZSZ");
  assert.equal(items[0].wclItemNo, "RK73B1JTTD181G"); // client-provided wins
  assert.equal(items[0].lineQty, 30000);
  assert.equal(items[0].receivedQty, 30000);
  assert.equal(items[0].additionalData?.source, "manual");
  assert.equal(items[0].additionalData?.raw, ":RAW-LABEL-1:");
  assert.equal(items[0].additionalData?.supplierCode, "KOA");
  assert.equal(items[1].receivedQty, 5000); // qty coerced from the string "5000"
  assert.equal(items[1].wclItemNo, "RK73H1JTTD1002F"); // server-resolved from parts
  assert.equal(items[2].poNo, "319000001T1");
  assert.equal(items[2].orgId, 7);
  assert.equal(items[2].subInventoryCode, "SZSZ1");
  assert.equal(items[2].wclItemNo, null); // unmatched part stays text-only

  // Mixed item pairs → NULL pair on the task, org fallback = the order's org.
  const task = await queryGet<{ id: string; status: string; orgId: number | null; subInventoryCode: string | null }>(
    client.db,
    sql`SELECT id, status, org_id AS "orgId", sub_inventory_code AS "subInventoryCode"
        FROM put_away_tasks_cn WHERE receiving_order_cn_id = ${created.id}`
  );
  assert.equal(task!.id, created.putAwayTaskId);
  assert.equal(task!.status, "pending");
  assert.equal(task!.orgId, 14);
  assert.equal(task!.subInventoryCode, null);

  const logs = await queryAll<{ entityType: string; toState: string; metadata: Record<string, unknown> }>(
    client.db,
    sql`SELECT entity_type AS "entityType", to_state AS "toState", metadata FROM transaction_logs
        WHERE (entity_type = 'receiving_order_cn' AND entity_id = ${created.id})
           OR (entity_type = 'put_away_task_cn' AND entity_id = ${created.putAwayTaskId})
        ORDER BY created_date, id`
  );
  assert.deepEqual(
    logs.map((l) => [l.entityType, l.toState]),
    [
      ["receiving_order_cn", "in_hand"],
      ["put_away_task_cn", "pending"],
    ]
  );
  assert.equal(logs[0].metadata.source, "manual");
  assert.deepEqual(logs[0].metadata.orderNos, ["329063176T3", "319000001T1"]);

  // The order is immediately visible in the admin CN order list (no workflow).
  const adminToken = await login("admin", "DocPalAdmin2026!");
  const list = await app.request("/admin/receiving-cn/orders", { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as { rows: { batchNo: string; status: string; putAwayStatus: string | null }[] };
  const row = listBody.rows.find((r) => r.batchNo === created.batchNo);
  assert.ok(row);
  assert.equal(row!.status, "in_hand");
  assert.equal(row!.putAwayStatus, "pending");
});

test("invoice seq: the second same-brand receipt of the day gets -02; uniform pair lands on the task", async () => {
  await reseed(client);
  await seedOrgInfoPairs();
  const token = await login("operator", "DocPal2026!");
  const body = {
    orders: [{ orderNo: "329000000T0", items: [{ partNo: "RK73B1JTTD181G", qty: 10, brand: "KOA", supplierCode: "KOA" }] }],
  };
  const first = (await (await postManual(token, body)).json()) as { batchNo: string; putAwayTaskId: string };
  const second = (await (await postManual(token, body)).json()) as { batchNo: string; putAwayTaskId: string };
  assert.match(first.batchNo, /^KOA-\d{8}-01$/);
  assert.match(second.batchNo, /^KOA-\d{8}-02$/);
  assert.notEqual(first.batchNo, second.batchNo);

  // All items share one org/sub pair → the task carries it directly.
  const task = await queryGet<{ orgId: number | null; subInventoryCode: string | null }>(
    client.db,
    sql`SELECT org_id AS "orgId", sub_inventory_code AS "subInventoryCode" FROM put_away_tasks_cn WHERE id = ${first.putAwayTaskId}`
  );
  assert.equal(task!.orgId, 14);
  assert.equal(task!.subInventoryCode, "GZSZ");
});

test("po_no prefix rules: unmatched prefix falls back to org 7 / STORE1", async () => {
  await reseed(client);
  await seedOrgInfoPairs();
  const token = await login("operator", "DocPal2026!");
  const res = await postManual(token, {
    orders: [{ orderNo: "999-UNKNOWN", items: [{ partNo: "X", qty: 5, brand: "KOA" }] }],
  });
  assert.equal(res.status, 201);
  const created = (await res.json()) as { id: string };
  const item = await queryGet<{ orgId: number; subInventoryCode: string }>(
    client.db,
    sql`SELECT rii.org_id AS "orgId", rii.sub_inventory_code AS "subInventoryCode"
        FROM receiving_invoice_items_cn rii
        JOIN receiving_invoices_cn ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${created.id}`
  );
  assert.equal(item!.orgId, 7);
  assert.equal(item!.subInventoryCode, "STORE1");
});
