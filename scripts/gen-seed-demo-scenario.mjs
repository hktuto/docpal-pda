#!/usr/bin/env node
// Compile the editable demo scenario into the backend seed artifact.
// Usage:
//   node scripts/gen-seed-demo-scenario.mjs            new_seed/demo-scenario.xlsx → apps/backend/src/db/seed-demo-scenario.ts
//   node scripts/gen-seed-demo-scenario.mjs --init     write the initial workbook (add --force to overwrite)
//
// Workflow: edit the xlsx → run this script → pnpm --filter @warehouse/backend db:seed
// Design: docs/superpowers/specs/2026-07-29-excel-demo-seed-design.md

import XLSX from "xlsx";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const xlsxPath = path.join(root, "new_seed", "demo-scenario.xlsx");
const outPath = path.join(root, "apps", "backend", "src", "db", "seed-demo-scenario.ts");

const args = new Set(process.argv.slice(2));
const uid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;
})();

// ---------------------------------------------------------------------------
// Initial scenario (written by --init)
// ---------------------------------------------------------------------------

const INITIAL = {
  receiving_orders: [
    ["batchNo", "supplierCode", "deliveryDate", "orgId", "subInventoryCode", "status"],
    ["100001", "KOA", "2026-07-28", 2, "STORE1", "pending"],
    ["100002", "KOA", "2026-07-29", 2, "STORE1", "pending"],
    ["100003", "KOA", "2026-08-03", 2, "STORE1", "pending"],
  ],
  receiving_invoices: [
    ["batchNo", "invoiceNo", "supplierCode", "wclCompanyName", "deliveryDate"],
    ["100001", "INV-100001-01", "KOA", "WCL Components Ltd", "2026-07-25"],
    ["100002", "INV-100002-01", "KOA", "WCL Components Ltd", "2026-07-26"],
    ["100003", "INV-100003-01", "KOA", "WCL Components Ltd", "2026-08-01"],
  ],
  receiving_items: [
    ["invoiceNo", "ctnNo", "partNo", "wclItemNo", "poNo", "poLine", "lineQty", "dateCode", "lotCode", "coo", "cow", "boxSize", "netWeight", "grossWeight", "weightUnit"],
    ["INV-100001-01", "C1001", "RK73H1JTTD1002F", "RK73H1JTTD1002F", "PO-KOA-101", "1", 2000, "2605", "L2605A", "JP", "JP", "26 X 22 X 22", 1300, 1450, "g"],
    ["INV-100001-01", "C1001", "RK73H1JTTD2202F", "RK73H1JTTD2202F", "PO-KOA-101", "2", 1000, "2605", "L2605B", "JP", "JP", "", "", "", ""],
    ["INV-100001-01", "C1002", "RK73B1JTTD181G", "RK73B1JTTD181G", "PO-KOA-101", "3", 1500, "2606", "L2606A", "JP", "JP", "33 X 24 X 18", 950, 1100, "g"],
    ["INV-100001-01", "C1002", "RK73H2ATTD1372F", "RK73H2ATTD1372F", "PO-KOA-101", "4", 800, "2606", "L2606B", "JP", "JP", "", "", "", ""],
    ["INV-100001-01", "C1002", "RK73H1JTTD4702F", "RK73H1JTTD4702F", "PO-KOA-101", "5", 500, "2606", "L2606C", "JP", "JP", "", "", "", ""],
    ["INV-100002-01", "C2001", "RK73H1JTTD4702F", "RK73H1JTTD4702F", "PO-DAI-201", "1", 1200, "2607", "L2607A", "JP", "JP", "32 X 22 X 30", 2100, 2350, "g"],
    ["INV-100002-01", "C2001", "RK73B1JTTD181G", "RK73B1JTTD181G", "PO-DAI-201", "2", 600, "2607", "L2607B", "JP", "JP", "", "", "", ""],
    ["INV-100002-01", "C2002", "RK73H2ATTD1372F", "RK73H2ATTD1372F", "PO-DAI-201", "3", 900, "2608", "L2608A", "JP", "JP", "35 X 35 X 22", 1600, 1800, "g"],
    ["INV-100002-01", "C2002", "RK73H1JTTD1002F", "RK73H1JTTD1002F", "PO-DAI-201", "4", 400, "2608", "L2608B", "JP", "JP", "", "", "", ""],
    ["INV-100002-01", "C2002", "RK73H1JTTD2202F", "RK73H1JTTD2202F", "PO-DAI-201", "5", 300, "2608", "L2608C", "JP", "JP", "", "", "", ""],
    // case 1 carton: contents == SO-DEMO-0003 exactly (whole-box claim after put-away)
    ["INV-100003-01", "C3001", "RK73H1JTTD3302F", "RK73H1JTTD3302F", "PO-KOA-301", "1", 500, "2609", "L2609C", "JP", "JP", "30 X 24 X 20", 1100, 1250, "g"],
    ["INV-100003-01", "C3001", "RK73H1JTTD6802F", "RK73H1JTTD6802F", "PO-KOA-301", "2", 800, "2609", "L2609D", "JP", "JP", "", "", "", ""],
    // case 2 supply: only 1200 of the 3000 SO-DEMO-0004 needs (never fully allocated)
    ["INV-100003-01", "C3002", "RK73B1JTTD102G", "RK73B1JTTD102G", "PO-KOA-301", "3", 1200, "2610", "L2610A", "JP", "JP", "28 X 20 X 18", 800, 950, "g"],
    // case 3 receiving portion: SO-DEMO-0005 also takes these parts from shelf box ...-0003
    ["INV-100003-01", "C3003", "RK73H1JTTD5602F", "RK73H1JTTD5602F", "PO-KOA-301", "4", 1500, "2611", "L2611A", "JP", "JP", "36 X 26 X 24", 1900, 2100, "g"],
    ["INV-100003-01", "C3003", "RK73H2ATTD2212F", "RK73H2ATTD2212F", "PO-KOA-301", "5", 500, "2611", "L2611B", "JP", "JP", "", "", "", ""],
  ],
  picking_orders: [
    ["orderNo", "poNo", "deliveryDate", "shipTo", "customerCode", "orgId", "subInventoryCode"],
    ["SO-DEMO-0001", "CUST-PO-9001", "2026-07-30", "ACME Electronics (HK)", "ACME", 2, "STORE1"],
    ["SO-DEMO-0002", "CUST-PO-9002", "2026-08-01", "ACME Electronics (HK)", "ACME", 2, "STORE1"],
    ["SO-DEMO-0003", "CUST-PO-9003", "2026-08-04", "ACME Electronics (HK)", "ACME", 2, "STORE1"],
    ["SO-DEMO-0004", "CUST-PO-9004", "2026-08-05", "ACME Electronics (HK)", "ACME", 2, "STORE1"],
    ["SO-DEMO-0005", "CUST-PO-9005", "2026-08-06", "ACME Electronics (HK)", "ACME", 2, "STORE1"],
  ],
  picking_items: [
    ["orderNo", "partNo", "qty", "lineId", "lineNumber", "shipmentNumber"],
    ["SO-DEMO-0001", "RK73H1JTTD1002F", 1000, 1001, 1, 1],
    ["SO-DEMO-0001", "RK73H1JTTD2202F", 500, 1002, 2, 1],
    // scanned item-by-item first; THEN the remaining demand == BOX-H-20260701-0001
    ["SO-DEMO-0001", "RK73B1JTTD181G", 300, 1003, 3, 1],
    ["SO-DEMO-0002", "RK73B1JTTD181G", 1000, 2001, 1, 1],
    ["SO-DEMO-0002", "RK73H1JTTD4702F", 600, 2002, 2, 1],
    ["SO-DEMO-0002", "RK73H2ATTD1372F", 700, 2003, 3, 1],
    // case 1: exactly carton C3001 of receiving 100003 — receive it, scan the
    // carton + part labels on the picking page, pack into a new shipping box
    // (box size / weights prefill from the carton's additional_data)
    ["SO-DEMO-0003", "RK73H1JTTD3302F", 500, 3001, 1, 1],
    ["SO-DEMO-0003", "RK73H1JTTD6802F", 800, 3002, 2, 1],
    // case 2: needs 3000 but only 1200 exists (C3002) — stays partially allocated
    ["SO-DEMO-0004", "RK73B1JTTD102G", 3000, 4001, 1, 1],
    // case 3: both lines split across shelf stock (box ...-0003) and receiving (C3003)
    ["SO-DEMO-0005", "RK73H1JTTD5602F", 2500, 5001, 1, 1],
    ["SO-DEMO-0005", "RK73H2ATTD2212F", 900, 5002, 2, 1],
  ],
  shelf_boxes: [
    ["boxId", "shelfCode", "orgId", "subInventoryCode", "status"],
    ["BOX-H-20260701-0001", "A-01-01", 2, "STORE1", "closed"],
    ["BOX-H-20260701-0002", "A-01-02", 2, "STORE1", "closed"],
    ["BOX-H-20260701-0003", "A-02-01", 2, "STORE1", "closed"],
    // empty spare box (print its label from /print-labels for put-away demos)
    ["BOX-H-20260701-0004", "A-02-02", 2, "STORE1", "open"],
    // 10 pre-generated empty boxes for put-away (labels: box-shelf-labels.pdf)
    ["BOX-H-20260701-0005", "A-03-01", 2, "STORE1", "open"],
    ["BOX-H-20260701-0006", "A-03-02", 2, "STORE1", "open"],
    ["BOX-H-20260701-0007", "A-03-03", 2, "STORE1", "open"],
    ["BOX-H-20260701-0008", "A-03-04", 2, "STORE1", "open"],
    ["BOX-H-20260701-0009", "A-03-05", 2, "STORE1", "open"],
    ["BOX-H-20260701-0010", "A-04-01", 2, "STORE1", "open"],
    ["BOX-H-20260701-0011", "A-04-02", 2, "STORE1", "open"],
    ["BOX-H-20260701-0012", "A-04-03", 2, "STORE1", "open"],
    ["BOX-H-20260701-0013", "A-04-04", 2, "STORE1", "open"],
    ["BOX-H-20260701-0014", "A-04-05", 2, "STORE1", "open"],
  ],
  shelf_stock: [
    ["boxId", "shelfCode", "partNo", "qty", "dateCode", "lotCode", "coo", "cow"],
    ["BOX-H-20260701-0001", "A-01-01", "RK73H1JTTD1002F", 1000, "2603", "L2603A", "JP", "JP"],
    ["BOX-H-20260701-0001", "A-01-01", "RK73H1JTTD2202F", 500, "2603", "L2603B", "JP", "JP"],
    ["BOX-H-20260701-0002", "A-01-02", "RK73B1JTTD181G", 700, "2604", "L2604A", "JP", "JP"],
    ["BOX-H-20260701-0002", "A-01-02", "RK73H1JTTD4702F", 200, "2604", "L2604B", "JP", "JP"],
    ["BOX-H-20260701-0003", "A-02-01", "RK73H1JTTD5602F", 1000, "2609", "L2609A", "JP", "JP"],
    ["BOX-H-20260701-0003", "A-02-01", "RK73H2ATTD2212F", 400, "2609", "L2609B", "JP", "JP"],
  ],
  README: [
    ["Demo scenario workbook — edit me, then regenerate the seed."],
    [""],
    ["1. Edit any sheet below (keep the header row)."],
    ["2. node scripts/gen-seed-demo-scenario.mjs"],
    ["3. pnpm --filter @warehouse/backend db:seed   (or POST /dev/reset)"],
    [""],
    ["Story: 3 pending receiving orders. 100001/100002 are the original pair:"],
    ["PO SO-DEMO-0001: scan the 181G×300 line item-by-item first — then the"],
    ["remaining demand exactly matches shelf box BOX-H-20260701-0001 (whole-box claim),"],
    ["PO SO-DEMO-0002 is only partially covered by shelf stock — the rest arrives"],
    ["on receiving orders 100001/100002 (process them, then re-allocate)."],
    [""],
    ["100003 feeds the three allocation demo cases:"],
    ["case 1 (SO-DEMO-0003): demand == carton C3001 exactly — receive 100003,"],
    ["then on the picking page scan the C3001 carton label and its two part"],
    ["labels; pack the packages into a new shipping box — its box size/weights"],
    ["prefill from the carton's additional_data and flow to measuring."],
    ["case 2 (SO-DEMO-0004): needs 102G×3000, only 1200 exists (C3002) — the order"],
    ["stays partially allocated on the picking list."],
    ["case 3 (SO-DEMO-0005): both lines split across shelf box BOX-H-20260701-0003"],
    ["and receiving carton C3003."],
    [""],
    ["Print scannable labels (parts, cartons, boxes, shelves) from the web app's"],
    ["/print-labels page (live data from GET /labels-data)."],
    [""],
    ["BOX-H-20260701-0005..0014 are 10 empty pre-generated put-away boxes on"],
    ["A-03-01..A-04-05 — print their labels with apps/web's"],
    ["generate:box-shelf-labels-pdf script (box-shelf-labels.pdf)."],
    [""],
    ["receiving_items metadata columns boxSize/netWeight/grossWeight/weightUnit"],
    ["are packed into the item's additional_data (weightUnit: g | kg, default kg)."],
    ["shelf_stock with a blank boxId becomes a loose (unboxed) shelf lot."],
  ],
};

