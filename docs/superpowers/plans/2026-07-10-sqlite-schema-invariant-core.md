# SQLite Schema + Invariant Core (Plan 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `apps/api` SQLite schema and the quantity-maintenance invariant core that every later slice (allocation, ingestion, tasks, cutover) will compose — with proof the maintained columns never drift.

**Architecture:** A `sqlite-core` Drizzle schema split by domain under `src/db/schema/`, opened via a `createDb()` factory that sets WAL/busy_timeout/synchronous=NORMAL/foreign_keys. Quantity changes only happen through the mutation primitives in `src/db/invariants.ts`, each of which mutates source rows and then **recomputes the affected maintained columns from source inside the same transaction**. Same-row values (`inventory_lots.available_qty`, `picking_items.remaining_qty`) are `STORED GENERATED`. A seeded randomized property test drives the primitives and asserts every maintained column equals its re-derived-from-source value after each op.

**Tech Stack:** Node, TypeScript (NodeNext, explicit `.js` import extensions), `better-sqlite3`, `drizzle-orm@0.45` (`drizzle-orm/better-sqlite3` + `drizzle-orm/sqlite-core`), `node:test` via `tsx --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-db-schema-rethink-design.md` (this plan implements §3–§6 and the invariant parts of §5/§12; allocation, upsert, tasks, and cutover are later plans).

---

## Conventions (apply to every task)

- Package: `@warehouse/api` (`apps/api`). Run commands as `pnpm --filter @warehouse/api …` from the repo root.
- Relative imports **must** use the `.js` extension (NodeNext): `import { x } from "./normalize.js"`.
- All timestamps are ISO-8601 UTC text via `now()` (Task 1b). `updated_at` is set on every write.
- Every FK is indexed. Every business key used for upsert is `UNIQUE`.

> **Convention correction (added during execution, Task 4 review).** The "every FK is indexed" rule was under-applied in the schema code blocks below. The following FK indexes ARE required and must be present in the implemented files and in the Task 10 DDL, in addition to what the literal code blocks show:
> - `receiving_orders(supplier_id)` → `receiving_orders_supplier_idx`
> - `receiving_invoices(supplier_id)` → `receiving_invoices_supplier_idx`
> - `shelf_box_items(part_id)` → `shelf_box_items_part_idx`
> - `verification_tasks(picking_order_id)` → `verification_tasks_picking_order_idx`
> - `verification_tasks(shelf_box_id)` → `verification_tasks_shelf_box_idx`
>
> Implementers and reviewers for Tasks 6, 8, and 10 must treat these as part of the task. (Task 4 was corrected in-place when this was caught.)
- Test runner: `node:test`. Single file: `pnpm --filter @warehouse/api exec tsx --test <path>`. Full suite: `pnpm --filter @warehouse/api test`.
- **Environment note (Windows + Git Bash):** the `pnpm …` `.cmd` shims cannot find `node` when spawned directly from Git Bash (`'node' is not recognized`). Prefix every verification command with `cmd.exe //c` so it runs in a fresh `cmd` that has `node` on PATH, e.g. `cmd.exe //c "pnpm --filter @warehouse/api build"` and `cmd.exe //c "pnpm --filter @warehouse/api test"`. The `package.json` scripts themselves are correct for normal shells/CI — do not change them for this.
- Commit after each task with `git add <explicit paths>` (never `git add -A`).

## File structure (Plan 1)

- Create `src/db/now.ts` — `now(): string` ISO-8601 UTC timestamp helper.
- Create `src/db/schema/normalize.ts` — pure OCR normalization (`normalizePartNo`, `normalizeCode`, `normalizePlain`, nullable wrappers).
- Create `src/db/schema/master.ts` — `users`, `suppliers`, `parts`, `shelves`.
- Create `src/db/schema/receiving.ts` — `receivingOrders`, `receivingInvoices`, `receivingInvoiceItems`, `receivingItemMismatches`.
- Create `src/db/schema/picking.ts` — `pickingOrders`, `pickingItems` (generated `remaining_qty`), `pickingPackages`, `shippingBoxes`.
- Create `src/db/schema/inventory.ts` — `inventoryLots` (generated `available_qty`), `inventoryLotSources`, `shelfBoxes`, `shelfBoxItems`, `putAwayScans`.
- Create `src/db/schema/allocation.ts` — `allocations` (XOR CHECK), `allocationReceivingItems`.
- Create `src/db/schema/tasks.ts` — `measuringTasks`, `verificationTasks` (kind CHECKs + expression unique index).
- Create `src/db/schema/audit.ts` — `transitionLogs`.
- Create `src/db/schema/index.ts` — barrel: `export *` of each module + `import * as schema` re-export.
- Modify `src/db.ts` — add pragmas, wire `schema`, add `createDb()` factory + `createTables()`.
- Create `src/db/invariants.ts` — mutation primitives + per-entity recompute functions.
- Create `src/db/schema/normalize.test.ts`, `src/db/client.test.ts`, `src/db/invariants.test.ts`.

---
### Task 1: Timestamp + OCR normalization helpers

**Files:**
- Create: `apps/api/src/db/now.ts`
- Create: `apps/api/src/db/schema/normalize.ts`
- Test: `apps/api/src/db/schema/normalize.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/api/src/db/schema/normalize.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCode, normalizePlain, normalizePartNo } from "./normalize.js";

test("normalizeCode collapses whitespace and uppercases", () => {
  assert.equal(normalizeCode("  ab  cd "), "AB CD");
});

test("normalizeCode maps OCR confusables (O→0 I→1 L→1 Z→2 S→5)", () => {
  assert.equal(normalizeCode("OILZS oilzs"), "01125 01125");
});

test("normalizePlain uppercases without mapping confusables", () => {
  assert.equal(normalizePlain("zo"), "ZO");
  assert.equal(normalizePlain("coo us"), "COO US");
});

test("normalizePartNo maps confusables", () => {
  assert.equal(normalizePartNo("PART-OIL"), "PART-011");
});

test("null/undefined pass through as null", () => {
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizePlain(undefined), null);
  assert.equal(normalizePartNo(null), null);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/schema/normalize.test.ts`
Expected: FAIL — `Cannot find module './normalize.js'`.

- [ ] **Step 3: Implement** — `apps/api/src/db/now.ts`

```ts
export function now(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 4: Implement** — `apps/api/src/db/schema/normalize.ts`

```ts
const CONFUSABLES: Record<string, string> = { O: "0", I: "1", L: "1", Z: "2", S: "5" };

function collapseUpper(s: string): string {
  return s.trim().replace(/\s+/g, " ").toUpperCase();
}

function applyConfusables(s: string): string {
  return s.replace(/[OILZS]/g, (c) => CONFUSABLES[c] ?? c);
}

/** part_no / date_code / lot_code: confusable map + collapse + upper */
export function normalizeCode(s: string | null | undefined): string | null {
  if (s == null) return null;
  return applyConfusables(collapseUpper(s));
}

/** coo / cow: collapse + upper, no confusable map */
export function normalizePlain(s: string | null | undefined): string | null {
  if (s == null) return null;
  return collapseUpper(s);
}

/** part number uses the confusable mapping (identical to normalizeCode). */
export const normalizePartNo = normalizeCode;
```

- [ ] **Step 5: Run — expect pass**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/schema/normalize.test.ts`
Expected: PASS — `tests 5, pass 5, fail 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/now.ts apps/api/src/db/schema/normalize.ts apps/api/src/db/schema/normalize.test.ts
git commit -m "feat(api): add timestamp and OCR normalization helpers"
```

---

### Task 2: Database client factory with WAL pragmas

