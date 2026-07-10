import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuid } from "uuid";

const tnDir = "docs/picking_example/TN";
const files = fs.readdirSync(tnDir).filter((f) => f.endsWith(".pdf")).sort();

function readText(pdfPath) {
  return execSync(`pdftotext "${pdfPath}" -`, { encoding: "utf8" });
}

const orderRows = [];
const itemRows = [];

for (const file of files) {
  const text = readText(path.join(tnDir, file));
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  const refMatch = text.match(/Reference No\.:\s*\n\s*\n\s*(SZ-\d+|GZ-\d+)/);
  const refNo = refMatch ? refMatch[1] : file.replace(".pdf", "");
  const shipTo = refNo.startsWith("SZ") ? "SZ" : "GZ";

  orderRows.push({
    id: uuid(),
    refNo,
    supplierId: "__CODE__:supplierByCode.KOA.id",
    deliveryDate: "__CODE__:new Date('2026-07-13')",
    poNo: null,
    requiredDateCodeNotice: null,
    shipTo,
    destinationCountry: "China",
    status: "pending",
    arrivedAt: null,
    arrivedBy: null,
    createdAt: "__CODE__:now",
    updatedAt: "__CODE__:now",
  });

  const items = [];
  const qtys = [];
  let inQuantity = false;

  for (const line of lines) {
    if (line === "Quantity") {
      inQuantity = true;
      continue;
    }
    if (inQuantity) {
      const qm = line.match(/^\d{1,3}(,\d{3})*$/);
      if (qm) qtys.push(parseInt(line.replace(/,/g, ""), 10));
      continue;
    }
    const m = line.match(/^(\d+)\s+([0-9A-Z]+)\s+([0-9.]+)\s+KOA\+([A-Z0-9]+)\s+([A-Z0-9]+)\s+([A-Z]+)/);
    if (m) {
      items.push({ poNo: m[2], poLine: m[3], partNo: m[4] + m[5] });
    }
  }

  const byPart = new Map();
  for (let i = 0; i < items.length; i++) {
    const partNo = items[i].partNo;
    byPart.set(partNo, (byPart.get(partNo) || 0) + (qtys[i] || 0));
  }

  for (const [partNo, qty] of byPart) {
    itemRows.push({
      id: uuid(),
      pickingOrderId: `__CODE__:pickingOrderByRef['${refNo}'].id`,
      partId: `__CODE__:wclPartByNo['${partNo}'].id`,
      qty,
      pickedQty: 0,
      allocatedQty: 0,
      requiredDateCode: null,
      sourceShelfCode: null,
    });
  }
}

function serialize(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/"([^"]+)":/g, "$1:")
    .replace(/"__CODE__:([^"]+)"/g, "$1")
    .replace(/"/g, "'");
}

console.log(`// Picking orders (${orderRows.length})`);
console.log(`const pickingOrderRecords = ${serialize(orderRows)} as const;`);
console.log(`const pickingOrderByRef = Object.fromEntries(pickingOrderRecords.map((po) => [po.refNo, po])) as Record<`);
console.log(`  (typeof pickingOrderRecords)[number]["refNo"],`);
console.log(`  (typeof pickingOrderRecords)[number]`);
console.log(`>;`);
console.log();
console.log(`// Picking items (${itemRows.length})`);
console.log(`const pickingItemRecords = ${serialize(itemRows)} as const;`);
