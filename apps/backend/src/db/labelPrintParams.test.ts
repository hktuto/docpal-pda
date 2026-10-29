import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { setupTestDb, reseed, type TestDb } from "./test-helper.js";
import { queryGet } from "./query.js";
import { buildDefaultLabelPrintParams, printOrderLabel } from "./labelPrintParams.js";
import type { PickingItemDetail, PickingOrderDetail, PickingPackageDetail } from "./picking.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

beforeEach(async () => {
  await reseed(client);
  await client.db.execute(sql`DELETE FROM label_print_rules`);
});

// ---------------------------------------------------------------------------
// Default builder parity (ported from the retired PDA
// apps/pda/tests/labelPrintParams.test.ts). Fixtures are cast — the builder
// only reads the fields set here.
// ---------------------------------------------------------------------------

function pkg(id: string, qty: number, overrides: Partial<PickingPackageDetail> = {}): PickingPackageDetail {
  return {
    id,
    qty,
    dateCode: null,
    lotCode: null,
    coo: null,
    cow: null,
    scannedDateCode: null,
    scannedLotCode: null,
    scannedCoo: null,
    scannedCow: null,
    shippingBoxId: null,
    ...overrides,
  } as PickingPackageDetail;
}

function item(id: string, partNo: string, packages: PickingPackageDetail[], overrides: Partial<PickingItemDetail> = {}): PickingItemDetail {
  return {
    id,
    partNo,
    wclItemNo: null,
    brand: null,
    packages,
    ...overrides,
  } as PickingItemDetail;
}

function order(overrides: Partial<PickingOrderDetail> = {}): PickingOrderDetail {
  return {
    orderNo: "SO-1001",
    poNo: "PO-55",
    shipTo: "HK Warehouse",
    customerCode: "CUST-9",
    items: [],
    boxes: [],
    ...overrides,
  } as PickingOrderDetail;
}

function box(id: string, packageCount: number) {
  return { id, packageCount } as PickingOrderDetail["boxes"][number];
}

const sample = order({
  items: [
    item("i1", "PART-A", [
      pkg("p1", 100, {
        dateCode: "2610",
        lotCode: "LOT1",
        coo: "JP",
        shippingBoxId: "BOX-1",
      }),
      pkg("p2", 50, {
        // Pick-time scanned values win over the source snapshot.
        dateCode: "2601",
        lotCode: "SNAP-LOT",
        scannedDateCode: "2640",
        scannedLotCode: "SCAN-LOT",
        scannedCoo: "TW",
        shippingBoxId: "BOX-1",
      }),
    ], { wclItemNo: "WCL-A", brand: "KOA" }),
    item("i2", "PART-B", [
      pkg("p3", 7, { shippingBoxId: "BOX-2" }),
    ]),
  ],
  boxes: [box("BOX-2", 1), box("BOX-1", 2)],
});

test("carton: one row per box, sorted by id, with box totals", () => {
  const rows = buildDefaultLabelPrintParams("carton", sample);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].boxId, "BOX-1");
  assert.equal(rows[1].boxId, "BOX-2");
  // BOX-1 holds p1 (100) + p2 (50); BOX-2 holds p3 (7).
  assert.equal(rows[0].qty, "150");
  assert.equal(rows[0].quantity, "150");
  assert.equal(rows[1].qty, "7");
  // Box id doubles as the scannable codes.
  assert.equal(rows[0].barcodeValue, "BOX-1");
  assert.equal(rows[0].barCode, "BOX-1");
  assert.equal(rows[0].serialNo, "BOX-1");
  assert.equal(rows[0].qrcode, "BOX-1");
  // Identity fields come from the order.
  assert.equal(rows[0].orderNo, "SO-1001");
  assert.equal(rows[0].poNo, "PO-55");
  assert.equal(rows[0].invNo, "PO-55");
  assert.equal(rows[0].customerCode, "CUST-9");
  assert.equal(rows[0].customerName, "CUST-9");
  assert.equal(rows[0].shipTo, "HK Warehouse");
});