**Files:**
- Create: `apps/api/src/db/client.ts`
- Test: `apps/api/src/db/client.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/api/src/db/client.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "./client.js";

function tmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  return path.join(dir, "t.sqlite");
}

test("createDb enables foreign keys, WAL, NORMAL sync, busy_timeout", () => {
  const { sqlite } = createDb(tmpPath());
  assert.equal(sqlite.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(sqlite.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(sqlite.pragma("synchronous", { simple: true }), 1); // 1 = NORMAL
  assert.equal(sqlite.pragma("busy_timeout", { simple: true }), 5000);
  sqlite.close();
});

test("createDb creates missing parent directories", () => {
  const p = path.join(os.tmpdir(), "wh-api-" + Date.now(), "nested", "t.sqlite");
  const { sqlite } = createDb(p);
  assert.ok(fs.existsSync(p));
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/client.test.ts`
Expected: FAIL — `Cannot find module './client.js'`.

- [ ] **Step 3: Implement** — `apps/api/src/db/client.ts`

```ts
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export function createDb(dbPath?: string): {
  sqlite: DatabaseType;
  db: BetterSQLite3Database<Record<string, never>>;
} {
  const resolved = path.resolve(dbPath ?? process.env.DATABASE_URL ?? "./dev.sqlite");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const sqlite = new Database(resolved);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  return { sqlite, db };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/client.test.ts`
Expected: PASS — `tests 2, pass 2, fail 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/client.ts apps/api/src/db/client.test.ts
git commit -m "feat(api): add SQLite client factory with WAL pragmas"
```

---
### Schema tasks (3–9) — verification note

Tasks 3–9 are Drizzle table *declarations*. Each is verified by `pnpm --filter @warehouse/api build` (typecheck + cross-module `references(() => …)` resolution). Runtime table creation, generated columns, CHECK constraints, and indexes are proven together in **Task 10** (smoke test). Tasks 11–14 prove the maintained columns.

Import header for every schema module:

```ts
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";
```

(Only import the symbols a module actually uses.)

---

### Task 3: Schema — master data

**Files:**
- Create: `apps/api/src/db/schema/master.ts`

- [ ] **Step 1: Implement** — `apps/api/src/db/schema/master.ts`

```ts
import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const suppliers = sqliteTable("suppliers", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  qrTemplate: text("qr_template"),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});

export const parts = sqliteTable(
  "parts",
  {
    id: text("id").primaryKey(),
    partNo: text("part_no").notNull(),
    partNoNorm: text("part_no_norm").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ partNoNormIdx: index("parts_part_no_norm_idx").on(t.partNoNorm) })
);

export const shelves = sqliteTable("shelves", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  createdAt: text("created_at").notNull().$defaultFn(now),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @warehouse/api build`
Expected: exit 0, no type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/master.ts
git commit -m "feat(api): add master-data sqlite schema (users, suppliers, parts, shelves)"
```

---

### Task 4: Schema — receiving

**Files:**
- Create: `apps/api/src/db/schema/receiving.ts`

- [ ] **Step 1: Implement** — `apps/api/src/db/schema/receiving.ts`

```ts
import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";
import { suppliers, parts } from "./master.js";

export const receivingOrders = sqliteTable(
  "receiving_orders",
  {
    id: text("id").primaryKey(),
    externalId: text("external_id").notNull().unique(),
    refNo: text("ref_no").notNull(),
    deliveryDate: text("delivery_date"),
    status: text("status", { enum: ["pending", "in_hand", "clear"] }).notNull(),
    supplierId: text("supplier_id").references(() => suppliers.id),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ statusUpdatedIdx: index("receiving_orders_status_updated_idx").on(t.status, t.updatedAt) })
);

export const receivingInvoices = sqliteTable(
  "receiving_invoices",
  {
    id: text("id").primaryKey(),
    externalId: text("external_id"),
    receivingOrderId: text("receiving_order_id").notNull().references(() => receivingOrders.id, { onDelete: "cascade" }),
    invoiceNo: text("invoice_no").notNull(),
    supplierId: text("supplier_id").references(() => suppliers.id),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("receiving_invoices_order_idx").on(t.receivingOrderId),
    orderInvoiceUq: unique("receiving_invoices_order_invoice_uq").on(t.receivingOrderId, t.invoiceNo),
  })
);

export const receivingInvoiceItems = sqliteTable(
  "receiving_invoice_items",
  {
    id: text("id").primaryKey(),
    receivingInvoiceId: text("receiving_invoice_id").notNull().references(() => receivingInvoices.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull().references(() => parts.id),
    qty: integer("qty").notNull().default(0),
    receivedQty: integer("received_qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    putAwayQty: integer("put_away_qty").notNull().default(0),
    allocatedQty: integer("allocated_qty").notNull().default(0), // MAINTAINED = Σ allocation_receiving_items.qty
    availableQty: integer("available_qty").notNull().default(0), // MAINTAINED = received - picked - put_away - allocated
    boxId: text("box_id"),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    dateCodeNorm: text("date_code_norm"),
    lotCodeNorm: text("lot_code_norm"),
    cooNorm: text("coo_norm"),
    cowNorm: text("cow_norm"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    partAvailIdx: index("rii_part_available_idx").on(t.partId, t.availableQty),
    invoiceIdx: index("rii_invoice_idx").on(t.receivingInvoiceId),
  })
);

export const receivingItemMismatches = sqliteTable(
  "receiving_item_mismatches",
  {
    id: text("id").primaryKey(),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ itemIdx: index("rim_item_idx").on(t.receivingInvoiceItemId) })
);
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @warehouse/api build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/receiving.ts
git commit -m "feat(api): add receiving sqlite schema with maintained quantity columns"
```

---

### Task 5: Schema — picking

**Files:**
- Create: `apps/api/src/db/schema/picking.ts`

- [ ] **Step 1: Implement** — `apps/api/src/db/schema/picking.ts`

```ts
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";
import { parts } from "./master.js";

export const pickingOrders = sqliteTable(
  "picking_orders",
  {
    id: text("id").primaryKey(),
    externalId: text("external_id").notNull().unique(),
    refNo: text("ref_no").notNull(),
    status: text("status", { enum: ["pending", "picking", "finished", "issue"] }).notNull(),
    shipTo: text("ship_to"),
    destinationCountry: text("destination_country"),
    issueReason: text("issue_reason"),
    issueNote: text("issue_note"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ statusUpdatedIdx: index("picking_orders_status_updated_idx").on(t.status, t.updatedAt) })
);

export const pickingItems = sqliteTable(
  "picking_items",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull().references(() => parts.id),
    qty: integer("qty").notNull().default(0),
    pickedQty: integer("picked_qty").notNull().default(0),
    allocatedQty: integer("allocated_qty").notNull().default(0), // MAINTAINED = Σ allocations.qty
    requiredDateCode: text("required_date_code"),
    sourceShelfCode: text("source_shelf_code"),
    scannedNotBoxedQty: integer("scanned_not_boxed_qty").notNull().default(0), // MAINTAINED
    remainingQty: integer("remaining_qty").generatedAlwaysAs(sql`qty - picked_qty - scanned_not_boxed_qty`, { mode: "stored" }),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    partIdx: index("picking_items_part_idx").on(t.partId),
    orderIdx: index("picking_items_order_idx").on(t.pickingOrderId),
  })
);

export const shippingBoxes = sqliteTable(
  "shipping_boxes",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["open", "closed", "verified"] }).notNull().default("open"),
    boxSize: text("box_size"),
    netWeightG: integer("net_weight_g"),
    grossWeightG: integer("gross_weight_g"),
    destinationCountry: text("destination_country"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    orderIdx: index("shipping_boxes_order_idx").on(t.pickingOrderId),
    statusIdx: index("shipping_boxes_status_idx").on(t.status),
  })
);