// ---------------------------------------------------------------------------
// --init
// ---------------------------------------------------------------------------

if (args.has("--init")) {
  if (existsSync(xlsxPath) && !args.has("--force")) {
    console.error(`${xlsxPath} already exists — pass --force to overwrite.`);
    process.exit(1);
  }
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(INITIAL)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  XLSX.writeFile(wb, xlsxPath);
  console.log(`wrote ${xlsxPath}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Compile xlsx → seed-demo-scenario.ts
// ---------------------------------------------------------------------------

if (!existsSync(xlsxPath)) {
  console.error(`${xlsxPath} not found — run with --init first.`);
  process.exit(1);
}

const wb = XLSX.readFile(xlsxPath);
function rows(sheet) {
  const ws = wb.Sheets[sheet];
  if (!ws) fail(`missing sheet "${sheet}"`);
  const [header, ...data] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  return data
    .map((r, i) => ({ r, row: i + 2 }))
    .filter(({ r }) => r.some((c) => String(c).trim() !== ""))
    .map(({ r, row }) => {
      const o = { __row: row };
      header.forEach((h, i) => {
        if (h) o[h] = r[i];
      });
      return o;
    });
}

function fail(msg) {
  console.error(`demo-scenario.xlsx: ${msg}`);
  process.exit(1);
}
const str = (v) => String(v ?? "").trim();
const opt = (v) => {
  const s = str(v);
  return s === "" ? null : s;
};
function int(v, sheet, row, col) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail(`${sheet} row ${row}: ${col} must be a positive integer, got "${v}"`);
  return n;
}
function date(v, sheet, row, col) {
  const s = str(v);
  if (!s) return null;
  // Excel may hand back a Date serial; accept YYYY-MM-DD strings and Date objects.
  const d = v instanceof Date ? v : new Date(s);
  if (Number.isNaN(d.getTime())) fail(`${sheet} row ${row}: ${col} is not a date, got "${v}"`);
  return d.toISOString().slice(0, 10);
}

const recOrders = rows("receiving_orders");
const recInvoices = rows("receiving_invoices");
const recItems = rows("receiving_items");
const pickOrders = rows("picking_orders");
const pickItems = rows("picking_items");
const shelfBoxes = rows("shelf_boxes");
const shelfStock = rows("shelf_stock");

// reference validation
const batchNos = new Set(recOrders.map((o) => str(o.batchNo)));
const invoiceToOrder = new Map();
for (const inv of recInvoices) {
  const b = str(inv.batchNo);
  if (!batchNos.has(b)) fail(`receiving_invoices row ${inv.__row}: unknown batchNo "${b}"`);
  invoiceToOrder.set(str(inv.invoiceNo), b);
}
const orderSupplier = new Map(recOrders.map((o) => [str(o.batchNo), str(o.supplierCode)]));
for (const it of recItems) {
  if (!invoiceToOrder.has(str(it.invoiceNo))) fail(`receiving_items row ${it.__row}: unknown invoiceNo "${it.invoiceNo}"`);
  int(it.lineQty, "receiving_items", it.__row, "lineQty");
  if (str(it.partNo) === "") fail(`receiving_items row ${it.__row}: partNo is required`);
  const wu = str(it.weightUnit);
  if (wu && wu !== "g" && wu !== "kg") fail(`receiving_items row ${it.__row}: weightUnit must be g or kg, got "${wu}"`);
}
const orderNos = new Set(pickOrders.map((o) => str(o.orderNo)));
for (const it of pickItems) {
  if (!orderNos.has(str(it.orderNo))) fail(`picking_items row ${it.__row}: unknown orderNo "${it.orderNo}"`);
  int(it.qty, "picking_items", it.__row, "qty");
  int(it.lineId, "picking_items", it.__row, "lineId");
  int(it.lineNumber, "picking_items", it.__row, "lineNumber");
  int(it.shipmentNumber, "picking_items", it.__row, "shipmentNumber");
}
const boxIds = new Set(shelfBoxes.map((b) => str(b.boxId)));
for (const s of shelfStock) {
  const b = str(s.boxId);
  if (b && !boxIds.has(b)) fail(`shelf_stock row ${s.__row}: unknown boxId "${b}"`);
  int(s.qty, "shelf_stock", s.__row, "qty");
}

// parts referenced anywhere (brand = the line's supplier where known)
const partBrand = new Map();
for (const it of recItems) {
  const p = str(it.partNo);
  if (!partBrand.has(p)) partBrand.set(p, orderSupplier.get(invoiceToOrder.get(str(it.invoiceNo))) || "DEMO");
}
for (const it of [...pickItems, ...shelfStock]) {
  const p = str(it.partNo);
  if (!partBrand.has(p)) partBrand.set(p, "DEMO");
}

// build rows
const orderIdByBatch = new Map();
const demoReceivingOrders = recOrders.map((o) => {
  const id = uid();
  orderIdByBatch.set(str(o.batchNo), id);
  return {
    id,
    batchNo: str(o.batchNo),
    supplierCode: opt(o.supplierCode),
    deliveryDate: date(o.deliveryDate, "receiving_orders", o.__row, "deliveryDate"),
    orgId: Number(o.orgId) || 2,
    subInventoryCode: str(o.subInventoryCode) || "STORE1",
    status: str(o.status) || "pending",
  };
});

const invoiceIdByNo = new Map();
const itemsByInvoice = new Map();
for (const it of recItems) {
  const k = str(it.invoiceNo);
  itemsByInvoice.set(k, [...(itemsByInvoice.get(k) ?? []), it]);
}
const demoReceivingInvoices = recInvoices.map((inv) => {
  const id = uid();
  invoiceIdByNo.set(str(inv.invoiceNo), id);
  const lines = itemsByInvoice.get(str(inv.invoiceNo)) ?? [];
  return {
    id,
    receivingOrderId: orderIdByBatch.get(str(inv.batchNo)),
    invoiceNo: str(inv.invoiceNo),
    supplierCode: opt(inv.supplierCode),
    wclCompanyName: opt(inv.wclCompanyName),
    totalQty: lines.reduce((s, l) => s + Number(l.lineQty), 0),
    totalCtn: new Set(lines.map((l) => str(l.ctnNo)).filter(Boolean)).size,
    deliveryDate: date(inv.deliveryDate, "receiving_invoices", inv.__row, "deliveryDate"),
    orgId: 2,
  };
});

const demoReceivingInvoiceItems = recItems.map((it) => {
  const ad = {};
  if (opt(it.boxSize)) ad.boxSize = opt(it.boxSize);
  if (opt(it.netWeight) != null) ad.netWeight = Number(it.netWeight);
  if (opt(it.grossWeight) != null) ad.grossWeight = Number(it.grossWeight);
  if (opt(it.weightUnit)) ad.weightUnit = opt(it.weightUnit);
  return {
    id: uid(),
    receivingInvoiceId: invoiceIdByNo.get(str(it.invoiceNo)),
    partNo: str(it.partNo),
    wclItemNo: opt(it.wclItemNo),
    poNo: opt(it.poNo),
    poLine: opt(it.poLine),
    lineQty: Number(it.lineQty),
    ctnNo: opt(it.ctnNo),
    dateCode: opt(it.dateCode),
    lotCode: opt(it.lotCode),
    coo: opt(it.coo),
    cow: opt(it.cow),
    orgId: 2,
    additionalData: Object.keys(ad).length ? ad : null,
  };
});

const pickIdByNo = new Map();
const demoPickingOrders = pickOrders.map((o) => {
  const id = uid();
  pickIdByNo.set(str(o.orderNo), id);
  return {
    id,
    orderNo: str(o.orderNo),
    poNo: opt(o.poNo),
    deliveryDate: date(o.deliveryDate, "picking_orders", o.__row, "deliveryDate"),
    shipTo: opt(o.shipTo),
    customerCode: opt(o.customerCode),
    orgId: o.orgId === "" || o.orgId == null ? null : Number(o.orgId),
    subInventoryCode: opt(o.subInventoryCode),
    status: "pending",
  };
});
const demoPickingItems = pickItems.map((it) => ({
  id: uid(),
  pickingOrderId: pickIdByNo.get(str(it.orderNo)),
  partNo: str(it.partNo),
  qty: Number(it.qty),
  lineId: Number(it.lineId),
  lineNumber: Number(it.lineNumber),
  shipmentNumber: Number(it.shipmentNumber),
}));

const demoShelfBoxes = shelfBoxes.map((b) => ({
  id: str(b.boxId),
  shelfCode: opt(b.shelfCode),
  orgId: b.orgId === "" || b.orgId == null ? null : Number(b.orgId),
  subInventoryCode: opt(b.subInventoryCode),
  status: str(b.status) || "closed",
}));
const demoShelfBoxItems = shelfStock
  .filter((s) => str(s.boxId) !== "")
  .map((s) => ({ id: uid(), shelfBoxId: str(s.boxId), partNo: str(s.partNo), qty: Number(s.qty) }));
const boxPair = new Map(demoShelfBoxes.map((b) => [b.id, b]));
const demoLots = shelfStock.map((s) => {
  const box = str(s.boxId) ? boxPair.get(str(s.boxId)) : null;
  return {
    id: uid(),
    partNo: str(s.partNo),
    dateCode: opt(s.dateCode),
    lotCode: opt(s.lotCode),
    coo: opt(s.coo),
    cow: opt(s.cow),
    shelfCode: opt(s.shelfCode),
    boxId: opt(s.boxId),
    orgId: box ? box.orgId : 2,
    subInventoryCode: box ? box.subInventoryCode : "STORE1",
    totalQty: Number(s.qty),
  };
});

const demoParts = [...partBrand.entries()].map(([partNo, brand]) => ({
  id: uid(),
  brand,
  partNo,
  wclItemNo: partNo,
  description: null,
  defaultCoo: null,
}));

// emit TS
const d = (s) => (s ? `d(${JSON.stringify(s)})` : "null");
const j = (v) => JSON.stringify(v);
function ts(name, rows, f) {
  const body = rows.map((r) => `  { ${f(r)} }`).join(",\n");
  return `export const ${name} = [\n${body}\n];\n`;
}
const out = `// GENERATED by scripts/gen-seed-demo-scenario.mjs from new_seed/demo-scenario.xlsx — do not edit by hand.
// Edit the workbook, re-run the generator, then db:seed. Spec:
// docs/superpowers/specs/2026-07-29-excel-demo-seed-design.md
const d = (s: string) => new Date(s);

${ts("demoParts", demoParts, (r) => `id: ${j(r.id)}, brand: ${j(r.brand)}, partNo: ${j(r.partNo)}, wclItemNo: ${j(r.wclItemNo)}, description: null, defaultCoo: null`)}
${ts("demoReceivingOrders", demoReceivingOrders, (r) => `id: ${j(r.id)}, batchNo: ${j(r.batchNo)}, supplierCode: ${j(r.supplierCode)}, deliveryDate: ${d(r.deliveryDate)}, orgId: ${r.orgId}, subInventoryCode: ${j(r.subInventoryCode)}, status: ${j(r.status)}`)}
${ts("demoReceivingInvoices", demoReceivingInvoices, (r) => `id: ${j(r.id)}, receivingOrderId: ${j(r.receivingOrderId)}, invoiceNo: ${j(r.invoiceNo)}, supplierCode: ${j(r.supplierCode)}, wclCompanyName: ${j(r.wclCompanyName)}, totalQty: ${r.totalQty}, totalCtn: ${r.totalCtn}, deliveryDate: ${d(r.deliveryDate)}, orgId: ${r.orgId}`)}
${ts("demoReceivingInvoiceItems", demoReceivingInvoiceItems, (r) => `id: ${j(r.id)}, receivingInvoiceId: ${j(r.receivingInvoiceId)}, partNo: ${j(r.partNo)}, wclItemNo: ${j(r.wclItemNo)}, poNo: ${j(r.poNo)}, poLine: ${j(r.poLine)}, lineQty: ${r.lineQty}, ctnNo: ${j(r.ctnNo)}, dateCode: ${j(r.dateCode)}, lotCode: ${j(r.lotCode)}, coo: ${j(r.coo)}, cow: ${j(r.cow)}, orgId: ${r.orgId}, additionalData: ${j(r.additionalData)}`)}
${ts("demoPickingOrders", demoPickingOrders, (r) => `id: ${j(r.id)}, orderNo: ${j(r.orderNo)}, poNo: ${j(r.poNo)}, deliveryDate: ${d(r.deliveryDate)}, shipTo: ${j(r.shipTo)}, customerCode: ${j(r.customerCode)}, orgId: ${r.orgId}, subInventoryCode: ${j(r.subInventoryCode)}, status: "pending" as const`)}
${ts("demoPickingItems", demoPickingItems, (r) => `id: ${j(r.id)}, pickingOrderId: ${j(r.pickingOrderId)}, partNo: ${j(r.partNo)}, qty: ${r.qty}, lineId: ${r.lineId}, lineNumber: ${r.lineNumber}, shipmentNumber: ${r.shipmentNumber}`)}
${ts("demoShelfBoxes", demoShelfBoxes, (r) => `id: ${j(r.id)}, shelfCode: ${j(r.shelfCode)}, orgId: ${r.orgId}, subInventoryCode: ${j(r.subInventoryCode)}, status: ${j(r.status)}`)}
${ts("demoShelfBoxItems", demoShelfBoxItems, (r) => `id: ${j(r.id)}, shelfBoxId: ${j(r.shelfBoxId)}, partNo: ${j(r.partNo)}, qty: ${r.qty}`)}
${ts("demoLots", demoLots, (r) => `id: ${j(r.id)}, partNo: ${j(r.partNo)}, dateCode: ${j(r.dateCode)}, lotCode: ${j(r.lotCode)}, coo: ${j(r.coo)}, cow: ${j(r.cow)}, shelfCode: ${j(r.shelfCode)}, boxId: ${j(r.boxId)}, orgId: ${r.orgId}, subInventoryCode: ${j(r.subInventoryCode)}, totalQty: ${r.totalQty}`)}`;

writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${demoReceivingOrders.length} receiving orders, ${demoReceivingInvoiceItems.length} items, ${demoPickingOrders.length} picking orders, ${demoLots.length} lots, ${demoParts.length} parts)`);
