import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "./test-helper.js";
import { getLabelsData } from "./labels.js";
import { allocateAll } from "./allocate.js";
import { buildKoaLabelRaw, decodeKoaQty, encodeKoaQty, parseQrRaw } from "./scanParse.js";
import { queryGet } from "./query.js";

let client: TestDb;

before(async () => {
  client = await setupTestDb();
});

after(async () => {
  await client.sql.end();
});

// --- KOA qty encoding -------------------------------------------------------

test("encodeKoaQty is the inverse of decodeKoaQty", () => {
  for (const qty of [1, 10, 500, 800, 1000, 1200, 1500, 1234, 25000]) {
    const encoded = encodeKoaQty(qty);
    assert.ok(encoded, `encodes ${qty}`);
    assert.equal(decodeKoaQty(encoded), qty);
  }
  assert.equal(encodeKoaQty(2000), "23");
  assert.equal(encodeKoaQty(1500), "152");
  assert.equal(encodeKoaQty(0), undefined);
  assert.equal(encodeKoaQty(-5), undefined);
});

test("buildKoaLabelRaw round-trips through parseQrRaw with the seeded KOA template", async () => {
  const profile = await queryGet<{ qrTemplate: string; qtyEncoding: string }>(
    client.db,
    sql`SELECT qr_template AS "qrTemplate", qty_encoding AS "qtyEncoding" FROM supplier_profiles WHERE supplier_code = 'KOA'`
  );
  assert.ok(profile?.qrTemplate);

  const raw = buildKoaLabelRaw({ partNo: "RK73H1JTTD3302F", qty: 500, lotCode: "L2609C", serialNo: "900001" });
  assert.ok(raw);
  const parsed = parseQrRaw(raw, profile.qrTemplate, profile.qtyEncoding);
  assert.deepEqual(parsed, {
    partNo: "RK73H1JTTD3302F",
    qty: 500,
    dateCode: undefined,
    lotCode: "L2609C",
    coo: undefined,
    cow: undefined,
    serialNo: "900001",
  });

  // missing lot code still parses (template groups require 1+ chars)
  const noLot = buildKoaLabelRaw({ partNo: "RK73H1JTTD3302F", qty: 500, lotCode: null, serialNo: "900002" });
  assert.ok(noLot);
  assert.equal(parseQrRaw(noLot!, profile.qrTemplate, profile.qtyEncoding).qty, 500);
});

// --- getLabelsData ----------------------------------------------------------

test("getLabelsData: shelf boxes, shelf codes, receiving orders and shelf lots", async () => {
  const data = await getLabelsData(client.db);

  assert.equal(data.shelfBoxes.length, 4);
  const box1 = data.shelfBoxes.find((b) => b.id === "BOX-H-20260701-0001");
  assert.ok(box1);
  assert.deepEqual(box1.items, [
    { partNo: "RK73H1JTTD1002F", qty: 1000 },
    { partNo: "RK73H1JTTD2202F", qty: 500 },
  ]);
  // the empty case-1 target box is listed with no items
  const box4 = data.shelfBoxes.find((b) => b.id === "BOX-H-20260701-0004");
  assert.ok(box4);
  assert.deepEqual(box4.items, []);

  assert.deepEqual(data.shelfCodes, ["A-01-01", "A-01-02", "A-02-01", "A-02-02"]);

  assert.deepEqual(
    data.receivingOrders.map((o) => o.batchNo),
    ["100001", "100002", "100003"]
  );
  const order3 = data.receivingOrders.find((o) => o.batchNo === "100003")!;
  const c3001 = order3.invoices[0].items.filter((i) => i.ctnNo === "C3001");
  assert.equal(c3001.length, 2);
  // every KOA item carries a parseable label value
  for (const item of order3.invoices[0].items) {
    assert.ok(item.qrValue, `qrValue for ${item.partNo}`);
    assert.ok(item.qrValue!.includes(`:${item.partNo}:`));
  }
  // case-1 part is linked to its picking order for page filtering
  assert.deepEqual(c3001.find((i) => i.partNo === "RK73H1JTTD3302F")!.pickingOrderRefs, ["SO-DEMO-0003"]);

  // shelf lots carry box refs and label values too
  const lot = data.shelfLots.find((l) => l.partNo === "RK73H1JTTD5602F");
  assert.ok(lot);
  assert.equal(lot.boxId, "BOX-H-20260701-0003");
  assert.equal(lot.shelfCode, "A-02-01");
  assert.ok(lot.qrValue);
  assert.deepEqual(lot.pickingOrderRefs, ["SO-DEMO-0005"]);

  // serial numbers are unique across all printed part labels
  const serials = [
    ...data.receivingOrders.flatMap((o) => o.invoices.flatMap((i) => i.items.map((x) => x.qrValue))),
    ...data.shelfLots.map((l) => l.qrValue),
    ...data.pickLabels.map((l) => l.qrValue),
  ].filter(Boolean) as string[];
  assert.equal(new Set(serials).size, serials.length);
});

test("getLabelsData: pickLabels — one label per allocation, exact split qty", async () => {
  await allocateAll(client.db);
  const data = await getLabelsData(client.db);

  // the seeded 181G×700 shelf lot is split across two orders: 300 + 400 —
  // each share gets its own label with the exact pick qty
  const g181 = data.pickLabels.filter((l) => l.partNo === "RK73B1JTTD181G");
  assert.deepEqual(
    g181.map((l) => [l.orderNo, l.qty]),
    [
      ["SO-DEMO-0001", 300],
      ["SO-DEMO-0002", 400],
    ]
  );
  assert.equal(g181[0]!.source, "BOX-H-20260701-0002 @ A-01-02");
  assert.equal(g181[0]!.lotCode, "L2604A");
  assert.ok(g181.every((l) => l.qrValue));

  // case-3 order splits across shelf box and receiving carton sources
  const d5602 = data.pickLabels.filter((l) => l.partNo === "RK73H1JTTD5602F");
  assert.deepEqual(
    d5602.map((l) => [l.orderNo, l.qty, l.source]),
    [["SO-DEMO-0005", 1000, "BOX-H-20260701-0003 @ A-02-01"]]
  );
});