export const pickingPackages = sqliteTable(
  "picking_packages",
  {
    id: text("id").primaryKey(),
    pickingItemId: text("picking_item_id").notNull().references(() => pickingItems.id, { onDelete: "cascade" }),
    sourceType: text("source_type", { enum: ["receiving_invoice_item", "inventory_lot"] }).notNull(),
    sourceId: text("source_id").notNull(),
    qty: integer("qty").notNull().default(0),
    shippingBoxId: text("shipping_box_id").references(() => shippingBoxes.id),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    verified: integer("verified").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    boxIdx: index("picking_packages_box_idx").on(t.shippingBoxId),
    itemIdx: index("picking_packages_item_idx").on(t.pickingItemId),
  })
);
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @warehouse/api build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/picking.ts
git commit -m "feat(api): add picking sqlite schema with generated remaining_qty"
```

---
### Task 6: Schema — inventory (shelf stock)

**Files:**
- Create: `apps/api/src/db/schema/inventory.ts`

- [ ] **Step 1: Implement** — `apps/api/src/db/schema/inventory.ts`

```ts
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";
import { parts } from "./master.js";
import { receivingInvoiceItems } from "./receiving.js";

export const inventoryLots = sqliteTable(
  "inventory_lots",
  {
    id: text("id").primaryKey(),
    partId: text("part_id").notNull().references(() => parts.id),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    dateCodeNorm: text("date_code_norm"),
    lotCodeNorm: text("lot_code_norm"),
    cooNorm: text("coo_norm"),
    cowNorm: text("cow_norm"),
    shelfCode: text("shelf_code"), // null = receiving-area lot
    boxId: text("box_id"),
    totalQty: integer("total_qty").notNull().default(0),
    allocatedQty: integer("allocated_qty").notNull().default(0), // MAINTAINED = Σ allocations.qty
    availableQty: integer("available_qty").generatedAlwaysAs(sql`total_qty - allocated_qty`, { mode: "stored" }),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    partShelfAvailIdx: index("inventory_lots_part_shelf_avail_idx").on(t.partId, t.shelfCode, t.availableQty),
  })
);

export const inventoryLotSources = sqliteTable(
  "inventory_lot_sources",
  {
    id: text("id").primaryKey(),
    inventoryLotId: text("inventory_lot_id").notNull().references(() => inventoryLots.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id),
    qty: integer("qty").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    lotIdx: index("ils_lot_idx").on(t.inventoryLotId),
    itemIdx: index("ils_item_idx").on(t.receivingInvoiceItemId),
  })
);

export const shelfBoxes = sqliteTable(
  "shelf_boxes",
  {
    id: text("id").primaryKey(),
    shelfCode: text("shelf_code").notNull(),
    boxId: text("box_id"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ shelfIdx: index("shelf_boxes_shelf_idx").on(t.shelfCode) })
);

export const shelfBoxItems = sqliteTable(
  "shelf_box_items",
  {
    id: text("id").primaryKey(),
    shelfBoxId: text("shelf_box_id").notNull().references(() => shelfBoxes.id, { onDelete: "cascade" }),
    partId: text("part_id").notNull().references(() => parts.id),
    qty: integer("qty").notNull().default(0),
    verified: integer("verified").notNull().default(0),
    verifiedAt: text("verified_at"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ boxIdx: index("shelf_box_items_box_idx").on(t.shelfBoxId) })
);

export const putAwayScans = sqliteTable(
  "put_away_scans",
  {
    id: text("id").primaryKey(),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id),
    qty: integer("qty").notNull().default(0),
    shelfBoxId: text("shelf_box_id").references(() => shelfBoxes.id), // null = scanned, not yet shelved
    verified: integer("verified").notNull().default(0),
    verifiedAt: text("verified_at"),
    dateCode: text("date_code"),
    lotCode: text("lot_code"),
    coo: text("coo"),
    cow: text("cow"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    itemIdx: index("put_away_scans_item_idx").on(t.receivingInvoiceItemId),
    boxIdx: index("put_away_scans_box_idx").on(t.shelfBoxId),
  })
);
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @warehouse/api build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/inventory.ts
git commit -m "feat(api): add inventory sqlite schema with generated available_qty"
```

---

### Task 7: Schema — allocation

**Files:**
- Create: `apps/api/src/db/schema/allocation.ts`

- [ ] **Step 1: Implement** — `apps/api/src/db/schema/allocation.ts`

```ts
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, check, unique } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";
import { pickingItems } from "./picking.js";
import { inventoryLots } from "./inventory.js";
import { receivingOrders, receivingInvoiceItems } from "./receiving.js";

export const allocations = sqliteTable(
  "allocations",
  {
    id: text("id").primaryKey(),
    pickingItemId: text("picking_item_id").notNull().references(() => pickingItems.id, { onDelete: "cascade" }),
    qty: integer("qty").notNull().default(0),
    remark: text("remark"),
    inventoryLotId: text("inventory_lot_id").references(() => inventoryLots.id),
    receivingOrderId: text("receiving_order_id").references(() => receivingOrders.id),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    targetXor: check("allocations_target_xor", sql`(inventory_lot_id IS NOT NULL) != (receiving_order_id IS NOT NULL)`),
    itemIdx: index("allocations_item_idx").on(t.pickingItemId),
    lotIdx: index("allocations_lot_idx").on(t.inventoryLotId),
    receivingOrderIdx: index("allocations_receiving_order_idx").on(t.receivingOrderId),
  })
);

export const allocationReceivingItems = sqliteTable(
  "allocation_receiving_items",
  {
    id: text("id").primaryKey(),
    allocationId: text("allocation_id").notNull().references(() => allocations.id, { onDelete: "cascade" }),
    receivingInvoiceItemId: text("receiving_invoice_item_id").notNull().references(() => receivingInvoiceItems.id),
    qty: integer("qty").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    allocItemUq: unique("ari_allocation_item_uq").on(t.allocationId, t.receivingInvoiceItemId),
    itemIdx: index("ari_item_idx").on(t.receivingInvoiceItemId),
    allocationIdx: index("ari_allocation_idx").on(t.allocationId),
  })
);
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @warehouse/api build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/allocation.ts
git commit -m "feat(api): add allocation schema with link table and XOR check"
```

---

### Task 8: Schema — tasks

**Files:**
- Create: `apps/api/src/db/schema/tasks.ts`

- [ ] **Step 1: Implement** — `apps/api/src/db/schema/tasks.ts`

```ts
import { sql } from "drizzle-orm";
import { sqliteTable, text, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";
import { pickingOrders } from "./picking.js";
import { shelfBoxes } from "./inventory.js";

export const measuringTasks = sqliteTable(
  "measuring_tasks",
  {
    id: text("id").primaryKey(),
    pickingOrderId: text("picking_order_id").notNull().references(() => pickingOrders.id, { onDelete: "cascade" }).unique(),
    status: text("status", { enum: ["pending", "completed"] }).notNull().default("pending"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ statusUpdatedIdx: index("measuring_tasks_status_updated_idx").on(t.status, t.updatedAt) })
);

export const verificationTasks = sqliteTable(
  "verification_tasks",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["pre_shipment", "cycle_count"] }).notNull(),
    status: text("status", { enum: ["pending", "completed"] }).notNull().default("pending"),
    dueAt: text("due_at"),
    pickingOrderId: text("picking_order_id").references(() => pickingOrders.id, { onDelete: "cascade" }),
    shelfBoxId: text("shelf_box_id").references(() => shelfBoxes.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    preShipmentFk: check("vt_pre_shipment_fk", sql`(kind = 'pre_shipment') = (picking_order_id IS NOT NULL)`),
    cycleCountFk: check("vt_cycle_count_fk", sql`(kind = 'cycle_count') = (shelf_box_id IS NOT NULL)`),
    kindStatusUpdatedIdx: index("verification_tasks_kind_status_updated_idx").on(t.kind, t.status, t.updatedAt),
    cycleCoalesceUq: uniqueIndex("verification_tasks_cycle_coalesce_uq").on(t.kind, t.shelfBoxId, sql`date(${t.dueAt})`),
  })
);
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @warehouse/api build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/tasks.ts
git commit -m "feat(api): add measuring and verification task schema with kind checks"
```

---

### Task 9: Schema — audit, barrel, and wire `db.ts`

**Files:**
- Create: `apps/api/src/db/schema/audit.ts`
- Create: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/db.ts`

