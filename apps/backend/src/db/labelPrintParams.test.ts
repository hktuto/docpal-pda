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
}): Promise<string> {
  const id = randomUUID();
  await client.db.execute(sql`
    INSERT INTO label_print_rules
      (id, name, label_type, conditions, print_template_id, priority, active)
    VALUES
      (${id}, ${`rule-${id}`}, ${opts.labelType},
       ${JSON.stringify({ combinator: "and", conditions: [{ field: "order_no", operator: "match", value: opts.orderNoGlob }] })}::jsonb,
       ${`tpl-${id}`}, 100, ${opts.active ?? true})
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
