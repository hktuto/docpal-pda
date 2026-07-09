import fs from "node:fs";

const seedPath = "db/seed.ts";
const pickingOutputPath = "scripts/picking-seed-output.ts";

let seed = fs.readFileSync(seedPath, "utf8");
const pickingOutput = fs.readFileSync(pickingOutputPath, "utf8");

// 1. Remove legacy receiving invoice items and mismatches, keep WCL items.
const legacyItemsStart = seed.indexOf("  const receivingInvoiceItemRecords = [");
const wclItemsStart = seed.indexOf("const wclReceivingInvoiceItemRecords = [");
if (legacyItemsStart === -1 || wclItemsStart === -1) {
  throw new Error("Could not locate legacy or WCL receiving invoice items");
}
seed = seed.slice(0, legacyItemsStart) + seed.slice(wclItemsStart);

// 2. Change receiving invoice items insert to only WCL items.
seed = seed.replace(
  "  await db.insert(schema.receivingInvoiceItems).values([\n    ...receivingInvoiceItemRecords,\n    ...wclReceivingInvoiceItemRecords,\n  ]);",
  "  await db.insert(schema.receivingInvoiceItems).values([...wclReceivingInvoiceItemRecords]);"
);

// 3. Replace old picking block with new one.
const pickingStartMarker = "  // Note: in-hand receiving orders intentionally do NOT create inventory_lots here.\n  // Allocations are made against receiving_invoice_items directly.\n\n  const pickingOrderRecords = [";
const pickingEndMarker = "  for (const po of pickingOrderRecords) {\n    await allocatePickingOrder(db, po.id);\n  }\n}";
const pickingStart = seed.indexOf(pickingStartMarker);
const pickingEnd = seed.indexOf(pickingEndMarker, pickingStart);
if (pickingStart === -1 || pickingEnd === -1) throw new Error("Could not locate picking block");

seed =
  seed.slice(0, pickingStart) +
  "  // Picking orders from TN PDFs\n\n" +
  pickingOutput +
  "\n\n  await db.insert(schema.pickingOrders).values([...pickingOrderRecords]);\n" +
  "  await db.insert(schema.pickingItems).values([...pickingItemRecords]);\n\n" +
  "  for (const po of pickingOrderRecords) {\n    await allocatePickingOrder(db, po.id);\n  }\n}" +
  seed.slice(pickingEnd + pickingEndMarker.length - 1);

fs.writeFileSync(seedPath, seed);
console.log("Patched db/seed.ts");