test("carton: single-part box exposes the part; mixed box leaves part fields empty", () => {
  const rows = buildDefaultLabelPrintParams("carton", sample);
  // BOX-1 holds two packages of PART-A → single-part.
  assert.equal(rows[0].partNo, "PART-A");
  assert.equal(rows[0].MFRCode, "KOA");
  // BOX-2 holds PART-B → single-part.
  assert.equal(rows[1].partNo, "PART-B");
  const mixed = order({
    items: [
      item("i1", "PART-A", [pkg("p1", 1, { shippingBoxId: "BOX-9" })]),
      item("i2", "PART-B", [pkg("p2", 1, { shippingBoxId: "BOX-9" })]),
    ],
    boxes: [box("BOX-9", 2)],
  });
  const [row] = buildDefaultLabelPrintParams("carton", mixed);
  assert.equal(row.partNo, "");
  assert.equal(row.qty, "2");
});

test("item: one row per package across all items, in item order", () => {
  const rows = buildDefaultLabelPrintParams("item", sample);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.barcodeValue), ["p1", "p2", "p3"]);
  assert.equal(rows[0].partNo, "PART-A");
  assert.equal(rows[0].wclItemNo, "WCL-A");
  assert.equal(rows[0].ATICode, "PART-A");
  assert.equal(rows[0].MFRCode, "KOA");
  assert.equal(rows[2].partNo, "PART-B");
  // item_box behaves identically.
  assert.deepEqual(
    buildDefaultLabelPrintParams("item_box", sample).map((r) => r.barcodeValue),
    ["p1", "p2", "p3"]
  );
});

test("prefers pick-time scanned batch fields over the source snapshot", () => {
  const rows = buildDefaultLabelPrintParams("item", sample);
  // p1: no scanned values → snapshot.
  assert.equal(rows[0].dateCode, "2610");
  assert.equal(rows[0].lotCode, "LOT1");
  assert.equal(rows[0].lotNo, "LOT1");
  assert.equal(rows[0].coo, "JP");
  assert.equal(rows[0].makeIn, "JP");
  assert.equal(rows[0].productionDate, "2610");
  // p2: scanned values win.
  assert.equal(rows[1].dateCode, "2640");
  assert.equal(rows[1].lotCode, "SCAN-LOT");
  assert.equal(rows[1].coo, "TW");
  assert.equal(rows[1].cow, "");
});

test("trace code joins part|dateCode|lotCode|qty, skipping empty segments", () => {
  const rows = buildDefaultLabelPrintParams("item", sample);
  assert.equal(rows[0].traceCode, "WCL-A|2610|LOT1|100");
  assert.equal(rows[1].traceCode, "WCL-A|2640|SCAN-LOT|50");
  // p3 has no batch fields at all → just part + qty.
  assert.equal(rows[2].traceCode, "PART-B|7");
  assert.equal(rows[2].qrcode, rows[2].traceCode);
});

test("adds 1-based page/total strings and showTailBox over the row set", () => {
  const rows = buildDefaultLabelPrintParams("item", sample);
  assert.deepEqual(rows.map((r) => r.page), ["1", "2", "3"]);
  assert.ok(rows.every((r) => r.total === "3"));
  assert.ok(rows.every((r) => r.showTailBox === true));
  const cartons = buildDefaultLabelPrintParams("carton", sample);
  assert.deepEqual(cartons.map((r) => r.page), ["1", "2"]);
  assert.ok(cartons.every((r) => r.total === "2"));
});

test("keeps every non-boolean value a string", () => {
  for (const rows of [
    buildDefaultLabelPrintParams("item", sample),
    buildDefaultLabelPrintParams("carton", sample),
  ]) {
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (key === "showTailBox") {
          assert.equal(value, true);
        } else {
          assert.equal(typeof value, "string", key);
        }
      }
    }
  }
});

test("null order fields render as empty strings", () => {
  const bare = order({ poNo: null, shipTo: null, customerCode: null });
  const rows = buildDefaultLabelPrintParams(
    "item",
    order({ ...bare, items: [item("i", "P", [pkg("p", 1)])] })
  );
  assert.equal(rows[0].poNo, "");
  assert.equal(rows[0].invNo, "");
  assert.equal(rows[0].shipTo, "");
  assert.equal(rows[0].customerCode, "");
});

test("empty order produces no rows", () => {
  assert.deepEqual(buildDefaultLabelPrintParams("carton", order()), []);
  assert.deepEqual(buildDefaultLabelPrintParams("item", order()), []);
});

// ---------------------------------------------------------------------------
// printOrderLabel error paths — each throws before the print service call.
// ---------------------------------------------------------------------------

const ORDER_NO = "SO-DEMO-0001";

