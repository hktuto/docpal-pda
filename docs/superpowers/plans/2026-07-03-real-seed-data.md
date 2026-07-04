# Real Supplier Seed Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synthetic seed data in `db/seed.ts` with real supplier, part, and order data extracted from `docs/Supplier Sample Documents/`, producing a coherent demo dataset: 2–3 receiving orders total, 3–6 picking orders total, and pre-existing shelf inventory for non-selected suppliers.

**Architecture:** A temporary Node extraction script reads PDFs/Excel/CSV files, dumps a structured JSON summary, and the seed file is hand-curated from that summary. The existing `allocatePickingOrder()` helper is reused to create inventory lots, sources, and allocations exactly like the current seed.

**Tech Stack:** Node.js (ESM), `pdf-parse`, `xlsx`, `csv-parse`, Nuxt 3, PGlite, Drizzle ORM.

---

## File Structure

- `scripts/extract-seed-data.mjs` — temporary extraction script (created, then removed).
- `scripts/seed-extraction-summary.json` — generated summary of suppliers, parts, invoices, and line items (created, then removed).
- `db/seed.ts` — main seed file to rewrite with real data.

---

### Task 1: Add extraction dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install temporary extraction packages as dev dependencies**

Run:

```bash
pnpm add -D pdf-parse xlsx csv-parse
```

Expected: packages added to `devDependencies` in `package.json` and `pnpm-lock.yaml`.

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add extraction dependencies for seed data update"
```

---

### Task 2: Write the extraction script

**Files:**
- Create: `scripts/extract-seed-data.mjs`

- [ ] **Step 1: Create the script**

```javascript
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pdfParse from "pdf-parse";
import * as xlsx from "xlsx";
import { parse } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../docs/Supplier Sample Documents");
const OUT = path.resolve(__dirname, "seed-extraction-summary.json");

const SKIP = new Set([".ds_store", "thumbs.db"]);

async function readPdf(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    return { text: data.text, pages: data.numpages };
  } catch (e) {
    return { text: "", pages: 0, error: e.message };
  }
}

function readXlsx(filePath) {
  try {
    const wb = xlsx.readFile(filePath);
    const sheets = {};
    for (const name of wb.SheetNames) {
      sheets[name] = xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
    }
    return { sheets };
  } catch (e) {
    return { sheets: {}, error: e.message };
  }
}

function readCsv(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    const rows = parse(text, { columns: false, skip_empty_lines: true });
    return { rows };
  } catch (e) {
    return { rows: [], error: e.message };
  }
}

function baseNameNoExt(name) {
  return path.basename(name, path.extname(name));
}