- [ ] **Step 1: Implement audit** — `apps/api/src/db/schema/audit.ts`

```ts
import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { now } from "../now.js";

export const transitionLogs = sqliteTable(
  "transition_logs",
  {
    id: text("id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actorId: text("actor_id"),
    note: text("note"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({ entityIdx: index("transition_logs_entity_idx").on(t.entityType, t.entityId) })
);
```

- [ ] **Step 2: Implement barrel** — `apps/api/src/db/schema/index.ts`

```ts
export * from "./master.js";
export * from "./receiving.js";
export * from "./picking.js";
export * from "./inventory.js";
export * from "./allocation.js";
export * from "./tasks.js";
export * from "./audit.js";
```

- [ ] **Step 3: Rewrite** — `apps/api/src/db.ts` (replace whole file)

```ts
import "dotenv/config";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import * as schema from "./db/schema/index.js";
import { createDb } from "./db/client.js";

const resolved = path.resolve(process.env.DATABASE_URL ?? "./dev.sqlite");
const { sqlite } = createDb(resolved);

export { sqlite };
export const db = drizzle(sqlite, { schema });
export type AppDb = typeof db;
```

- [ ] **Step 4: Verify build + health still passes**

Run: `pnpm --filter @warehouse/api build`
Expected: exit 0.
Run: `pnpm --filter @warehouse/api test`
Expected: existing health test still PASS (1/1); new tests for normalize/client PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/audit.ts apps/api/src/db/schema/index.ts apps/api/src/db.ts
git commit -m "feat(api): add audit schema, barrel, and wire typed db"
```

---
### Task 10: `createTables` DDL + smoke test

**Files:**
- Create: `apps/api/src/db/tables.ts`
- Modify: `apps/api/src/db.ts`
- Test: `apps/api/src/db/tables.test.ts`

`createTablesSql` is the single SQL string executed at boot (idempotent `IF NOT EXISTS`), matching the apps/web "created from code" pattern. It must mirror the Drizzle schema exactly; the smoke test guards drift.

- [ ] **Step 1: Write the failing test** — `apps/api/src/db/tables.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  return path.join(dir, "t.sqlite");
}

const EXPECTED_TABLES = [
  "users","suppliers","parts","shelves",
  "receiving_orders","receiving_invoices","receiving_invoice_items","receiving_item_mismatches",
  "picking_orders","picking_items","shipping_boxes","picking_packages",
  "inventory_lots","inventory_lot_sources","shelf_boxes","shelf_box_items","put_away_scans",
  "allocations","allocation_receiving_items","measuring_tasks","verification_tasks","transition_logs",
];

function tableNames(sqlite: ReturnType<typeof createDb>["sqlite"]): Set<string> {
  const rows = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

test("createTables creates every table", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  const names = tableNames(sqlite);
  for (const t of EXPECTED_TABLES) assert.ok(names.has(t), `missing table ${t}`);
  sqlite.close();
});

test("createTables is idempotent", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  assert.doesNotThrow(() => createTables(sqlite));
  sqlite.close();
});

test("picking_items.remaining_qty is generated (stored)", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  sqlite.prepare("INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X',0,0)").run();
  sqlite.prepare("INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e1','R1','pending',0,0)").run();
  sqlite.prepare("INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, scanned_not_boxed_qty, created_at, updated_at) VALUES ('pi','po','p',10,3,2,0,0)").run();
  const row = sqlite.prepare("SELECT remaining_qty FROM picking_items WHERE id='pi'").get() as { remaining_qty: number };
  assert.equal(row.remaining_qty, 5); // 10 - 3 - 2
  sqlite.close();
});

test("inventory_lots.available_qty is generated (stored)", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  sqlite.prepare("INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X',0,0)").run();
  sqlite.prepare("INSERT INTO inventory_lots (id, part_id, total_qty, allocated_qty, created_at, updated_at) VALUES ('l','p',10,4,0,0)").run();
  const row = sqlite.prepare("SELECT available_qty FROM inventory_lots WHERE id='l'").get() as { available_qty: number };
  assert.equal(row.available_qty, 6);
  sqlite.close();
});

test("allocations XOR check rejects both targets set", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  sqlite.prepare("INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X',0,0)").run();
  sqlite.prepare("INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e1','R1','pending',0,0)").run();
  sqlite.prepare("INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',1,0,0)").run();
  sqlite.prepare("INSERT INTO inventory_lots (id, part_id, total_qty, created_at, updated_at) VALUES ('l','p',1,0,0)").run();
  sqlite.prepare("INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e2','R2','pending',0,0)").run();
  assert.throws(() =>
    sqlite.prepare("INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, receiving_order_id, created_at, updated_at) VALUES ('a','pi',1,'l','ro',0,0)").run()
  );
  sqlite.close();
});