async function orderId(): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_orders WHERE order_no = ${ORDER_NO}`
  );
  return row!.id;
}

async function insertRule(opts: {
  labelType: "carton" | "item_box" | "item";
  orderNoGlob: string;
  active?: boolean;
  labelSource?: "internal" | "external";
}): Promise<string> {
  const id = randomUUID();
  await client.db.execute(sql`
    INSERT INTO label_print_rules
      (id, name, label_type, conditions, print_template_id, priority, active, label_source)
    VALUES
      (${id}, ${`rule-${id}`}, ${opts.labelType},
       ${JSON.stringify({ combinator: "and", conditions: [{ field: "order_no", operator: "match", value: opts.orderNoGlob }] })}::jsonb,
       ${`tpl-${id}`}, 100, ${opts.active ?? true}, ${opts.labelSource ?? "internal"})
  `);
  return id;
}

async function assertHttpError(promise: Promise<unknown>, status: number, message: string) {
  try {
    await promise;
    assert.fail("expected HTTPException");
  } catch (err) {
    assert.ok(err instanceof HTTPException);
    assert.equal(err.status, status);
    assert.equal(err.message, message);
  }
}

test("printOrderLabel: unknown rule → 404 label_print_rule_not_found", async () => {
  await assertHttpError(
    printOrderLabel(client.db, { orderId: await orderId(), ruleId: randomUUID() }),
    404,
    "label_print_rule_not_found"
  );
});

test("printOrderLabel: inactive rule → 409 label_print_rule_inactive", async () => {
  const ruleId = await insertRule({ labelType: "carton", orderNoGlob: "SO-DEMO-*", active: false });
  await assertHttpError(
    printOrderLabel(client.db, { orderId: await orderId(), ruleId }),
    409,
    "label_print_rule_inactive"
  );
});

test("printOrderLabel: rule not matching the order → 409 label_rule_no_longer_matches", async () => {
  const ruleId = await insertRule({ labelType: "carton", orderNoGlob: "NOPE-*" });
  await assertHttpError(
    printOrderLabel(client.db, { orderId: await orderId(), ruleId }),
    409,
    "label_rule_no_longer_matches"
  );
});

test("printOrderLabel: unknown order → 404 picking_order_not_found", async () => {
  const ruleId = await insertRule({ labelType: "carton", orderNoGlob: "*" });
  await assertHttpError(
    printOrderLabel(client.db, { orderId: randomUUID(), ruleId }),
    404,
    "picking_order_not_found"
  );
});

test("printOrderLabel: external rule → 409 label_rule_external", async () => {
  const ruleId = await insertRule({ labelType: "carton", orderNoGlob: "SO-DEMO-*", labelSource: "external" });
  await assertHttpError(
    printOrderLabel(client.db, { orderId: await orderId(), ruleId, actorId: randomUUID() }),
    409,
    "label_rule_external"
  );
});

// ---------------------------------------------------------------------------
// Print recording (2026-10-30): a successful upstream print inserts one
// label_prints row with the full linked payload; a reprint is a new row.
// ---------------------------------------------------------------------------

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { allocateAll } from "./allocate.js";
import {
  addAllUnboxedToShippingBox,
  createShippingBox,
  scanPickingItem,
} from "./picking.js";
import { queryAll } from "./query.js";

interface PrintRecordRow {
  id: string;
  pickingOrderId: string;
  ruleId: string;
  labelType: string;
  printTemplateId: string;
  expectedLabelCount: number;
  payload: { shippingBoxId: string | null; packageId: string | null; params: Record<string, unknown> }[];
  result: unknown;
  printedBy: string;
}

async function actorId(): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM users WHERE username = 'operator'`);
  return row!.id;
}

async function itemIdOf(orderId: string, partNo: string): Promise<string> {
  const row = await queryGet<{ id: string }>(
    client.db,
    sql`SELECT id FROM picking_items WHERE picking_order_id = ${orderId} AND part_no = ${partNo}`
  );
  return row!.id;
}

async function allocationIdOf(itemId: string): Promise<string> {
  const row = await queryGet<{ id: string }>(client.db, sql`SELECT id FROM allocations WHERE picking_item_id = ${itemId}`);
  return row!.id;
}