async function main() {
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  const suppliers = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const supplierName = entry.name;
    const supplierCode = supplierName
      .split(/[-\s]/)[0]
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);

    const supplierDir = path.join(ROOT, supplierName);
    const files = await fs.readdir(supplierDir, { recursive: true, withFileTypes: true });
    const documents = [];

    for (const file of files) {
      if (!file.isFile()) continue;
      const relPath = path.relative(supplierDir, path.join(file.parentPath, file.name));
      const lower = file.name.toLowerCase();
      if (SKIP.has(lower)) continue;
      if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png")) continue;

      const fullPath = path.join(file.parentPath, file.name);
      const ext = path.extname(lower);
      let extracted = { type: "unknown", raw: null };

      if (ext === ".pdf") extracted = { type: "pdf", ...(await readPdf(fullPath)) };
      else if (ext === ".xlsx" || ext === ".xls") extracted = { type: "xlsx", ...(readXlsx(fullPath)) };
      else if (ext === ".csv") extracted = { type: "csv", ...(readCsv(fullPath)) };

      documents.push({
        fileName: file.name,
        relativePath: relPath,
        extracted,
      });
    }

    suppliers.push({
      name: supplierName,
      code: supplierCode,
      documents,
    });
  }

  // Simple de-duplication of supplier codes
  const seen = new Set();
  for (const s of suppliers) {
    let code = s.code;
    let suffix = 1;
    while (seen.has(code)) {
      code = `${s.code.slice(0, 4)}${suffix}`;
      suffix++;
    }
    seen.add(code);
    s.code = code;
  }

  await fs.writeFile(OUT, JSON.stringify({ suppliers }, null, 2));
  console.log(`Wrote summary to ${OUT}`);
  console.log(`Suppliers: ${suppliers.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/extract-seed-data.mjs
git commit -m "chore: add seed data extraction script"
```

---

### Task 3: Run extraction and review output

**Files:**
- Create: `scripts/seed-extraction-summary.json`

- [ ] **Step 1: Run the extraction script**

```bash
node scripts/extract-seed-data.mjs
```

Expected: `scripts/seed-extraction-summary.json` is created and contains 25 suppliers with their documents and extracted text/tables.

- [ ] **Step 2: Review the summary and identify usable data**

Open `scripts/seed-extraction-summary.json` and for each supplier note:
- Real supplier name and derived code.
- Document(s) with readable line items.
- Part numbers and quantities that can be used for receiving items or shelf inventory.

Pick **2–3 suppliers** with the clearest documents to create receiving orders. The remaining suppliers contribute parts to pre-existing shelf inventory.

- [ ] **Step 3: Commit the raw summary (optional, can be removed later)**

```bash
git add scripts/seed-extraction-summary.json
git commit -m "chore: add raw seed extraction summary"
```

---

### Task 4: Curate extraction output into seed records

**Files:**
- Create: a temporary scratch file (e.g., `scripts/seed-curation.md`) for notes.

- [ ] **Step 1: Document curated choices**

From `scripts/seed-extraction-summary.json`, produce a concise curation note containing:

```markdown
# Seed Curation

## Selected receiving-order suppliers
1. SUPPLIER_CODE_A — document "INV-XXXX.pdf" — parts: PART-A1, PART-A2, ...
2. SUPPLIER_CODE_B — document "PL-YYYY.pdf" — parts: PART-B1, PART-B2, ...
3. (optional) SUPPLIER_CODE_C — document ...

## Pre-existing shelf inventory parts (from remaining suppliers)
- SUPPLIER_CODE_D: PART-D1, PART-D2
- ...

## Picking orders
- PO-001: PART-A1 x QTY, PART-D1 x QTY
- ...
```

- [ ] **Step 2: Decide defaults for missing fields**

For any missing `coo`, use the supplier’s region default (JP/CN/US/etc.) or `"XX"`.
For any missing `description`, use `""`.

- [ ] **Step 3: Commit curation notes**

```bash
git add scripts/seed-curation.md
git commit -m "docs: seed data curation notes"
```

---

### Task 5: Replace suppliers in `db/seed.ts`

**Files:**
- Modify: `db/seed.ts`

- [ ] **Step 1: Replace the synthetic `supplierRecords` array**

Keep the existing pattern but use real supplier names and derived codes from the curation notes:

```typescript
const supplierRecords = [
  { id: uuid(), code: "ABLIC", name: "ABLIC" },
  { id: uuid(), code: "DAITO", name: "DAITO" },
  // ... one entry per supplier folder
] as const;
```

- [ ] **Step 2: Run type check**

```bash
pnpm nuxt prepare
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add db/seed.ts
git commit -m "feat: seed real supplier records"
```

---

### Task 6: Replace parts in `db/seed.ts`

**Files:**
- Modify: `db/seed.ts`

- [ ] **Step 1: Replace the synthetic `partRecords` array**

Use real part numbers extracted from the documents. Example pattern:

```typescript
const partRecords = [
  { id: uuid(), partNo: "REAL-PART-001", internalCode: "SUP-INTERNAL-001", description: "", defaultCoo: "JP" },
  // ... all distinct parts used in receiving orders or shelf inventory
] as const;
```

- [ ] **Step 2: Run type check**

```bash
pnpm nuxt prepare
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add db/seed.ts
git commit -m "feat: seed real part records"
```

---

### Task 7: Add real receiving orders and invoices

**Files:**
- Modify: `db/seed.ts`

- [ ] **Step 1: Replace `receivingOrderRecords` and `invoiceRecords`**

Create exactly 2–3 receiving orders, each from a different selected supplier. Each order gets one invoice and 2–5 line items:

```typescript
const receivingOrderRecords = [
  {
    id: uuid(),
    refNo: "RO-260703-001", // or real document number if readable
    supplierId: supplierByCode.ABLIC.id,
    deliveryDate: now,
    status: "in_hand" as const,
    arrivedAt: now,
    arrivedBy: userOperator.id,
    createdAt: now,
    updatedAt: now,
  },
  // ... 1–2 more orders, at least one with status "pending"
] as const;
```

```typescript
const invoiceRecords = [
  { id: uuid(), receivingOrderId: receivingOrderByRef["RO-260703-001"].id, invoiceNo: "REAL-INV-001", supplierId: supplierByCode.ABLIC.id },
  // ...
] as const;
```

- [ ] **Step 2: Replace `receivingInvoiceItemRecords`**

Each invoice gets 2–5 items using real part numbers and quantities from the extracted documents:

```typescript
const receivingInvoiceItemRecords = [
  {
    id: uuid(),
    receivingInvoiceId: invoiceByNo["REAL-INV-001"].id,
    partId: partByNo["REAL-PART-001"].id,
    poNo: "PO-ABLIC-260703-001",
    poLine: "1",
    qty: 1000,
    receivedQty: 1000,
    pickedQty: 0,
    putAwayQty: 0,
    boxId: null as string | null,
    dateCode: null as string | null,
    lotCode: null as string | null,
    coo: "JP",
    cow: "USA",
    reportedMismatch: false,
    mismatchNote: null as string | null,
  },
  // ... more items
] as const;
```

- [ ] **Step 3: Run type check**

```bash
pnpm nuxt prepare
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add db/seed.ts
git commit -m "feat: seed real receiving orders, invoices, and items"
```

---

### Task 8: Add pre-existing shelf inventory

**Files:**
- Modify: `db/seed.ts`

- [ ] **Step 1: Expand shelves if needed**

Ensure the `shelfRecords` array has enough locations. Add zone C if necessary:

```typescript
const shelfRecords = [
  { code: "A-01-01", zone: "A" },
  { code: "A-01-02", zone: "A" },
  { code: "A-02-01", zone: "A" },
  { code: "A-02-02", zone: "A" },
  { code: "B-01-01", zone: "B" },
  { code: "B-02-01", zone: "B" },
  { code: "B-02-02", zone: "B" },
  { code: "C-01-01", zone: "C" },
  { code: "C-01-02", zone: "C" },
] as const;
```

- [ ] **Step 2: Insert `inventoryLots` for non-receiving parts**

After the existing shelved-lots pattern, add inventory lots for parts from suppliers not selected for receiving orders:

```typescript
const preExistingLots = [
  {
    id: uuid(),
    partId: partByNo["REAL-PART-FROM-SHELF-001"].id,
    dateCode: "2606",
    lotCode: "L260601",
    coo: "JP",
    cow: "USA",
    shelfCode: "B-01-01",
    boxId: null,
    totalQty: 5000,
    allocatedQty: 0,
  },
  // ... more pre-existing lots
] as const;

await db.insert(schema.inventoryLots).values([...shelvedLots, ...preExistingLots].map((lot) => ({ ...lot })));
```

- [ ] **Step 3: Run type check**

```bash
pnpm nuxt prepare
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add db/seed.ts
git commit -m "feat: seed pre-existing shelf inventory"
```

---

### Task 9: Add real picking orders and items

**Files:**
- Modify: `db/seed.ts`

- [ ] **Step 1: Replace `pickingOrderRecords`**

Create 3–6 picking orders total, referencing real suppliers and parts:

```typescript
const pickingOrderRecords = [
  {
    id: uuid(),
    refNo: "TN-260703-001",
    supplierId: supplierByCode.ABLIC.id,
    deliveryDate: now,
    poNo: "SO-260703-001",
    requiredDateCodeNotice: null as string | null,
    shipTo: "US",
    destinationCountry: "USA",
    status: "pending" as const,
    createdAt: now,
    updatedAt: now,
  },
  // ... more orders
] as const;
```

- [ ] **Step 2: Replace `pickingItemRecords`**

Each picking order has 1–4 lines. Quantities must be covered by receiving items or pre-existing inventory:

```typescript
const pickingItemRecords = [
  {
    id: uuid(),
    pickingOrderId: pickingOrderByRef["TN-260703-001"].id,
    partId: partByNo["REAL-PART-001"].id,
    qty: 200,
    pickedQty: 0,
    allocatedQty: 0,
    requiredDateCode: null,
    sourceShelfCode: null as string | null,
  },
  // ... more items
] as const;
```

- [ ] **Step 3: Run type check**

```bash
pnpm nuxt prepare
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add db/seed.ts
git commit -m "feat: seed real picking orders and items"
```

---

### Task 10: Run allocations

**Files:**
- Modify: `db/seed.ts`

- [ ] **Step 1: Call `allocatePickingOrder` for each picking order**

```typescript
for (const po of pickingOrderRecords) {
  await allocatePickingOrder(db, po.id);
}
```

- [ ] **Step 2: Run type check**

```bash
pnpm nuxt prepare
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add db/seed.ts
git commit -m "feat: allocate seeded picking orders"
```

---

### Task 11: Verify in browser

**Files:**
- None (manual verification).

- [ ] **Step 1: Start the dev server**

```bash
pnpm dev
```

- [ ] **Step 2: Clear IndexedDB and reload**

Open the app in a private browser window, log in as `operator` / `DocPal2026!`, and confirm:

- Receiving list shows 2–3 orders total, each from a real supplier.
- Each receiving order has 2–5 line items.
- Picking list shows 3–6 orders total.
- Allocation succeeds for in-stock picking orders.
- Measuring tasks appear for allocated picking orders.

- [ ] **Step 3: Fix any issues and commit**

```bash
git add db/seed.ts
git commit -m "fix: adjust seed data after browser verification"
```

---

### Task 12: Clean up extraction scaffolding

**Files:**
- Delete: `scripts/extract-seed-data.mjs`
- Delete: `scripts/seed-extraction-summary.json`
- Delete: `scripts/seed-curation.md`

- [ ] **Step 1: Remove temporary files**

```bash
rm scripts/extract-seed-data.mjs scripts/seed-extraction-summary.json scripts/seed-curation.md
```

- [ ] **Step 2: Optionally remove extraction dependencies**

If the packages are no longer needed:

```bash
pnpm remove pdf-parse xlsx csv-parse
```

- [ ] **Step 3: Final type check**

```bash
pnpm nuxt prepare
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml scripts/ db/seed.ts
git commit -m "chore: remove seed extraction scaffolding"
```

---

## Self-Review

**Spec coverage:**
- All 25 suppliers seeded: Task 5.
- 2–3 receiving orders total, 2–5 items each: Task 7.
- 3–6 picking orders total: Task 9.
- Pre-existing shelf inventory for non-selected suppliers: Task 8.
- Label images ignored: extraction script skips image files in Task 2.
- Allocation via existing helper: Task 10.
- Verification steps: Task 11.

**Placeholder scan:**
- No TBD/TODO placeholders.
- Seed data values are intentionally shown as examples; the plan instructs the implementer to fill them from the extraction summary and curation notes.

**Type consistency:**
- `supplierByCode`, `partByNo`, `receivingOrderByRef`, `invoiceByNo`, and `pickingOrderByRef` helpers match the existing seed patterns.
- `as const` + `Object.fromEntries` typing pattern is preserved from the original `db/seed.ts`.