test("verification_tasks kind check rejects pre_shipment without picking_order_id", () => {
  const { sqlite } = createDb(tmp());
  createTables(sqlite);
  assert.throws(() =>
    sqlite.prepare("INSERT INTO verification_tasks (id, kind, status, created_at, updated_at) VALUES ('v','pre_shipment','pending',0,0)").run()
  );
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/tables.test.ts`
Expected: FAIL — `Cannot find module './tables.js'`.

- [ ] **Step 3: Implement DDL** — `apps/api/src/db/tables.ts`

```ts
export const createTablesSql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, qr_template TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY, part_no TEXT NOT NULL, part_no_norm TEXT NOT NULL, description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS parts_part_no_norm_idx ON parts(part_no_norm);
CREATE TABLE IF NOT EXISTS shelves (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS receiving_orders (
  id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, ref_no TEXT NOT NULL, delivery_date TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','in_hand','clear')), supplier_id TEXT REFERENCES suppliers(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS receiving_orders_status_updated_idx ON receiving_orders(status, updated_at);
CREATE TABLE IF NOT EXISTS receiving_invoices (
  id TEXT PRIMARY KEY, external_id TEXT, receiving_order_id TEXT NOT NULL REFERENCES receiving_orders(id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL, supplier_id TEXT REFERENCES suppliers(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(receiving_order_id, invoice_no));
CREATE INDEX IF NOT EXISTS receiving_invoices_order_idx ON receiving_invoices(receiving_order_id);
CREATE TABLE IF NOT EXISTS receiving_invoice_items (
  id TEXT PRIMARY KEY, receiving_invoice_id TEXT NOT NULL REFERENCES receiving_invoices(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id), qty INTEGER NOT NULL DEFAULT 0, received_qty INTEGER NOT NULL DEFAULT 0,
  picked_qty INTEGER NOT NULL DEFAULT 0, put_away_qty INTEGER NOT NULL DEFAULT 0,
  allocated_qty INTEGER NOT NULL DEFAULT 0, available_qty INTEGER NOT NULL DEFAULT 0, box_id TEXT,
  date_code TEXT, lot_code TEXT, coo TEXT, cow TEXT, date_code_norm TEXT, lot_code_norm TEXT, coo_norm TEXT, cow_norm TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rii_part_available_idx ON receiving_invoice_items(part_id, available_qty);
CREATE INDEX IF NOT EXISTS rii_invoice_idx ON receiving_invoice_items(receiving_invoice_id);
CREATE TABLE IF NOT EXISTS receiving_item_mismatches (
  id TEXT PRIMARY KEY, receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rim_item_idx ON receiving_item_mismatches(receiving_invoice_item_id);

CREATE TABLE IF NOT EXISTS picking_orders (
  id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, ref_no TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','picking','finished','issue')), ship_to TEXT, destination_country TEXT,
  issue_reason TEXT, issue_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS picking_orders_status_updated_idx ON picking_orders(status, updated_at);
CREATE TABLE IF NOT EXISTS picking_items (
  id TEXT PRIMARY KEY, picking_order_id TEXT NOT NULL REFERENCES picking_orders(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id), qty INTEGER NOT NULL DEFAULT 0, picked_qty INTEGER NOT NULL DEFAULT 0,
  allocated_qty INTEGER NOT NULL DEFAULT 0, required_date_code TEXT, source_shelf_code TEXT,
  scanned_not_boxed_qty INTEGER NOT NULL DEFAULT 0,
  remaining_qty INTEGER GENERATED ALWAYS AS (qty - picked_qty - scanned_not_boxed_qty) STORED,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS picking_items_part_idx ON picking_items(part_id);
CREATE INDEX IF NOT EXISTS picking_items_order_idx ON picking_items(picking_order_id);
CREATE TABLE IF NOT EXISTS shipping_boxes (
  id TEXT PRIMARY KEY, picking_order_id TEXT NOT NULL REFERENCES picking_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','verified')), box_size TEXT,
  net_weight_g INTEGER, gross_weight_g INTEGER, destination_country TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shipping_boxes_order_idx ON shipping_boxes(picking_order_id);
CREATE INDEX IF NOT EXISTS shipping_boxes_status_idx ON shipping_boxes(status);
CREATE TABLE IF NOT EXISTS picking_packages (
  id TEXT PRIMARY KEY, picking_item_id TEXT NOT NULL REFERENCES picking_items(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK(source_type IN ('receiving_invoice_item','inventory_lot')), source_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0, shipping_box_id TEXT REFERENCES shipping_boxes(id),
  date_code TEXT, lot_code TEXT, coo TEXT, cow TEXT, verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS picking_packages_box_idx ON picking_packages(shipping_box_id);
CREATE INDEX IF NOT EXISTS picking_packages_item_idx ON picking_packages(picking_item_id);

CREATE TABLE IF NOT EXISTS inventory_lots (
  id TEXT PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts(id),
  date_code TEXT, lot_code TEXT, coo TEXT, cow TEXT, date_code_norm TEXT, lot_code_norm TEXT, coo_norm TEXT, cow_norm TEXT,
  shelf_code TEXT, box_id TEXT, total_qty INTEGER NOT NULL DEFAULT 0, allocated_qty INTEGER NOT NULL DEFAULT 0,
  available_qty INTEGER GENERATED ALWAYS AS (total_qty - allocated_qty) STORED,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS inventory_lots_part_shelf_avail_idx ON inventory_lots(part_id, shelf_code, available_qty);
CREATE TABLE IF NOT EXISTS inventory_lot_sources (
  id TEXT PRIMARY KEY, inventory_lot_id TEXT NOT NULL REFERENCES inventory_lots(id) ON DELETE CASCADE,
  receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id), qty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ils_lot_idx ON inventory_lot_sources(inventory_lot_id);
CREATE INDEX IF NOT EXISTS ils_item_idx ON inventory_lot_sources(receiving_invoice_item_id);
CREATE TABLE IF NOT EXISTS shelf_boxes (
  id TEXT PRIMARY KEY, shelf_code TEXT NOT NULL, box_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shelf_boxes_shelf_idx ON shelf_boxes(shelf_code);
CREATE TABLE IF NOT EXISTS shelf_box_items (
  id TEXT PRIMARY KEY, shelf_box_id TEXT NOT NULL REFERENCES shelf_boxes(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES parts(id), qty INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shelf_box_items_box_idx ON shelf_box_items(shelf_box_id);
CREATE TABLE IF NOT EXISTS put_away_scans (
  id TEXT PRIMARY KEY, receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id),
  qty INTEGER NOT NULL DEFAULT 0, shelf_box_id TEXT REFERENCES shelf_boxes(id), verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT, date_code TEXT, lot_code TEXT, coo TEXT, cow TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS put_away_scans_item_idx ON put_away_scans(receiving_invoice_item_id);
CREATE INDEX IF NOT EXISTS put_away_scans_box_idx ON put_away_scans(shelf_box_id);

CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY, picking_item_id TEXT NOT NULL REFERENCES picking_items(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL DEFAULT 0, remark TEXT, inventory_lot_id TEXT REFERENCES inventory_lots(id),
  receiving_order_id TEXT REFERENCES receiving_orders(id),
  CHECK ((inventory_lot_id IS NOT NULL) != (receiving_order_id IS NOT NULL)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS allocations_item_idx ON allocations(picking_item_id);
CREATE INDEX IF NOT EXISTS allocations_lot_idx ON allocations(inventory_lot_id);
CREATE INDEX IF NOT EXISTS allocations_receiving_order_idx ON allocations(receiving_order_id);
CREATE TABLE IF NOT EXISTS allocation_receiving_items (
  id TEXT PRIMARY KEY, allocation_id TEXT NOT NULL REFERENCES allocations(id) ON DELETE CASCADE,
  receiving_invoice_item_id TEXT NOT NULL REFERENCES receiving_invoice_items(id), qty INTEGER NOT NULL DEFAULT 0,
  UNIQUE(allocation_id, receiving_invoice_item_id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ari_item_idx ON allocation_receiving_items(receiving_invoice_item_id);
CREATE INDEX IF NOT EXISTS ari_allocation_idx ON allocation_receiving_items(allocation_id);

CREATE TABLE IF NOT EXISTS measuring_tasks (
  id TEXT PRIMARY KEY, picking_order_id TEXT NOT NULL UNIQUE REFERENCES picking_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS measuring_tasks_status_updated_idx ON measuring_tasks(status, updated_at);
CREATE TABLE IF NOT EXISTS verification_tasks (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('pre_shipment','cycle_count')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')), due_at TEXT,
  picking_order_id TEXT REFERENCES picking_orders(id) ON DELETE CASCADE,
  shelf_box_id TEXT REFERENCES shelf_boxes(id) ON DELETE CASCADE,
  CHECK ((kind = 'pre_shipment') = (picking_order_id IS NOT NULL)),
  CHECK ((kind = 'cycle_count') = (shelf_box_id IS NOT NULL)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS verification_tasks_kind_status_updated_idx ON verification_tasks(kind, status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS verification_tasks_cycle_coalesce_uq ON verification_tasks(kind, shelf_box_id, date(due_at));

CREATE TABLE IF NOT EXISTS transition_logs (
  id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, from_status TEXT, to_status TEXT,
  actor_id TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS transition_logs_entity_idx ON transition_logs(entity_type, entity_id);
`;

import type { Database as DatabaseType } from "better-sqlite3";

export function createTables(sqlite: DatabaseType): void {
  sqlite.exec(createTablesSql);
}
```

- [ ] **Step 4: Wire boot-time creation** — `apps/api/src/db.ts` (replace whole file)

```ts
import "dotenv/config";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import * as schema from "./db/schema/index.js";
import { createDb } from "./db/client.js";
import { createTables } from "./db/tables.js";

const resolved = path.resolve(process.env.DATABASE_URL ?? "./dev.sqlite");
const { sqlite } = createDb(resolved);
createTables(sqlite);

export { sqlite };
export const db = drizzle(sqlite, { schema });
export type AppDb = typeof db;
```

- [ ] **Step 5: Run — expect pass**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/tables.test.ts`
Expected: PASS — `tests 6, pass 6, fail 0`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/tables.ts apps/api/src/db/tables.test.ts apps/api/src/db.ts
git commit -m "feat(api): add idempotent createTables DDL with generated columns and checks"
```

---
### Invariant tasks (11–14) — design note

All quantity changes go through `src/db/invariants.ts`. Each primitive mutates source row(s) and then calls the relevant **recompute-from-source** function for the affected rows, inside the caller's transaction. Recompute (not incremental bumping) is the deliberate safe default — it cannot drift, and warehouse volumes make the cost negligible. `assertInvariantsHold` (Task 14) is the proof harness used by the property test.

Every primitive takes `tx: DbOrTx` and never opens its own transaction; callers wrap multi-primitive work in `db.transaction((tx) => …)`.

---

### Task 11: Invariants — receiving primitives + recompute

**Files:**
- Create: `apps/api/src/db/invariants.ts`
- Test: `apps/api/src/db/invariants.receiving.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/api/src/db/invariants.receiving.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { applyReceipt, applyPick, applyPutAway } from "./invariants.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e','R','in_hand','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','INV','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, created_at, updated_at) VALUES ('rii','ri','p',20,0,'0','0');
  `);
  return { sqlite, db };
}

const avail = (sqlite: any) =>
  (sqlite.prepare("SELECT received_qty r, picked_qty p, put_away_qty pa, allocated_qty al, available_qty av FROM receiving_invoice_items WHERE id='rii'").get() as any);

test("receipt then pick then put-away keeps available_qty correct", () => {
  const { sqlite, db } = makeDb();
  applyReceipt(db, "rii", 10);
  assert.deepEqual(avail(sqlite), { r: 10, p: 0, pa: 0, al: 0, av: 10 });
  applyPick(db, "rii", 3);
  assert.deepEqual(avail(sqlite), { r: 10, p: 3, pa: 0, al: 0, av: 7 });
  applyPutAway(db, "rii", 4, null);
  assert.deepEqual(avail(sqlite), { r: 10, p: 3, pa: 4, al: 0, av: 3 });
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/invariants.receiving.test.ts`
Expected: FAIL — `Cannot find module './invariants.js'`.

- [ ] **Step 3: Implement** — `apps/api/src/db/invariants.ts`

```ts
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import { now } from "./now.js";

type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
export type DbOrTx = AppDb | Tx;

/** Recompute receiving_invoice_items.allocated_qty and available_qty from source rows. */
export function recomputeReceivingItem(tx: DbOrTx, itemId: string): void {
  const item = tx
    .get<{ received: number; picked: number; put_away: number }>(
      sql`SELECT received_qty AS received, picked_qty AS picked, put_away_qty AS put_away FROM receiving_invoice_items WHERE id = ${itemId}`
    );
  if (!item) return;
  const alloc = tx
    .get<{ s: number }>(
      sql`SELECT COALESCE(SUM(qty), 0) AS s FROM allocation_receiving_items WHERE receiving_invoice_item_id = ${itemId}`
    );
  const allocated = alloc?.s ?? 0;
  const available = item.received - item.picked - item.put_away - allocated;
  tx.run(
    sql`UPDATE receiving_invoice_items SET allocated_qty = ${allocated}, available_qty = ${available}, updated_at = ${now()} WHERE id = ${itemId}`
  );
}

export function applyReceipt(tx: DbOrTx, itemId: string, qty: number): void {
  tx.run(sql`UPDATE receiving_invoice_items SET received_qty = received_qty + ${qty}, updated_at = ${now()} WHERE id = ${itemId}`);
  recomputeReceivingItem(tx, itemId);
}

export function applyPick(tx: DbOrTx, itemId: string, qty: number): void {
  tx.run(sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty + ${qty}, updated_at = ${now()} WHERE id = ${itemId}`);
  recomputeReceivingItem(tx, itemId);
}

export function applyPutAway(tx: DbOrTx, itemId: string, qty: number, shelfBoxId: string | null): void {
  tx.run(
    sql`INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${itemId}, ${qty}, ${shelfBoxId}, ${now()}, ${now()})`
  );
  tx.run(sql`UPDATE receiving_invoice_items SET put_away_qty = put_away_qty + ${qty}, updated_at = ${now()} WHERE id = ${itemId}`);
  recomputeReceivingItem(tx, itemId);
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/invariants.receiving.test.ts`
Expected: PASS — `tests 1, pass 1, fail 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/invariants.ts apps/api/src/db/invariants.receiving.test.ts
git commit -m "feat(api): add receiving invariant primitives with recompute-from-source"
```

---
### Task 12: Invariants — allocation primitives

**Files:**
- Modify: `apps/api/src/db/invariants.ts` (append)
- Test: `apps/api/src/db/invariants.allocation.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/api/src/db/invariants.allocation.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { applyReceipt, createAllocation, linkAllocation, deleteAllocation } from "./invariants.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'0','0');
    INSERT INTO inventory_lots (id, part_id, total_qty, created_at, updated_at) VALUES ('lot','p',5,'0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e2','R2','in_hand','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','INV','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, created_at, updated_at) VALUES ('rii','ri','p',10,'0','0');
  `);
  return { sqlite, db };
}

test("lot + receiving allocations update picking item, lot, and receiving item", () => {
  const { sqlite, db } = makeDb();
  applyReceipt(db, "rii", 10); // receiving available = 10

  createAllocation(db, { id: "aLot", pickingItemId: "pi", qty: 4, inventoryLotId: "lot" });
  createAllocation(db, { id: "aRecv", pickingItemId: "pi", qty: 6, receivingOrderId: "ro" });
  linkAllocation(db, { id: "lnk", allocationId: "aRecv", receivingInvoiceItemId: "rii", qty: 6 });

  const pi = sqlite.prepare("SELECT allocated_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.equal(pi.allocated_qty, 10); // 4 (lot) + 6 (recv)
  const lot = sqlite.prepare("SELECT allocated_qty al, available_qty av FROM inventory_lots WHERE id='lot'").get() as any;
  assert.deepEqual(lot, { al: 4, av: 1 }); // available generated: 5 - 4
  const rii = sqlite.prepare("SELECT allocated_qty al, available_qty av FROM receiving_invoice_items WHERE id='rii'").get() as any;
  assert.deepEqual(rii, { al: 6, av: 4 }); // 10 received - 6 linked

  deleteAllocation(db, "aLot");
  const pi2 = sqlite.prepare("SELECT allocated_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.equal(pi2.allocated_qty, 6);
  const lot2 = sqlite.prepare("SELECT allocated_qty al, available_qty av FROM inventory_lots WHERE id='lot'").get() as any;
  assert.deepEqual(lot2, { al: 0, av: 5 });
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/invariants.allocation.test.ts`
Expected: FAIL — `createAllocation is not exported` (functions not yet written).

- [ ] **Step 3: Append to** — `apps/api/src/db/invariants.ts`

```ts
/** Recompute picking_items.allocated_qty and scanned_not_boxed_qty (remaining_qty is generated). */
export function recomputePickingItem(tx: DbOrTx, pickingItemId: string): void {
  const alloc = tx.get<{ s: number }>(sql`SELECT COALESCE(SUM(qty), 0) AS s FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  const scanned = tx.get<{ s: number }>(
    sql`SELECT COALESCE(SUM(qty), 0) AS s FROM picking_packages WHERE picking_item_id = ${pickingItemId} AND shipping_box_id IS NULL`
  );
  tx.run(
    sql`UPDATE picking_items SET allocated_qty = ${alloc?.s ?? 0}, scanned_not_boxed_qty = ${scanned?.s ?? 0}, updated_at = ${now()} WHERE id = ${pickingItemId}`
  );
}

/** Recompute inventory_lots.allocated_qty (available_qty is generated). */
export function recomputeLot(tx: DbOrTx, lotId: string): void {
  const alloc = tx.get<{ s: number }>(sql`SELECT COALESCE(SUM(qty), 0) AS s FROM allocations WHERE inventory_lot_id = ${lotId}`);
  tx.run(sql`UPDATE inventory_lots SET allocated_qty = ${alloc?.s ?? 0}, updated_at = ${now()} WHERE id = ${lotId}`);
}

export function createAllocation(
  tx: DbOrTx,
  a: { id: string; pickingItemId: string; qty: number; inventoryLotId?: string | null; receivingOrderId?: string | null }
): void {
  tx.run(
    sql`INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, receiving_order_id, created_at, updated_at)
        VALUES (${a.id}, ${a.pickingItemId}, ${a.qty}, ${a.inventoryLotId ?? null}, ${a.receivingOrderId ?? null}, ${now()}, ${now()})`
  );
  recomputePickingItem(tx, a.pickingItemId);
  if (a.inventoryLotId) recomputeLot(tx, a.inventoryLotId);
}

export function linkAllocation(
  tx: DbOrTx,
  l: { id: string; allocationId: string; receivingInvoiceItemId: string; qty: number }
): void {
  tx.run(
    sql`INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at)
        VALUES (${l.id}, ${l.allocationId}, ${l.receivingInvoiceItemId}, ${l.qty}, ${now()}, ${now()})`
  );
  recomputeReceivingItem(tx, l.receivingInvoiceItemId);
}

export function deleteAllocation(tx: DbOrTx, allocationId: string): void {
  const a = tx.get<{ pickingItemId: string; inventoryLotId: string | null }>(
    sql`SELECT picking_item_id AS pickingItemId, inventory_lot_id AS inventoryLotId FROM allocations WHERE id = ${allocationId}`
  );
  if (!a) return;
  const linked = tx.all<{ itemId: string }>(
    sql`SELECT receiving_invoice_item_id AS itemId FROM allocation_receiving_items WHERE allocation_id = ${allocationId}`
  );
  tx.run(sql`DELETE FROM allocations WHERE id = ${allocationId}`); // cascade deletes allocation_receiving_items
  recomputePickingItem(tx, a.pickingItemId);
  if (a.inventoryLotId) recomputeLot(tx, a.inventoryLotId);
  for (const { itemId } of linked) recomputeReceivingItem(tx, itemId);
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/invariants.allocation.test.ts`
Expected: PASS — `tests 1, pass 1, fail 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/invariants.ts apps/api/src/db/invariants.allocation.test.ts
git commit -m "feat(api): add allocation invariant primitives (create/link/delete)"
```

---
### Task 13: Invariants — picking scan / box primitives

**Files:**
- Modify: `apps/api/src/db/invariants.ts` (append)
- Test: `apps/api/src/db/invariants.scan.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/api/src/db/invariants.scan.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { scanToPackage, assignPackageToBox } from "./invariants.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'0','0');
    INSERT INTO inventory_lots (id, part_id, total_qty, created_at, updated_at) VALUES ('lot','p',10,'0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0');
  `);
  return { sqlite, db };
}

test("scan unboxed then assign to box keeps scanned_not_boxed and remaining correct", () => {
  const { sqlite, db } = makeDb();
  scanToPackage(db, { id: "pp1", pickingItemId: "pi", qty: 3, sourceType: "inventory_lot", sourceId: "lot" });
  scanToPackage(db, { id: "pp2", pickingItemId: "pi", qty: 2, sourceType: "inventory_lot", sourceId: "lot" });
  let pi = sqlite.prepare("SELECT scanned_not_boxed_qty s, remaining_qty r FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { s: 5, r: 5 }); // remaining generated: 10 - 0 - 5

  assignPackageToBox(db, { packageId: "pp1", shippingBoxId: "box" });
  pi = sqlite.prepare("SELECT scanned_not_boxed_qty s, remaining_qty r FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { s: 2, r: 8 }); // 10 - 0 - 2
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/invariants.scan.test.ts`
Expected: FAIL — `scanToPackage is not exported`.

- [ ] **Step 3: Append to** — `apps/api/src/db/invariants.ts`

```ts
export function scanToPackage(
  tx: DbOrTx,
  p: { id: string; pickingItemId: string; qty: number; sourceType: "receiving_invoice_item" | "inventory_lot"; sourceId: string }
): void {
  tx.run(
    sql`INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
        VALUES (${p.id}, ${p.pickingItemId}, ${p.sourceType}, ${p.sourceId}, ${p.qty}, NULL, ${now()}, ${now()})`
  );
  recomputePickingItem(tx, p.pickingItemId);
}

export function assignPackageToBox(tx: DbOrTx, a: { packageId: string; shippingBoxId: string }): void {
  const pkg = tx.get<{ pickingItemId: string }>(sql`SELECT picking_item_id AS pickingItemId FROM picking_packages WHERE id = ${a.packageId}`);
  if (!pkg) return;
  tx.run(sql`UPDATE picking_packages SET shipping_box_id = ${a.shippingBoxId}, updated_at = ${now()} WHERE id = ${a.packageId}`);
  recomputePickingItem(tx, pkg.pickingItemId);
}
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/invariants.scan.test.ts`
Expected: PASS — `tests 1, pass 1, fail 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/invariants.ts apps/api/src/db/invariants.scan.test.ts
git commit -m "feat(api): add picking scan/box invariant primitives"
```

---
### Task 14: Invariant guard + seeded randomized property test

**Files:**
- Create: `apps/api/src/db/invariants.guard.ts`
- Test: `apps/api/src/db/invariants.property.test.ts`

The guard recomputes every maintained column from source and compares to the stored value; the property test drives ~300 randomized primitive calls from a **fixed seed** and asserts the guard after each one. A failing run prints the seed so it reproduces.

- [ ] **Step 1: Write the guard** — `apps/api/src/db/invariants.guard.ts`

```ts
import { sql } from "drizzle-orm";
import type { DbOrTx } from "./invariants.js";

export function assertInvariantsHold(tx: DbOrTx): void {
  const rii = tx.all<{
    id: string; sAlloc: number; sAvail: number; eAlloc: number; eAvail: number;
  }>(sql`
    SELECT rii.id,
      rii.allocated_qty AS sAlloc, rii.available_qty AS sAvail,
      COALESCE((SELECT SUM(qty) FROM allocation_receiving_items WHERE receiving_invoice_item_id = rii.id), 0) AS eAlloc,
      rii.received_qty - rii.picked_qty - rii.put_away_qty
        - COALESCE((SELECT SUM(qty) FROM allocation_receiving_items WHERE receiving_invoice_item_id = rii.id), 0) AS eAvail
    FROM receiving_invoice_items rii`);
  for (const r of rii) {
    if (r.sAlloc !== r.eAlloc || r.sAvail !== r.eAvail)
      throw new Error(`receiving ${r.id}: stored(alloc=${r.sAlloc},avail=${r.sAvail}) expected(alloc=${r.eAlloc},avail=${r.eAvail})`);
    if (r.sAvail < 0) throw new Error(`receiving ${r.id}: negative available ${r.sAvail}`);
  }

  const pi = tx.all<{
    id: string; sAlloc: number; sScanned: number; sRemaining: number; eAlloc: number; eScanned: number; eRemaining: number;
  }>(sql`
    SELECT pi.id,
      pi.allocated_qty AS sAlloc, pi.scanned_not_boxed_qty AS sScanned, pi.remaining_qty AS sRemaining,
      COALESCE((SELECT SUM(qty) FROM allocations WHERE picking_item_id = pi.id), 0) AS eAlloc,
      COALESCE((SELECT SUM(qty) FROM picking_packages WHERE picking_item_id = pi.id AND shipping_box_id IS NULL), 0) AS eScanned,
      pi.qty - pi.picked_qty - pi.scanned_not_boxed_qty AS eRemaining
    FROM picking_items pi`);
  for (const r of pi) {
    if (r.sAlloc !== r.eAlloc) throw new Error(`picking ${r.id}: allocated stored ${r.sAlloc} expected ${r.eAlloc}`);
    if (r.sScanned !== r.eScanned) throw new Error(`picking ${r.id}: scanned stored ${r.sScanned} expected ${r.eScanned}`);
    if (r.sRemaining !== r.eRemaining) throw new Error(`picking ${r.id}: remaining stored ${r.sRemaining} expected ${r.eRemaining}`);
  }

  const lots = tx.all<{ id: string; sAlloc: number; sAvail: number; eAlloc: number; eAvail: number }>(sql`
    SELECT l.id,
      l.allocated_qty AS sAlloc, l.available_qty AS sAvail, l.total_qty - l.allocated_qty AS eAvail,
      COALESCE((SELECT SUM(qty) FROM allocations WHERE inventory_lot_id = l.id), 0) AS eAlloc
    FROM inventory_lots l`);
  for (const r of lots) {
    if (r.sAlloc !== r.eAlloc) throw new Error(`lot ${r.id}: allocated stored ${r.sAlloc} expected ${r.eAlloc}`);
    if (r.sAvail !== r.eAvail) throw new Error(`lot ${r.id}: available stored ${r.sAvail} expected ${r.eAvail}`);
    if (r.sAvail < 0) throw new Error(`lot ${r.id}: negative available ${r.sAvail}`);
  }
}
```

- [ ] **Step 2: Write the failing property test** — `apps/api/src/db/invariants.property.test.ts`

```ts
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import {
  applyReceipt, applyPick, applyPutAway,
  createAllocation, linkAllocation, deleteAllocation,
  scanToPackage, assignPackageToBox,
} from "./invariants.js";
import { assertInvariantsHold } from "./invariants.guard.js";

const SEED = 123456789;
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test(`randomized primitive sequence preserves invariants (seed=${SEED})`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });

  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES
      ('p0','A','A','0','0'),('p1','B','B','0','0'),('p2','C','C','0','0');
  `);
  for (let i = 0; i < 3; i++) {
    sqlite.exec(`
      INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro${i}','er${i}','RR${i}','in_hand','0','0');
      INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri${i}','ro${i}','INV${i}','0','0');
      INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, created_at, updated_at) VALUES ('rii${i}','ri${i}','p${i}',50,20,'0','0');
      INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po${i}','ep${i}','RP${i}','picking','0','0');
      INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi${i}','po${i}','p${i}',15,'0','0');
      INSERT INTO inventory_lots (id, part_id, total_qty, created_at, updated_at) VALUES ('lot${i}','p${i}',10,'0','0');
      INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box${i}','po${i}','open','0','0');
    `);
  }

  const rand = rng(SEED);
  const ri = (n: number) => Math.floor(rand() * n);
  const pick = <T>(a: T[]) => a[ri(a.length)]!;
  const num = (sqlite: any, q: string) => (sqlite.prepare(q).get() as any)?.v ?? 0;

  const liveAlloc: string[] = [];
  const unboxed: { id: string; box: string }[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}${++seq}`;

  for (let step = 0; step < 300; step++) {
    const op = ri(8);
    try {
      if (op === 0) {
        applyReceipt(db, pick(["rii0", "rii1", "rii2"]), ri(5) + 1);
      } else if (op === 1) {
        const id = pick(["rii0", "rii1", "rii2"]);
        const av = num(sqlite, `SELECT available_qty AS v FROM receiving_invoice_items WHERE id='${id}'`);
        if (av > 0) applyPick(db, id, ri(Math.min(3, av)) + 1);
      } else if (op === 2) {
        const id = pick(["rii0", "rii1", "rii2"]);
        const av = num(sqlite, `SELECT available_qty AS v FROM receiving_invoice_items WHERE id='${id}'`);
        if (av > 0) applyPutAway(db, id, ri(Math.min(3, av)) + 1, null);
      } else if (op === 3) {
        const i = ri(3);
        const prem = num(sqlite, `SELECT remaining_qty AS v FROM picking_items WHERE id='pi${i}'`);
        const lav = num(sqlite, `SELECT available_qty AS v FROM inventory_lots WHERE id='lot${i}'`);
        const q = Math.min(prem, lav, 3);
        if (q > 0) { const id = nextId("a"); createAllocation(db, { id, pickingItemId: `pi${i}`, qty: ri(q) + 1, inventoryLotId: `lot${i}` }); liveAlloc.push(id); }
      } else if (op === 4) {
        const i = ri(3);
        const prem = num(sqlite, `SELECT remaining_qty AS v FROM picking_items WHERE id='pi${i}'`);
        const rav = num(sqlite, `SELECT available_qty AS v FROM receiving_invoice_items WHERE id='rii${i}'`);
        const q = Math.min(prem, rav, 3);
        if (q > 0) {
          const id = nextId("a"); const qty = ri(q) + 1;
          createAllocation(db, { id, pickingItemId: `pi${i}`, qty, receivingOrderId: `ro${i}` });
          linkAllocation(db, { id: nextId("l"), allocationId: id, receivingInvoiceItemId: `rii${i}`, qty });
          liveAlloc.push(id);
        }
      } else if (op === 5) {
        if (liveAlloc.length > 0) { const id = liveAlloc.splice(ri(liveAlloc.length), 1)[0]!; deleteAllocation(db, id); }
      } else if (op === 6) {
        const i = ri(3);
        const prem = num(sqlite, `SELECT remaining_qty AS v FROM picking_items WHERE id='pi${i}'`);
        if (prem > 0) { const id = nextId("pp"); scanToPackage(db, { id, pickingItemId: `pi${i}`, qty: ri(Math.min(2, prem)) + 1, sourceType: "inventory_lot", sourceId: `lot${i}` }); unboxed.push({ id, box: `box${i}` }); }
      } else {
        if (unboxed.length > 0) { const p = unboxed.splice(ri(unboxed.length), 1)[0]!; assignPackageToBox(db, { packageId: p.id, shippingBoxId: p.box }); }
      }
      assertInvariantsHold(db);
    } catch (e) {
      sqlite.close();
      throw new Error(`failed at step ${step} op=${op} (seed=${SEED}): ${(e as Error).message}`);
    }
  }
  assertInvariantsHold(db);
  sqlite.close();
});
```

- [ ] **Step 3: Run — expect pass**

Run: `pnpm --filter @warehouse/api exec tsx --test src/db/invariants.property.test.ts`
Expected: PASS — `tests 1, pass 1, fail 0` (this is the proof that the maintained columns cannot drift).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/invariants.guard.ts apps/api/src/db/invariants.property.test.ts
git commit -m "test(api): add invariant guard and seeded property test for quantity maintenance"
```

---

### Task 15: Final verification gate

No new files. Confirms the whole foundation compiles and every test passes together.

- [ ] **Step 1: Full typecheck**

Run: `pnpm --filter @warehouse/api build`
Expected: exit 0, no type errors.

- [ ] **Step 2: Full test suite**

Run: `pnpm --filter @warehouse/api test`
Expected: PASS — health (1/1) + normalize (5) + client (2) + tables (6) + invariants.receiving (1) + invariants.allocation (1) + invariants.scan (1) + invariants.property (1) = 17 tests, 0 failures.

- [ ] **Step 3: Boot smoke (optional, manual)**

Run: `pnpm --filter @warehouse/api start` then in another shell `curl http://localhost:8787/health` (port per `server.ts`).
Expected: `{"ok":true,"db":"ok"}` 200, and `dev.sqlite` now contains the 22 tables.

No commit (verification only). If anything is red, fix in the relevant task before proceeding.

---

## Follow-on plans (not part of Plan 1)

Each is written after Plan 1 lands, against the real schema/invariant module:

- **Plan 2 — Allocation engine:** re-runnable `allocate()` (shelf-first → receiving FIFO, box-by-box vs grouped) composing `createAllocation`/`linkAllocation`; rewrite `findReceivingCandidates`/`findPickingCandidates` off maintained columns.
- **Plan 3 — Ingestion + triggers:** `PUT /api/receiving-orders/:external_id` and `PUT /api/picking-orders/:external_id` (idempotent snapshot upsert, line reconciliation, 409 rules); wire `allocate()` to PO-upsert and RO `pending→in_hand`.
- **Plan 4 — Tasks + polling:** `measuring_tasks`/`verification_tasks` creation triggers (PO finish → measuring; measuring complete → `pre_shipment`; stock change → coalesced `cycle_count`); `?status=&since=` polling endpoints.
- **Plan 5 — Seed port + frontend cutover:** port the demo seed to SQLite; point Nuxt at the API; remove PGlite.