/** Scan all three seeded items in full and box them. */
async function boxedOrder(): Promise<{ orderId: string; boxId: string; packageIds: string[]; actor: string }> {
  const actor = await actorId();
  await allocateAll(client.db);
  const id = await orderId();
  const packageIds: string[] = [];
  for (const [partNo, qty] of [["RK73H1JTTD1002F", 1000], ["RK73H1JTTD2202F", 500], ["RK73B1JTTD181G", 300]] as const) {
    const itemId = await itemIdOf(id, partNo);
    const { packageIds: ids } = await scanPickingItem(client.db, itemId, {
      actorId: actor,
      allocationId: await allocationIdOf(itemId),
      qty,
    });
    packageIds.push(...ids);
  }
  const box = await createShippingBox(client.db, { pickingOrderId: id, actorId: actor });
  await addAllUnboxedToShippingBox(client.db, { shippingBoxId: box.id, actorId: actor });
  return { orderId: id, boxId: box.id, packageIds, actor };
}

async function withStubPrintServer<T>(fn: (requests: Record<string, unknown>[]) => Promise<T>): Promise<T> {
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, data: { jobs: ["job-1", "job-2"] } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const prev = process.env.PRINT_API_BASE_URL;
  process.env.PRINT_API_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    return await fn(requests);
  } finally {
    if (prev === undefined) delete process.env.PRINT_API_BASE_URL;
    else process.env.PRINT_API_BASE_URL = prev;
    await new Promise((resolve) => server.close(resolve));
  }
}

test("printOrderLabel records one label_prints row per print, reprint = new row, linkage stripped upstream", async () => {
  const { orderId, boxId, packageIds, actor } = await boxedOrder();
  const ruleId = await insertRule({ labelType: "carton", orderNoGlob: "SO-DEMO-*" });

  await withStubPrintServer(async (requests) => {
    const first = await printOrderLabel(client.db, { orderId, ruleId, actorId: actor });
    assert.equal(first.labelCount, 1);
    assert.deepEqual(first.jobs, ["job-1", "job-2"]);
    // Linkage is stripped from what goes upstream.
    const upstream = requests[0] as { printingParams: Record<string, unknown>[] };
    assert.equal(upstream.printingParams.length, 1);
    assert.ok(!("shippingBoxId" in upstream.printingParams[0]) || upstream.printingParams[0].shippingBoxId === undefined);
    assert.ok(!("packageId" in upstream.printingParams[0]));

    await printOrderLabel(client.db, { orderId, ruleId, actorId: actor }); // reprint
  });

  const rows = await queryAll<PrintRecordRow>(
    client.db,
    sql`SELECT id, picking_order_id AS "pickingOrderId", rule_id AS "ruleId",
               label_type AS "labelType", print_template_id AS "printTemplateId",
               expected_label_count AS "expectedLabelCount", payload, result,
               printed_by AS "printedBy"
        FROM label_prints WHERE picking_order_id = ${orderId} ORDER BY created_date, id`
  );
  assert.equal(rows.length, 2); // print + reprint
  for (const row of rows) {
    assert.equal(row.ruleId, ruleId);
    assert.equal(row.labelType, "carton");
    assert.equal(row.expectedLabelCount, 1);
    assert.equal(row.printedBy, actor);
    assert.deepEqual(row.result, ["job-1", "job-2"]);
    assert.equal(row.payload.length, 1);
    assert.equal(row.payload[0].shippingBoxId, boxId);
    assert.equal(row.payload[0].packageId, null);
    assert.equal(row.payload[0].params.boxId, boxId);
  }
});

test("printOrderLabel item rule records one payload row per package with packageId linkage", async () => {
  const { orderId, packageIds, actor } = await boxedOrder();
  const ruleId = await insertRule({ labelType: "item", orderNoGlob: "SO-DEMO-*" });

  await withStubPrintServer(async () => {
    const result = await printOrderLabel(client.db, { orderId, ruleId, actorId: actor });
    assert.equal(result.labelCount, 3);
  });

  const row = await queryGet<PrintRecordRow>(
    client.db,
    sql`SELECT expected_label_count AS "expectedLabelCount", payload
        FROM label_prints WHERE picking_order_id = ${orderId}`
  );
  assert.equal(row!.expectedLabelCount, 3);
  assert.deepEqual(
    row!.payload.map((r) => r.packageId).sort(),
    [...packageIds].sort()
  );
  assert.ok(row!.payload.every((r) => r.shippingBoxId === null));
});
