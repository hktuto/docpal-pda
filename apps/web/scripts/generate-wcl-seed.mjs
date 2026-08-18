import { execSync } from "node:child_process";
import { v4 as uuid } from "uuid";

const hkPath = "docs/receiving example/WCL HK.xlsx";
const mcoPath = "docs/receiving example/WCL MCO.xlsx";

function readJson(path) {
  const stdout = execSync(`npx xlsx-cli -j "${path}"`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  return JSON.parse(stdout);
}

const hk = readJson(hkPath);
const mco = readJson(mcoPath);
const all = [...hk, ...mco];

const receivingOrderRef = "04958166";
const coo = "CN";
const cow = "USA";

const partNos = [...new Set(all.map((r) => r["KOA ITEM CODE"]))].sort();
const wclPartRecords = partNos.map((partNo) => ({
  id: uuid(),
  partNo,
  internalCode: "",
  description: "",
}));
const wclPartByNo = Object.fromEntries(wclPartRecords.map((p) => [p.partNo, p]));

const wclReceivingOrderId = 'b55df3d8-bd2a-43d5-80fa-616a7058439a';

const invoiceNos = [...new Set(all.map((r) => r["INVOICE NO."]))].sort();
const wclInvoiceRecords = invoiceNos.map((invoiceNo) => ({
  id: uuid(),
  receivingOrderId: "__CODE__:wclReceivingOrder.id",
  invoiceNo,
  supplierId: "__CODE__:supplierByCode.KOA.id",
}));
const wclInvoiceByNo = Object.fromEntries(wclInvoiceRecords.map((inv) => [inv.invoiceNo, inv]));

const wclReceivingInvoiceItemRecords = all.map((r) => ({
  id: uuid(),
  receivingInvoiceId: wclInvoiceByNo[r["INVOICE NO."]].id,
  partId: wclPartByNo[r["KOA ITEM CODE"]].id,
  poNo: r["P/O NO."],
  poLine: String(r["P/O LINE"]),
  qty: r["QTY"],
  receivedQty: 0,
  pickedQty: 0,
  putAwayQty: 0,
  boxId: r["CARTON NO."],
  dateCode: "",
  lotCode: "",
  coo,
  cow,
}));

function serialize(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/"([^"]+)":/g, "$1:")
    .replace(/"__CODE__:([^"]+)"/g, "$1")
    .replace(/"/g, "'");
}

console.log("// WCL parts");
console.log(`const wclPartRecords = ${serialize(wclPartRecords)} as const;`);
console.log(`const wclPartByNo = Object.fromEntries(wclPartRecords.map((p) => [p.partNo, p])) as Record<`);
console.log(`  (typeof wclPartRecords)[number]["partNo"],`);
console.log(`  (typeof wclPartRecords)[number]`);
console.log(`>;`);
console.log();
console.log("// WCL receiving order");
console.log(`const wclReceivingOrder = ${serialize({
  id: wclReceivingOrderId,
  refNo: receivingOrderRef,
  supplierId: "__CODE__:supplierByCode.KOA.id",
  deliveryDate: "__CODE__:new Date('2026-07-10')",
  status: "pending",
  arrivedAt: null,
  arrivedBy: null,
  createdAt: "__CODE__:now",
  updatedAt: "__CODE__:now",
})} as const;`);
console.log();
console.log("// WCL invoices");
console.log(`const wclInvoiceRecords = ${serialize(wclInvoiceRecords)} as const;`);
console.log(`const wclInvoiceByNo = Object.fromEntries(wclInvoiceRecords.map((inv) => [inv.invoiceNo, inv])) as Record<`);
console.log(`  (typeof wclInvoiceRecords)[number]["invoiceNo"],`);
console.log(`  (typeof wclInvoiceRecords)[number]`);
console.log(`>;`);
console.log();
console.log("// WCL receiving invoice items");
console.log(`const wclReceivingInvoiceItemRecords = ${serialize(wclReceivingInvoiceItemRecords)};`);
