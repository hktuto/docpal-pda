# Picking Order Seed Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace synthetic picking orders and legacy seed data with 23 real picking orders from the TN PDFs, keeping only receiving order `04958166`.

**Architecture:** A temporary helper script extracts picking orders and aggregated items from the TN PDFs and emits TypeScript arrays. A second patch script edits `db/seed.ts` to remove legacy data and insert the new arrays.

**Tech Stack:** Node.js, `pdftotext`, TypeScript, Drizzle ORM/PGlite, Nuxt 3.

---

## Files

- **Create:** `scripts/generate-picking-seed.mjs` — extracts data from TN PDFs and emits `pickingOrderRecords` / `pickingItemRecords` arrays.
- **Create:** `scripts/apply-picking-seed.mjs` — patches `db/seed.ts` to remove legacy blocks and insert the generated arrays.
- **Modify:** `db/seed.ts` — final seed file after patch.

---

### Task 1: Create the TN picking seed generator

**Files:**
- Create: `scripts/generate-picking-seed.mjs`

- [ ] **Step 1: Write the helper script**

Create `scripts/generate-picking-seed.mjs`:

```js
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
      pickingOrderId: `__CODE__:pickingOrderByRef["${refNo}"].id`,
      partId: `__CODE__:wclPartByNo["${partNo}"].id`,
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
```

- [ ] **Step 2: Run the script and capture output**

```bash
node scripts/generate-picking-seed.mjs > scripts/picking-seed-output.ts
```

Expected: `scripts/picking-seed-output.ts` contains `pickingOrderRecords`, `pickingOrderByRef`, and `pickingItemRecords`.

- [ ] **Step 3: Commit the helper script**

```bash
git add scripts/generate-picking-seed.mjs
git commit -m "chore: add TN picking seed generator"
```

---

### Task 2: Patch `db/seed.ts`

**Files:**
- Create: `scripts/apply-picking-seed.mjs`
- Modify: `db/seed.ts`

- [ ] **Step 1: Write the patch script**

Create `scripts/apply-picking-seed.mjs`:

```js
import fs from "node:fs";

const seedPath = "db/seed.ts";
const outputPath = "scripts/picking-seed-output.ts";

let seed = fs.readFileSync(seedPath, "utf8");
const output = fs.readFileSync(outputPath, "utf8");

const pickingBlock = output.match(/\/\/ Picking orders[\s\S]*/)?.[0];
if (!pickingBlock) throw new Error("Could not extract picking block");

// 1. Remove legacy receiving orders/invoices/items/mismatches.
seed = seed.replace(
  /  \/\/ Receiving orders\n[\s\S]*?await db\.insert\(schema\.receivingItemMismatches\)\.values\(\[[\s\S]*?\]\);\n/,
  ""
);

// 2. Remove pre-existing shelf lots/boxes/scans.
seed = seed.replace(
  /  \/\/ Pre-existing shelf inventory[\s\S]*?\]\);\n  \/\/ Pre-existing shelf boxes[\s\S]*?\]\);\n  await db\.insert\(schema\.putAwayScans\)\.values\(\[[\s\S]*?\]\);\n/,
  ""
);

// 3. Replace old picking block with new one.
seed = seed.replace(
  /  \/\/ Note: in-hand receiving orders intentionally[\s\S]*?for \(const po of pickingOrderRecords\) \{\n    await allocatePickingOrder\(db, po\.id\);\n  \}\n/,
  `${pickingBlock}\n\n  await db.insert(schema.pickingOrders).values([...pickingOrderRecords]);\n  await db.insert(schema.pickingItems).values([...pickingItemRecords]);\n\n  for (const po of pickingOrderRecords) {\n    await allocatePickingOrder(db, po.id);\n  }\n`
);

fs.writeFileSync(seedPath, seed);
console.log("Updated db/seed.ts");
```

- [ ] **Step 2: Run the patch script**

```bash
node scripts/apply-picking-seed.mjs
```

- [ ] **Step 3: Clean up temporary files and commit**

```bash
rm scripts/picking-seed-output.ts scripts/apply-picking-seed.mjs
git add db/seed.ts scripts/
git commit -m "feat: replace picking seed with 23 TN-based orders and clean legacy data"
```

---

### Task 3: Verify TypeScript and tests

**Files:**
- Verify: `db/seed.ts`

- [ ] **Step 1: Run type generation**

```bash
pnpm nuxt prepare
```

Expected: exits with code 0.

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 3: Manual browser spot-check**

1. Clear IndexedDB or use a private window.
2. Run `pnpm dev`.
3. Log in as `operator` / `DocPal2026!`.
4. Confirm:
   - Receiving list shows only `04958166`.
   - Picking list shows 23 orders (`SZ-26070040`–`SZ-26070052`,
     `GZ-26070045`–`GZ-26070054`).

---

## Self-review checklist

- [x] Spec coverage: cleanup, new picking orders/items, and verification are covered.
- [x] No placeholders: each step contains exact file paths and code.
- [x] Type consistency: generated arrays match existing seed record shapes.
