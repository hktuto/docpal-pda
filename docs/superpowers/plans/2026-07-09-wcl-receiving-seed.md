# WCL Receiving Order Seed Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the real WCL receiving order (`04958166`) from `docs/receiving example/` to `db/seed.ts` while preserving all existing seed data.

**Architecture:** A temporary helper script reads the two Excel files, extracts distinct parts and carton-level invoice items, resolves cross-references with generated UUIDs, and emits a single TypeScript snippet. The snippet is pasted into `db/seed.ts` at the correct insertion points.

**Tech Stack:** Node.js, `xlsx-cli` (via `npx`), TypeScript, Drizzle ORM/PGlite, Nuxt 3.

---

## Files

- **Create:** `scripts/generate-wcl-seed.mjs` — one-time helper that reads the Excel files and prints a ready-to-paste TypeScript snippet.
- **Modify:** `db/seed.ts` — insert generated parts, receiving order, invoices, and items without removing existing records.

---

### Task 1: Create the WCL seed generator script

**Files:**
- Create: `scripts/generate-wcl-seed.mjs`

- [ ] **Step 1: Write the helper script**

Create `scripts/generate-wcl-seed.mjs`:

```js
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

function parseExcelDate(serial) {
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

const deliveryDate = parseExcelDate(all[0]["DELIVERY DATE"]);
const receivingOrderRef = "04958166";
const supplierCode = "KOA";
const coo = "CN";
const cow = "USA";

const partNos = [...new Set(all.map((r) => r["KOA ITEM CODE"]))].sort();
const wclPartRecords = partNos.map((partNo) => ({
  id: uuid(),
  partNo,
  internalCode: "",
  description: "",
  defaultCoo: coo,
}));
const wclPartByNo = Object.fromEntries(wclPartRecords.map((p) => [p.partNo, p]));

const wclReceivingOrderId = uuid();

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
  deliveryDate,
  status: "pending",
  arrivedAt: null,
  arrivedBy: null,
  createdAt: "now",
  updatedAt: "now",
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
```

- [ ] **Step 2: Run the script and capture output**

Run:

```bash
node scripts/generate-wcl-seed.mjs > scripts/wcl-seed-output.ts
```

Expected: `scripts/wcl-seed-output.ts` contains the generated arrays.

- [ ] **Step 3: Commit the helper script**

```bash
git add scripts/generate-wcl-seed.mjs
git commit -m "chore: add WCL seed generator script"
```

---

### Task 2: Update `db/seed.ts` with the generated data

**Files:**
- Modify: `db/seed.ts`

- [ ] **Step 1: Insert WCL parts alongside existing parts**

Replace the existing parts insert block:

```ts
await db.insert(schema.parts).values([...partRecords]);
```

with:

```ts
const wclPartRecords = [
  // paste from scripts/wcl-seed-output.ts
] as const;
await db.insert(schema.parts).values([...partRecords, ...wclPartRecords]);

const partByNo = Object.fromEntries(partRecords.map((p) => [p.partNo, p])) as Record<
  (typeof partRecords)[number]["partNo"],
  (typeof partRecords)[number]
>;
const wclPartByNo = Object.fromEntries(wclPartRecords.map((p) => [p.partNo, p])) as Record<
  (typeof wclPartRecords)[number]["partNo"],
  (typeof wclPartRecords)[number]
>;
```

Keep the existing `partByNo` definition; add `wclPartByNo` immediately after it.

- [ ] **Step 2: Insert the WCL receiving order alongside existing orders**

Replace:

```ts
await db.insert(schema.receivingOrders).values([...receivingOrderRecords]);
```

with:

```ts
const wclReceivingOrder = {
  id: uuid(),
  refNo: "04958166",
  supplierId: supplierByCode.KOA.id,
  deliveryDate: new Date("2026-07-10"),
  status: "pending" as const,
  arrivedAt: null as Date | null,
  arrivedBy: null as string | null,
  createdAt: now,
  updatedAt: now,
};

await db.insert(schema.receivingOrders).values([...receivingOrderRecords, wclReceivingOrder]);
```

- [ ] **Step 3: Insert WCL invoices alongside existing invoices**

Replace:

```ts
await db.insert(schema.receivingInvoices).values([...invoiceRecords]);
```

with:

```ts
const wclInvoiceRecords = [
  // paste from scripts/wcl-seed-output.ts
] as const;

await db.insert(schema.receivingInvoices).values([...invoiceRecords, ...wclInvoiceRecords]);
const wclInvoiceByNo = Object.fromEntries(wclInvoiceRecords.map((inv) => [inv.invoiceNo, inv])) as Record<
  (typeof wclInvoiceRecords)[number]["invoiceNo"],
  (typeof wclInvoiceRecords)[number]
>;
```

- [ ] **Step 4: Insert WCL items alongside existing items**

Before the existing:

```ts
await db.insert(schema.receivingInvoiceItems).values(receivingInvoiceItemRecords);
```

add the WCL items array:

```ts
const wclReceivingInvoiceItemRecords = [
  // paste from scripts/wcl-seed-output.ts
];
```

Then change the insert to:

```ts
await db.insert(schema.receivingInvoiceItems).values([
  ...receivingInvoiceItemRecords,
  ...wclReceivingInvoiceItemRecords,
]);
```

- [ ] **Step 5: Commit the seed update**

```bash
git add db/seed.ts
git commit -m "feat: add WCL receiving order seed data"
```

---

### Task 3: Verify TypeScript and seed integrity

**Files:**
- Verify: `db/seed.ts`

- [ ] **Step 1: Run type generation**

```bash
pnpm nuxt prepare
```

Expected: command exits with code 0 and no TypeScript errors.

- [ ] **Step 2: Clean up scaffolding**

Delete `scripts/wcl-seed-output.ts` (it was temporary):

```bash
rm scripts/wcl-seed-output.ts
git add scripts/
git commit -m "chore: remove temporary WCL seed output file"
```

- [ ] **Step 3: Manual browser verification**

1. Clear the browser's IndexedDB or open a private window.
2. Run `pnpm dev`.
3. Log in as `operator` / `DocPal2026!`.
4. Open the receiving list and confirm:
   - `04958166` appears with status `pending`.
   - Existing orders (`04958058-W-01`, `1080082369`, `52600142`) are still present.
5. Open `04958166` detail and confirm:
   - 16 invoice sections (`W-01` through `W-16`).
   - Carton-level line items with carton numbers in the PO line display.

---

## Self-review checklist

- [x] Spec coverage: every requirement from the design spec has a corresponding task.
- [x] No placeholders: each step contains exact file paths and code.
- [x] Type consistency: generated arrays use the same shape as existing seed records.
- [x] Existing data preserved: the plan appends new records rather than replacing old ones.
