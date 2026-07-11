# Ingestion + Triggers (Plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add idempotent ingestion endpoints (idempotent `PUT` keyed by `external_id`) for receiving and picking orders to the Hono API, plus the trigger wiring that runs the Plan 2 allocation engine when a receiving order is confirmed in-hand and when a picking order is upserted — with line-level reconciliation and `409 Conflict` guards once work has started.

**Architecture:** Two new route modules (`routes/receiving.ts`, `routes/picking.ts`) delegate to pure, transaction-scoped helpers under `ingest/` (parts resolution with norm computation, line reconciliation, transition logging). All writes reuse the Plan 1 invariant primitives (`applyReceipt`, `recompute*`) and the Plan 2 entrypoints (`allocateAll`, `allocatePickingOrder`). Reconciliation is keyed by a new client-supplied stable line key (`receiving_invoice_items.line_no`, `picking_items.line_id`). Routes open a `db.transaction` for the upsert, then run allocation **after** the commit (mirrors the web pattern so an allocation failure can never roll back a confirmed state).

**Tech Stack:** Hono 4 (`hono`, `hono/http-exception`), `drizzle-orm/better-sqlite3`, `better-sqlite3`, raw `sql` template queries via `tx.get/all/run`, `node:test` + `tsx`, global `crypto.randomUUID()`. No new dependencies (no zod — validation is inline manual checks that throw `HTTPException`).

---

## Conventions (read first)

- **Shell:** the plain `pnpm` shim is BROKEN in this Git-Bash-on-Windows shell (`'node' is not recognized`). Prefix **every** verification command with `cmd.exe //c`:
  - Build: `cmd.exe //c "pnpm --filter @warehouse/api build"`
  - Tests: `cmd.exe //c "pnpm --filter @warehouse/api test"`
  - Do **not** "fix" `package.json` scripts; they are correct for normal shells.
- **Commits:** commit directly to `master`, never push. Stage explicit paths only (`git add <path1> <path2> …`, never `git add -A`). Pre-existing stray files are not yours — never stage them.
- **NodeNext:** all relative imports end in `.js`.
- **Timestamps:** `now()` from `db/now.ts` (ISO). **IDs:** global `crypto.randomUUID()`.
- **Generated columns (never write):** `picking_items.remaining_qty`, `inventory_lots.available_qty`. **Maintained columns (recompute, don't set by hand outside seeds):** `receiving_invoice_items.allocated_qty`/`available_qty`, `picking_items.allocated_qty`/`scanned_not_boxed_qty`, `inventory_lots.allocated_qty`.
- **Test backstop:** end every state-changing test with `assertInvariantsHold(db)` from `db/invariants.guard.ts`. Tests build an isolated DB via the `makeDb()` helper shown in `db/allocate.test.ts` (`createDb` + `createTables` + `drizzle(sqlite, { schema })`).
- **Transactions:** writes use `db.transaction((tx) => { … })`; better-sqlite3 is synchronous single-writer, so the default deferred BEGIN is fine and correctness is already proven by the Plan 2 property tests. (BEGIN IMMEDIATE at route boundaries is optional hardening, not required — do not add it.)

---

## File structure

**Create**
- `apps/api/src/ingest/parts.ts` — `resolveOrCreatePart(tx, partNo, description?)`: look up by `part_no_norm`; create if absent (compute `part_no_norm`); backfill `description`/`part_no` if the stored row differs. Returns the part `id`.
- `apps/api/src/ingest/transition.ts` — `logTransition(tx, { entityType, entityId, fromStatus, toStatus, actorId?, note? })`: inserts one `transition_logs` row.
- `apps/api/src/ingest/receiving.ts` — `upsertReceivingOrder(tx, externalId, body)` (pure; no allocation) and `confirmReceivingArrival(tx, orderId, actorId?)` (guard + flip + receipt + transition log). Throw `HTTPException(400|409)`.
- `apps/api/src/ingest/picking.ts` — `upsertPickingOrder(tx, externalId, body)` (pure; no allocation). Throw `HTTPException(400|409)`.
- `apps/api/src/ingest/suppliers.ts` — `resolveSupplierId(tx, code?)`: optional supplier_code → id; provided-but-unknown → `HTTPException(400)`.
- `apps/api/src/routes/receiving.ts` — `PUT /receiving-orders/:external_id`, `POST /receiving-orders/:external_id/confirm-arrival`.
- `apps/api/src/routes/picking.ts` — `PUT /picking-orders/:external_id`.
- `apps/api/src/ingest/parts.test.ts`, `apps/api/src/ingest/receiving.test.ts`, `apps/api/src/ingest/picking.test.ts`, `apps/api/src/routes/receiving.test.ts`, `apps/api/src/routes/picking.test.ts`.

**Modify**
- `apps/api/src/db/schema/receiving.ts` — add `lineNo` to `receivingInvoiceItems` (+ partial unique index note).
- `apps/api/src/db/schema/picking.ts` — add `lineId` to `pickingItems` (+ partial unique index note).
- `apps/api/src/db/tables.ts` — add `line_no` / `line_id` columns + `CREATE UNIQUE INDEX … WHERE … IS NOT NULL`.
- `apps/api/src/index.ts` — `app.route("/", receivingRoute)`, `app.route("/", pickingRoute)`.
- `packages/shared/src/index.ts` — add payload + response DTOs (type-only).

**Function surface (locked):**
```ts
// ingest/suppliers.ts
export function resolveSupplierId(tx: DbOrTx, code: string | null | undefined): string | null;

// ingest/parts.ts
export function resolveOrCreatePart(tx: DbOrTx, partNo: string, description?: string | null): string;

// ingest/transition.ts
export function logTransition(tx: DbOrTx, t: {
  entityType: string; entityId: string; fromStatus?: string | null; toStatus?: string | null;
  actorId?: string | null; note?: string | null;
}): void;

// ingest/receiving.ts
export interface ReceivingUpsertResult { orderId: string; created: boolean; changed: boolean; }
export function upsertReceivingOrder(tx: DbOrTx, externalId: string, body: ReceivingPutBody): ReceivingUpsertResult;
export function confirmReceivingArrival(tx: DbOrTx, orderId: string, actorId?: string | null): { fromStatus: string };

// ingest/picking.ts
export interface PickingUpsertResult { orderId: string; created: boolean; changed: boolean; }
export function upsertPickingOrder(tx: DbOrTx, externalId: string, body: PickingPutBody): PickingUpsertResult;
```
`DbOrTx` is imported from `db/invariants.ts`. `ReceivingPutBody` / `PickingPutBody` are imported from `@warehouse/shared` (Task 1).

---

## Proposed admin payload (FLAG: reconcile with the real admin app later)

The real admin payload shape was **not** inspected (the admin web app is out of scope). The plan proceeds with the shape below and the implementer must keep the parsing isolated in the route handlers so it is cheap to remap field names later.

`PUT /receiving-orders/:external_id` body:
```json
{
  "order": { "ref_no": "RO-001", "delivery_date": "2026-07-20", "supplier_code": "SUP-A" },
  "invoices": [
    { "invoice_no": "INV-1", "supplier_code": "SUP-A",
      "items": [
        { "line_no": 1, "part_no": "ABC-123", "description": "Widget", "qty": 100,
          "box_id": null, "date_code": "202401", "lot_code": "L1", "coo": "CN", "cow": "CN" }
      ] }
  ]
}
```
- `order.ref_no` required. `delivery_date`, `order.supplier_code` optional.
- Each invoice: `invoice_no` required; `supplier_code` optional (falls back to order supplier).
- Each item: `line_no` (integer, stable within the invoice) required — it is the reconciliation key; `part_no` required; `qty` required non-negative integer; `box_id`/`date_code`/`lot_code`/`coo`/`cow`/`description` optional.

`PUT /picking-orders/:external_id` body:
```json
{
  "order": { "ref_no": "PO-001", "ship_to": "Acme HQ", "destination_country": "US" },
  "items": [
    { "line_id": "L1", "part_no": "ABC-123", "qty": 50,
      "required_date_code": null, "source_shelf_code": null }
  ]
}
```
- `order.ref_no` required; `ship_to`/`destination_country` optional.
- Each item: `line_id` (string, client stable key) required — reconciliation key; `part_no` required; `qty` required non-negative integer; `required_date_code`/`source_shelf_code` optional.

Responses (both routes): create → `201 { id, external_id, created:true, changed:true }`; update → `200 { id, external_id, created:false, changed }`. Confirm → `200 { id, status:"in_hand" }`. Errors: `400 { error }` validation, `409 { error }` reconciliation/state conflict, `404 { error }` (confirm of unknown order).

---

### Task 1: Foundation — line-key columns, shared DTOs, parts + supplier resolvers

**Files:**
- Modify: `apps/api/src/db/schema/receiving.ts`
- Modify: `apps/api/src/db/schema/picking.ts`
- Modify: `apps/api/src/db/tables.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/api/src/ingest/suppliers.ts`
- Create: `apps/api/src/ingest/parts.ts`
- Test: `apps/api/src/ingest/parts.test.ts`

- [ ] **Step 1: Write the failing test** `apps/api/src/ingest/parts.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema/index.js";
import { createDb } from "../db/client.js";
import { createTables } from "../db/tables.js";
import { resolveOrCreatePart } from "./parts.js";
import { resolveSupplierId } from "./suppliers.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

test("resolveOrCreatePart creates a part with computed part_no_norm (O->0, I/L->1, Z->2, S->5)", () => {
  const { sqlite, db } = makeDb();
  const id = db.transaction((tx) => resolveOrCreatePart(tx, "ABO-ILZ S", "Widget"));
  const row = sqlite.prepare("SELECT part_no, part_no_norm, description FROM parts WHERE id=?").get(id) as any;
  assert.equal(row.part_no, "ABO-ILZ S");
  assert.equal(row.part_no_norm, "AB0-112 5"); // O->0, I->1, L->1, Z->2, S->5, collapse+upper
  assert.equal(row.description, "Widget");
  sqlite.close();
});

test("resolveOrCreatePart is idempotent on part_no_norm and backfills description", () => {
  const { sqlite, db } = makeDb();
  const a = db.transaction((tx) => resolveOrCreatePart(tx, "X1", null));
  const b = db.transaction((tx) => resolveOrCreatePart(tx, "XI", "Desc")); // XI and X1 normalize identically (I->1)
  assert.equal(a, b);
  const count = (sqlite.prepare("SELECT COUNT(*) c FROM parts").get() as any).c;
  assert.equal(count, 1);
  const desc = (sqlite.prepare("SELECT description FROM parts WHERE id=?").get(a) as any).description;
  assert.equal(desc, "Desc");
  sqlite.close();
});

test("resolveSupplierId returns id for known code, null for omitted, 400 for unknown code", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('s','SUP','S','0','0')`);
  assert.equal(db.transaction((tx) => resolveSupplierId(tx, "SUP")), "s");
  assert.equal(db.transaction((tx) => resolveSupplierId(tx, null)), null);
  assert.throws(() => db.transaction((tx) => resolveSupplierId(tx, "NOPE")), (e: any) => e.status === 400);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: FAIL — `Cannot find module './parts.js'` / `./suppliers.js`.

- [ ] **Step 3: Add line-key columns to the drizzle schema**

In `apps/api/src/db/schema/receiving.ts`, add `lineNo` and a (receiving_invoice_id, line_no) index:
```ts
// inside receivingInvoiceItems columns object, after cowNorm:
lineNo: integer("line_no"),
// inside the (t)=>({...}) index object, add:
invoiceLineUq: unique("rii_invoice_line_uq").on(t.receivingInvoiceId, t.lineNo),
```
(`unique` is already imported in this file.)

In `apps/api/src/db/schema/picking.ts`, add `lineId` and an index:
```ts
// inside pickingItems columns object, after remainingQty:
lineId: text("line_id"),
// inside the (t)=>({...}) index object, add:
orderLineUq: unique("picking_items_order_line_uq").on(t.pickingOrderId, t.lineId),
```
Add `unique` to the `drizzle-orm/sqlite-core` import in `picking.ts`.

- [ ] **Step 4: Add the columns + partial unique indexes to the raw DDL** in `apps/api/src/db/tables.ts`

Add `line_no INTEGER` to the `receiving_invoice_items` column list (after `cow_norm TEXT`), and after the `rii_invoice_idx` line add:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS rii_invoice_line_uq ON receiving_invoice_items(receiving_invoice_id, line_no) WHERE line_no IS NOT NULL;
```
Add `line_id TEXT` to the `picking_items` column list (after the `remaining_qty` generated line), and after the `picking_items_order_idx` line add:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS picking_items_order_line_uq ON picking_items(picking_order_id, line_id) WHERE line_id IS NOT NULL;
```
(SQLite allows many NULLs in a unique index; the `WHERE … IS NOT NULL` guard makes the intent explicit and keeps legacy NULL rows valid.)

- [ ] **Step 5: Add shared DTOs** to `packages/shared/src/index.ts` (append)

```ts
export interface ReceivingPutOrder {
  ref_no: string;
  delivery_date?: string | null;
  supplier_code?: string | null;
}
export interface ReceivingPutItem {
  line_no: number;
  part_no: string;
  description?: string | null;
  qty: number;
  box_id?: string | null;
  date_code?: string | null;
  lot_code?: string | null;
  coo?: string | null;
  cow?: string | null;
}
export interface ReceivingPutInvoice {
  invoice_no: string;
  supplier_code?: string | null;
  items: ReceivingPutItem[];
}
export interface ReceivingPutBody {
  order: ReceivingPutOrder;
  invoices: ReceivingPutInvoice[];
}

export interface PickingPutOrder {
  ref_no: string;
  ship_to?: string | null;
  destination_country?: string | null;
}
export interface PickingPutItem {
  line_id: string;
  part_no: string;
  qty: number;
  required_date_code?: string | null;
  source_shelf_code?: string | null;
}
export interface PickingPutBody {
  order: PickingPutOrder;
  items: PickingPutItem[];
}

export interface IngestUpsertResponse {
  id: string;
  external_id: string;
  created: boolean;
  changed: boolean;
}
export interface ConfirmArrivalResponse {
  id: string;
  status: "in_hand";
}
export interface ApiErrorBody {
  error: string;
}
```

- [ ] **Step 6: Implement the resolvers**

`apps/api/src/ingest/suppliers.ts`:
```ts
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db/invariants.js";

export function resolveSupplierId(tx: DbOrTx, code: string | null | undefined): string | null {
  if (code == null || code === "") return null;
  const row = tx.get<{ id: string }>(sql`SELECT id FROM suppliers WHERE code = ${code}`);
  if (!row) throw new HTTPException(400, { message: `unknown supplier_code: ${code}` });
  return row.id;
}
```

`apps/api/src/ingest/parts.ts`:
```ts
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db/invariants.js";
import { normalizePartNo } from "../db/schema/normalize.js";
import { now } from "../db/now.js";

export function resolveOrCreatePart(tx: DbOrTx, partNo: string, description?: string | null): string {
  const norm = normalizePartNo(partNo);
  if (!norm) throw new HTTPException(400, { message: "part_no is required" });
  const existing = tx.get<{ id: string; description: string | null; partNo: string }>(
    sql`SELECT id, description, part_no AS partNo FROM parts WHERE part_no_norm = ${norm} LIMIT 1`
  );
  if (existing) {
    if (description != null && description !== existing.description) {
      tx.run(sql`UPDATE parts SET description = ${description}, updated_at = ${now()} WHERE id = ${existing.id}`);
    }
    return existing.id;
  }
  const id = crypto.randomUUID();
  tx.run(
    sql`INSERT INTO parts (id, part_no, part_no_norm, description, created_at, updated_at)
        VALUES (${id}, ${partNo}, ${norm}, ${description ?? null}, ${now()}, ${now()})`
  );
  return id;
}
```

- [ ] **Step 7: Run the test — expect PASS, then build**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: PASS (3 tests in this file; prior suites still green).
Then: `cmd.exe //c "pnpm --filter @warehouse/api build"` — Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/db/schema/receiving.ts apps/api/src/db/schema/picking.ts apps/api/src/db/tables.ts packages/shared/src/index.ts apps/api/src/ingest/suppliers.ts apps/api/src/ingest/parts.ts apps/api/src/ingest/parts.test.ts
git commit -m "feat(api): line-key columns + parts/supplier resolvers (Plan 3 task 1)"
```

---

### Task 2: Receiving upsert — create path

**Files:**
- Create: `apps/api/src/ingest/transition.ts`
- Create: `apps/api/src/ingest/receiving.ts`
- Create: `apps/api/src/routes/receiving.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/ingest/receiving.test.ts`

- [ ] **Step 1: Write the failing test** `apps/api/src/ingest/receiving.test.ts` (create path only)

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema/index.js";
import { createDb } from "../db/client.js";
import { createTables } from "../db/tables.js";
import { upsertReceivingOrder } from "./receiving.js";
import { assertInvariantsHold } from "../db/invariants.guard.js";
import type { ReceivingPutBody } from "@warehouse/shared";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('s','SUP','S','0','0')`);
  return { sqlite, db };
}

test("upsertReceivingOrder creates order + invoices + items with norms; received_qty stays 0 while pending", () => {
  const { sqlite, db } = makeDb();
  const body: ReceivingPutBody = {
    order: { ref_no: "RO-1", delivery_date: "2026-07-20", supplier_code: "SUP" },
    invoices: [
      { invoice_no: "INV-1", items: [
        { line_no: 1, part_no: "ABO", qty: 100, date_code: "2024O1", coo: "cn" },
        { line_no: 2, part_no: "X1", qty: 5, box_id: "B1" },
      ] },
      { invoice_no: "INV-2", supplier_code: "SUP", items: [
        { line_no: 1, part_no: "ABO", qty: 50 },
      ] },
    ],
  };
  const res = db.transaction((tx) => upsertReceivingOrder(tx, "EXT-1", body));
  assert.equal(res.created, true);
  assert.equal(res.changed, true);

  const ro = sqlite.prepare("SELECT status, supplier_id, ref_no FROM receiving_orders WHERE external_id='EXT-1'").get() as any;
  assert.equal(ro.status, "pending");
  assert.equal(ro.supplier_id, "s");
  assert.equal(ro.ref_no, "RO-1");

  const items = sqlite.prepare(`
    SELECT rii.qty, rii.received_qty, rii.box_id, rii.date_code_norm, rii.coo_norm, ri.invoice_no, rii.line_no
    FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id=rii.receiving_invoice_id
    ORDER BY ri.invoice_no, rii.line_no`).all() as any[];
  assert.deepEqual(items, [
    { qty: 100, received_qty: 0, box_id: null, date_code_norm: "202401", coo_norm: "CN", invoice_no: "INV-1", line_no: 1 },
    { qty: 5, received_qty: 0, box_id: "B1", date_code_norm: null, coo_norm: null, invoice_no: "INV-1", line_no: 2 },
    { qty: 50, received_qty: 0, box_id: null, date_code_norm: null, coo_norm: null, invoice_no: "INV-2", line_no: 1 },
  ]);
  // parts deduped by norm: ABO used twice -> one part
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM parts").get() as any).c, 2);
  assertInvariantsHold(db);
  sqlite.close();
});

test("upsertReceivingOrder rejects a missing ref_no and a negative qty with 400", () => {
  const { db } = makeDb();
  assert.throws(
    () => db.transaction((tx) => upsertReceivingOrder(tx, "E", { order: { ref_no: "" }, invoices: [] } as any)),
    (e: any) => e.status === 400
  );
  assert.throws(
    () => db.transaction((tx) => upsertReceivingOrder(tx, "E2", {
      order: { ref_no: "R" }, invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: -1 }] }],
    } as any)),
    (e: any) => e.status === 400
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: FAIL — `Cannot find module './receiving.js'`.

- [ ] **Step 3: Implement the transition logger** `apps/api/src/ingest/transition.ts`

```ts
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../db/invariants.js";
import { now } from "../db/now.js";

export function logTransition(
  tx: DbOrTx,
  t: { entityType: string; entityId: string; fromStatus?: string | null; toStatus?: string | null; actorId?: string | null; note?: string | null }
): void {
  tx.run(
    sql`INSERT INTO transition_logs (id, entity_type, entity_id, from_status, to_status, actor_id, note, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${t.entityType}, ${t.entityId}, ${t.fromStatus ?? null}, ${t.toStatus ?? null},
                ${t.actorId ?? null}, ${t.note ?? null}, ${now()}, ${now()})`
  );
}
```

- [ ] **Step 4: Implement `ingest/receiving.ts` (create + update scaffolding; full reconciliation lands in Task 3)**

```ts
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db/invariants.js";
import { now } from "../db/now.js";
import { normalizeCode, normalizePlain } from "../db/schema/normalize.js";
import { resolveOrCreatePart } from "./parts.js";
import { resolveSupplierId } from "./suppliers.js";
import type { ReceivingPutBody, ReceivingPutInvoice, ReceivingPutItem } from "@warehouse/shared";

export interface ReceivingUpsertResult { orderId: string; created: boolean; changed: boolean; }

function validate(body: ReceivingPutBody): void {
  if (!body?.order?.ref_no) throw new HTTPException(400, { message: "order.ref_no is required" });
  if (!Array.isArray(body.invoices) || body.invoices.length === 0)
    throw new HTTPException(400, { message: "invoices[] is required" });
  for (const inv of body.invoices) {
    if (!inv.invoice_no) throw new HTTPException(400, { message: "invoice_no is required" });
    if (!Array.isArray(inv.items) || inv.items.length === 0)
      throw new HTTPException(400, { message: `invoice ${inv.invoice_no}: items[] required` });
    for (const it of inv.items) {
      if (!Number.isInteger(it.line_no)) throw new HTTPException(400, { message: "line_no must be an integer" });
      if (!it.part_no) throw new HTTPException(400, { message: "part_no is required" });
      if (!Number.isInteger(it.qty) || it.qty < 0) throw new HTTPException(400, { message: "qty must be a non-negative integer" });
    }
  }
}

function itemNorms(it: ReceivingPutItem) {
  return {
    dateCode: it.date_code ?? null, lotCode: it.lot_code ?? null, coo: it.coo ?? null, cow: it.cow ?? null,
    dateCodeNorm: normalizeCode(it.date_code), lotCodeNorm: normalizeCode(it.lot_code),
    cooNorm: normalizePlain(it.coo), cowNorm: normalizePlain(it.cow),
  };
}

function upsertInvoice(tx: DbOrTx, orderId: string, inv: ReceivingPutInvoice, fallbackSupplierId: string | null): string {
  const supplierId = inv.supplier_code !== undefined ? resolveSupplierId(tx, inv.supplier_code) : fallbackSupplierId;
  const existing = tx.get<{ id: string }>(
    sql`SELECT id FROM receiving_invoices WHERE receiving_order_id = ${orderId} AND invoice_no = ${inv.invoice_no}`
  );
  if (existing) {
    tx.run(sql`UPDATE receiving_invoices SET supplier_id = ${supplierId}, updated_at = ${now()} WHERE id = ${existing.id}`);
    return existing.id;
  }
  const id = crypto.randomUUID();
  tx.run(
    sql`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
        VALUES (${id}, ${orderId}, ${inv.invoice_no}, ${supplierId}, ${now()}, ${now()})`
  );
  return id;
}

export function upsertReceivingOrder(tx: DbOrTx, externalId: string, body: ReceivingPutBody): ReceivingUpsertResult {
  validate(body);
  const orderSupplierId = resolveSupplierId(tx, body.order.supplier_code);
  const existing = tx.get<{ id: string; status: string }>(
    sql`SELECT id, status FROM receiving_orders WHERE external_id = ${externalId}`
  );

  if (!existing) {
    const orderId = crypto.randomUUID();
    tx.run(
      sql`INSERT INTO receiving_orders (id, external_id, ref_no, delivery_date, status, supplier_id, created_at, updated_at)
          VALUES (${orderId}, ${externalId}, ${body.order.ref_no}, ${body.order.delivery_date ?? null}, 'pending',
                  ${orderSupplierId}, ${now()}, ${now()})`
    );
    for (const inv of body.invoices) {
      const invoiceId = upsertInvoice(tx, orderId, inv, orderSupplierId);
      for (const it of inv.items) {
        const partId = resolveOrCreatePart(tx, it.part_no, it.description);
        const n = itemNorms(it);
        tx.run(
          sql`INSERT INTO receiving_invoice_items
              (id, receiving_invoice_id, part_id, qty, box_id, date_code, lot_code, coo, cow,
               date_code_norm, lot_code_norm, coo_norm, cow_norm, line_no, created_at, updated_at)
              VALUES (${crypto.randomUUID()}, ${invoiceId}, ${partId}, ${it.qty}, ${it.box_id ?? null},
                      ${n.dateCode}, ${n.lotCode}, ${n.coo}, ${n.cow}, ${n.dateCodeNorm}, ${n.lotCodeNorm},
                      ${n.cooNorm}, ${n.cowNorm}, ${it.line_no}, ${now()}, ${now()})`
        );
      }
    }
    return { orderId, created: true, changed: true };
  }

  // Update path: full reconciliation implemented in Task 3.
  return reconcileReceivingOrder(tx, existing.id, existing.status, body, orderSupplierId);
}

// placeholder so Task 2 compiles; replaced in Task 3.
function reconcileReceivingOrder(
  _tx: DbOrTx, _orderId: string, _status: string, _body: ReceivingPutBody, _orderSupplierId: string | null
): ReceivingUpsertResult {
  throw new Error("reconcileReceivingOrder implemented in Task 3");
}
```

- [ ] **Step 5: Wire the route + mount it**

`apps/api/src/routes/receiving.ts`:
```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { IngestUpsertResponse, ReceivingPutBody } from "@warehouse/shared";
import { db } from "../db.js";
import { upsertReceivingOrder } from "../ingest/receiving.js";

export const receivingRoute = new Hono();

receivingRoute.put("/receiving-orders/:external_id", async (c) => {
  const externalId = c.req.param("external_id");
  let body: ReceivingPutBody;
  try {
    body = await c.req.json<ReceivingPutBody>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const result = db.transaction((tx) => upsertReceivingOrder(tx, externalId, body));
  const res: IngestUpsertResponse = { id: result.orderId, external_id: externalId, created: result.created, changed: result.changed };
  return c.json(res, result.created ? 201 : 200);
});
```

In `apps/api/src/index.ts`, add the import + mount:
```ts
import { receivingRoute } from "./routes/receiving.js";
// after app.route("/", healthRoute);
app.route("/", receivingRoute);
```

- [ ] **Step 6: Run the test — expect PASS (create tests), then build**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: PASS for the create-path tests. (The update-path throws the Task-3 placeholder — no update test runs yet.)
Then: `cmd.exe //c "pnpm --filter @warehouse/api build"` — Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/ingest/transition.ts apps/api/src/ingest/receiving.ts apps/api/src/ingest/receiving.test.ts apps/api/src/routes/receiving.ts apps/api/src/index.ts
git commit -m "feat(api): receiving upsert create path + route (Plan 3 task 2)"
```

---

### Task 3: Receiving upsert — update / reconcile + no-op idempotency

**Files:**
- Modify: `apps/api/src/ingest/receiving.ts` (replace `reconcileReceivingOrder` placeholder)
- Test: `apps/api/src/ingest/receiving.test.ts` (append)

- [ ] **Step 1: Append failing tests** to `apps/api/src/ingest/receiving.test.ts`

```ts
test("re-PUT of an identical payload is a no-op (changed=false, updated_at unchanged)", () => {
  const { sqlite, db } = makeDb();
  const body: ReceivingPutBody = {
    order: { ref_no: "RO-1", delivery_date: "2026-07-20" },
    invoices: [{ invoice_no: "INV-1", items: [{ line_no: 1, part_no: "ABO", qty: 100, date_code: "202401" }] }],
  };
  const first = db.transaction((tx) => upsertReceivingOrder(tx, "EXT-1", body));
  const stamp = (sqlite.prepare("SELECT updated_at FROM receiving_orders WHERE id=?").get(first.orderId) as any).updated_at;
  const itemStamp = (sqlite.prepare("SELECT updated_at FROM receiving_invoice_items").get() as any).updated_at;

  const second = db.transaction((tx) => upsertReceivingOrder(tx, "EXT-1", body));
  assert.equal(second.created, false);
  assert.equal(second.changed, false);
  assert.equal((sqlite.prepare("SELECT updated_at FROM receiving_orders WHERE id=?").get(first.orderId) as any).updated_at, stamp);
  assert.equal((sqlite.prepare("SELECT updated_at FROM receiving_invoice_items").get() as any).updated_at, itemStamp);
  sqlite.close();
});

test("update adds a line, changes a qty (pending), and removes an untouched line", () => {
  const { sqlite, db } = makeDb();
  const v1: ReceivingPutBody = {
    order: { ref_no: "RO-1" },
    invoices: [{ invoice_no: "INV-1", items: [
      { line_no: 1, part_no: "ABO", qty: 100 },
      { line_no: 2, part_no: "X1", qty: 5 },
    ] }],
  };
  const first = db.transaction((tx) => upsertReceivingOrder(tx, "EXT-1", v1));

  const v2: ReceivingPutBody = {
    order: { ref_no: "RO-1" },
    invoices: [{ invoice_no: "INV-1", items: [
      { line_no: 1, part_no: "ABO", qty: 120 },           // changed qty
      { line_no: 3, part_no: "Z9", qty: 7 },              // added
      // line_no 2 removed (pending, no work) -> deleted
    ] }],
  };
  const second = db.transaction((tx) => upsertReceivingOrder(tx, "EXT-1", v2));
  assert.equal(second.created, false);
  assert.equal(second.changed, true);

  const rows = sqlite.prepare(`
    SELECT rii.line_no, rii.qty, p.part_no FROM receiving_invoice_items rii
    JOIN parts p ON p.id=rii.part_id JOIN receiving_invoices ri ON ri.id=rii.receiving_invoice_id
    WHERE ri.receiving_order_id=? ORDER BY rii.line_no`).all(first.orderId) as any[];
  assert.deepEqual(rows, [
    { line_no: 1, qty: 120, part_no: "ABO" },
    { line_no: 3, qty: 7, part_no: "Z9" },
  ]);
  assertInvariantsHold(db);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: FAIL — `reconcileReceivingOrder implemented in Task 3`.

- [ ] **Step 3: Replace the placeholder with full reconciliation** in `apps/api/src/ingest/receiving.ts`

Replace the `reconcileReceivingOrder` placeholder (and keep everything else). Add this helper above it:

```ts
interface ExistingItem {
  id: string; invoiceId: string; lineNo: number; partId: string; qty: number;
  boxId: string | null; dateCodeNorm: string | null; lotCodeNorm: string | null;
  cooNorm: string | null; cowNorm: string | null;
  receivedQty: number; pickedQty: number; putAwayQty: number; allocLinks: number;
}

function loadExistingItems(tx: DbOrTx, orderId: string): ExistingItem[] {
  return tx.all<ExistingItem>(sql`
    SELECT rii.id, ri.id AS invoiceId, rii.line_no AS lineNo, rii.part_id AS partId, rii.qty,
           rii.box_id AS boxId, rii.date_code_norm AS dateCodeNorm, rii.lot_code_norm AS lotCodeNorm,
           rii.coo_norm AS cooNorm, rii.cow_norm AS cowNorm,
           rii.received_qty AS receivedQty, rii.picked_qty AS pickedQty, rii.put_away_qty AS putAwayQty,
           (SELECT COUNT(*) FROM allocation_receiving_items ari WHERE ari.receiving_invoice_item_id = rii.id) AS allocLinks
    FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE ri.receiving_order_id = ${orderId}`);
}
```

Then the real `reconcileReceivingOrder`:
```ts
function reconcileReceivingOrder(
  tx: DbOrTx, orderId: string, status: string, body: ReceivingPutBody, orderSupplierId: string | null
): ReceivingUpsertResult {
  let changed = false;
  const ro = tx.get<{ refNo: string; deliveryDate: string | null; supplierId: string | null }>(
    sql`SELECT ref_no AS refNo, delivery_date AS deliveryDate, supplier_id AS supplierId FROM receiving_orders WHERE id = ${orderId}`
  )!;
  const newDelivery = body.order.delivery_date ?? null;
  if (ro.refNo !== body.order.ref_no || ro.deliveryDate !== newDelivery || ro.supplierId !== orderSupplierId) {
    tx.run(sql`UPDATE receiving_orders SET ref_no = ${body.order.ref_no}, delivery_date = ${newDelivery},
               supplier_id = ${orderSupplierId}, updated_at = ${now()} WHERE id = ${orderId}`);
    changed = true;
  }

  const locked = status !== "pending"; // once in_hand/clear: qty may only increase; no line removal
  const existingItems = loadExistingItems(tx, orderId);
  const seenKeys = new Set<string>();

  for (const inv of body.invoices) {
    const invoiceId = upsertInvoice(tx, orderId, inv, orderSupplierId);
    for (const it of inv.items) {
      const key = `${invoiceId}:${it.line_no}`;
      seenKeys.add(key);
      const partId = resolveOrCreatePart(tx, it.part_no, it.description);
      const n = itemNorms(it);
      const ex = existingItems.find((e) => e.invoiceId === invoiceId && e.lineNo === it.line_no);

      if (!ex) {
        tx.run(
          sql`INSERT INTO receiving_invoice_items
              (id, receiving_invoice_id, part_id, qty, box_id, date_code, lot_code, coo, cow,
               date_code_norm, lot_code_norm, coo_norm, cow_norm, line_no, created_at, updated_at)
              VALUES (${crypto.randomUUID()}, ${invoiceId}, ${partId}, ${it.qty}, ${it.box_id ?? null},
                      ${n.dateCode}, ${n.lotCode}, ${n.coo}, ${n.cow}, ${n.dateCodeNorm}, ${n.lotCodeNorm},
                      ${n.cooNorm}, ${n.cowNorm}, ${it.line_no}, ${now()}, ${now()})`
        );
        changed = true;
        continue;
      }

      if (it.qty < ex.qty) {
        if (locked) throw new HTTPException(409, { message: `invoice ${inv.invoice_no} line ${it.line_no}: qty may only increase once ${status}` });
        if (ex.allocLinks > 0 || ex.receivedQty > 0 || ex.pickedQty > 0 || ex.putAwayQty > 0)
          throw new HTTPException(409, { message: `invoice ${inv.invoice_no} line ${it.line_no}: cannot decrease qty after work started` });
      }
      const same =
        ex.partId === partId && ex.qty === it.qty && (ex.boxId ?? null) === (it.box_id ?? null) &&
        ex.dateCodeNorm === n.dateCodeNorm && ex.lotCodeNorm === n.lotCodeNorm &&
        ex.cooNorm === n.cooNorm && ex.cowNorm === n.cowNorm;
      if (!same) {
        tx.run(
          sql`UPDATE receiving_invoice_items SET part_id = ${partId}, qty = ${it.qty}, box_id = ${it.box_id ?? null},
              date_code = ${n.dateCode}, lot_code = ${n.lotCode}, coo = ${n.coo}, cow = ${n.cow},
              date_code_norm = ${n.dateCodeNorm}, lot_code_norm = ${n.lotCodeNorm}, coo_norm = ${n.cooNorm},
              cow_norm = ${n.cowNorm}, updated_at = ${now()} WHERE id = ${ex.id}`
        );
        changed = true;
      }
    }
  }

  // remove lines absent from the snapshot (only if no work started)
  for (const ex of existingItems) {
    const key = `${ex.invoiceId}:${ex.lineNo}`;
    if (seenKeys.has(key)) continue;
    if (locked) throw new HTTPException(409, { message: `cannot remove a line once ${status}` });
    if (ex.allocLinks > 0 || ex.receivedQty > 0 || ex.pickedQty > 0 || ex.putAwayQty > 0)
      throw new HTTPException(409, { message: "cannot remove a line after work started" });
    tx.run(sql`DELETE FROM receiving_invoice_items WHERE id = ${ex.id}`);
    changed = true;
  }

  if (changed) tx.run(sql`UPDATE receiving_orders SET updated_at = ${now()} WHERE id = ${orderId}`);
  return { orderId, created: false, changed };
}
```

- [ ] **Step 4: Run the tests — expect PASS, then build**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: PASS (create + idempotency + reconcile).
Then: `cmd.exe //c "pnpm --filter @warehouse/api build"` — Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingest/receiving.ts apps/api/src/ingest/receiving.test.ts
git commit -m "feat(api): receiving upsert reconcile + no-op idempotency (Plan 3 task 3)"
```

---

### Task 4: Receiving 409 guards

**Files:**
- Test: `apps/api/src/ingest/receiving.test.ts` (append)

(No production code changes — the guards were written in Task 3. This task locks them with tests.)

- [ ] **Step 1: Append failing tests**

```ts
function seedInHand(sqlite: any, orderId: string) {
  sqlite.prepare("UPDATE receiving_orders SET status='in_hand' WHERE id=?").run(orderId);
}

test("in_hand: decreasing a line qty is 409", () => {
  const { sqlite, db } = makeDb();
  const v1: ReceivingPutBody = { order: { ref_no: "R" }, invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 100 }] }] };
  const r = db.transaction((tx) => upsertReceivingOrder(tx, "E", v1));
  seedInHand(sqlite, r.orderId);
  const v2: ReceivingPutBody = { order: { ref_no: "R" }, invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 99 }] }] };
  assert.throws(() => db.transaction((tx) => upsertReceivingOrder(tx, "E", v2)), (e: any) => e.status === 409);
  sqlite.close();
});

test("in_hand: increasing a line qty is allowed", () => {
  const { sqlite, db } = makeDb();
  const v1: ReceivingPutBody = { order: { ref_no: "R" }, invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 100 }] }] };
  const r = db.transaction((tx) => upsertReceivingOrder(tx, "E", v1));
  seedInHand(sqlite, r.orderId);
  const v2: ReceivingPutBody = { order: { ref_no: "R" }, invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 150 }] }] };
  const r2 = db.transaction((tx) => upsertReceivingOrder(tx, "E", v2));
  assert.equal(r2.changed, true);
  assert.equal((sqlite.prepare("SELECT qty FROM receiving_invoice_items").get() as any).qty, 150);
  sqlite.close();
});

test("in_hand: removing a line is 409", () => {
  const { sqlite, db } = makeDb();
  const v1: ReceivingPutBody = { order: { ref_no: "R" }, invoices: [{ invoice_no: "I", items: [
    { line_no: 1, part_no: "P", qty: 100 }, { line_no: 2, part_no: "Q", qty: 5 }] }] };
  const r = db.transaction((tx) => upsertReceivingOrder(tx, "E", v1));
  seedInHand(sqlite, r.orderId);
  const v2: ReceivingPutBody = { order: { ref_no: "R" }, invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 100 }] }] };
  assert.throws(() => db.transaction((tx) => upsertReceivingOrder(tx, "E", v2)), (e: any) => e.status === 409);
  sqlite.close();
});

test("pending: removing a line that already has a receipt is 409", () => {
  const { sqlite, db } = makeDb();
  const v1: ReceivingPutBody = { order: { ref_no: "R" }, invoices: [{ invoice_no: "I", items: [
    { line_no: 1, part_no: "P", qty: 100 }, { line_no: 2, part_no: "Q", qty: 5 }] }] };
  db.transaction((tx) => upsertReceivingOrder(tx, "E", v1));
  // simulate work started on line 2 while still pending (defense): set received_qty>0 on line_no 2
  sqlite.prepare(`UPDATE receiving_invoice_items SET received_qty=1, available_qty=1 WHERE line_no=2`).run();
  const v2: ReceivingPutBody = { order: { ref_no: "R" }, invoices: [{ invoice_no: "I", items: [{ line_no: 1, part_no: "P", qty: 100 }] }] };
  assert.throws(() => db.transaction((tx) => upsertReceivingOrder(tx, "E", v2)), (e: any) => e.status === 409);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails (sanity — should already pass against Task-3 code)**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: these four PASS immediately (guards implemented in Task 3). If any fail, the guard is missing — fix `reconcileReceivingOrder` before committing.

- [ ] **Step 3: Build + commit**

Run: `cmd.exe //c "pnpm --filter @warehouse/api build"` — Expected: exit 0.
```bash
git add apps/api/src/ingest/receiving.test.ts
git commit -m "test(api): receiving 409 reconciliation guards (Plan 3 task 4)"
```

---

### Task 5: Receiving confirm-arrival trigger (pending → in_hand → allocateAll)

**Files:**
- Modify: `apps/api/src/ingest/receiving.ts` (add `confirmReceivingArrival`)
- Modify: `apps/api/src/routes/receiving.ts` (add `POST …/confirm-arrival`)
- Test: `apps/api/src/routes/receiving.test.ts`

- [ ] **Step 1: Write the failing test** `apps/api/src/routes/receiving.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createTables } from "../db/tables.js";

// point the app's db at a temp file BEFORE importing the app
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
const dbPath = path.join(dir, "t.sqlite");
process.env.DATABASE_URL = dbPath;
const { app } = await import("../index.js");

const sqlite = new Database(dbPath);

test("PUT receiving -> confirm-arrival flips to in_hand, sets received_qty=qty, logs transition, allocates", async () => {
  // a picking order for part ABO qty 60 already exists and needs stock
  sqlite.exec(`INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('pABO','ABO','AB0','0','0')`);
  sqlite.exec(`INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','pe','PO','picking','0','0')`);
  sqlite.exec(`INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','pABO',60,'0','0')`);

  const put = await app.request("/receiving-orders/EXT-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: { ref_no: "RO-1" }, invoices: [{ invoice_no: "INV-1", items: [{ line_no: 1, part_no: "ABO", qty: 100 }] }] }),
  });
  assert.equal(put.status, 201);

  const confirm = await app.request("/receiving-orders/EXT-1/confirm-arrival", { method: "POST" });
  assert.equal(confirm.status, 200);
  const body = (await confirm.json()) as { id: string; status: string };
  assert.equal(body.status, "in_hand");

  const ro = sqlite.prepare("SELECT status FROM receiving_orders WHERE external_id='EXT-1'").get() as any;
  assert.equal(ro.status, "in_hand");
  const rii = sqlite.prepare("SELECT received_qty, available_qty, allocated_qty FROM receiving_invoice_items").get() as any;
  assert.equal(rii.received_qty, 100);
  assert.equal(rii.allocated_qty, 60);   // allocateAll ran after commit
  assert.equal(rii.available_qty, 40);   // 100 received - 60 allocated
  const logs = sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='receiving_order' AND to_status='in_hand'").get() as any;
  assert.equal(logs.c, 1);
});

test("confirm-arrival is 409 when not pending and 404 when unknown", async () => {
  const miss = await app.request("/receiving-orders/NOPE/confirm-arrival", { method: "POST" });
  assert.equal(miss.status, 404);

  sqlite.exec(`INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro2','E2','R','in_hand','0','0')`);
  const again = await app.request("/receiving-orders/E2/confirm-arrival", { method: "POST" });
  assert.equal(again.status, 409);
});

// close the temp DB so other test files are unaffected
test("cleanup", () => { sqlite.close(); });
```

> Note: `process.env.DATABASE_URL` must be set **before** `../index.js` is imported, because `db.ts` resolves the path at import. The dynamic `await import()` above guarantees ordering within this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: FAIL — route not found / `confirmReceivingArrival` not exported.

- [ ] **Step 3: Add `confirmReceivingArrival`** to `apps/api/src/ingest/receiving.ts`

```ts
import { applyReceipt } from "../db/invariants.js";  // add to existing import from invariants
import { logTransition } from "./transition.js";

export function confirmReceivingArrival(tx: DbOrTx, orderId: string, actorId?: string | null): { fromStatus: string } {
  const ro = tx.get<{ id: string; status: string }>(sql`SELECT id, status FROM receiving_orders WHERE id = ${orderId}`);
  if (!ro) throw new HTTPException(404, { message: "receiving order not found" });
  if (ro.status !== "pending") throw new HTTPException(409, { message: `cannot confirm arrival from status ${ro.status}` });

  const items = tx.all<{ id: string; qty: number }>(
    sql`SELECT rii.id, rii.qty FROM receiving_invoice_items rii
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id WHERE ri.receiving_order_id = ${orderId}`
  );
  tx.run(sql`UPDATE receiving_orders SET status = 'in_hand', updated_at = ${now()} WHERE id = ${orderId}`);
  for (const it of items) applyReceipt(tx, it.id, it.qty); // received_qty 0 -> qty; recomputes available_qty
  logTransition(tx, { entityType: "receiving_order", entityId: orderId, fromStatus: ro.status, toStatus: "in_hand", actorId: actorId ?? null });
  return { fromStatus: ro.status };
}
```

- [ ] **Step 4: Add the confirm route + run allocation after commit** in `apps/api/src/routes/receiving.ts`

```ts
import { allocateAll } from "../db/allocate.js";
import { confirmReceivingArrival } from "../ingest/receiving.js";  // append to existing import
import type { ConfirmArrivalResponse } from "@warehouse/shared";

receivingRoute.post("/receiving-orders/:external_id/confirm-arrival", (c) => {
  const externalId = c.req.param("external_id");
  const order = db
    .transaction((tx) => {
      const found = tx.get<{ id: string }>(sql`SELECT id FROM receiving_orders WHERE external_id = ${externalId}`); // see note
      if (!found) throw new HTTPException(404, { message: "receiving order not found" });
      confirmReceivingArrival(tx, found.id);
      return found;
    });
  allocateAll(db); // AFTER commit — mirrors web pattern; allocation failure cannot roll back the flip
  const res: ConfirmArrivalResponse = { id: order.id, status: "in_hand" };
  return c.json(res, 200);
});
```
Add the `sql` import to this route file: `import { sql } from "drizzle-orm";`.

- [ ] **Step 5: Run the tests — expect PASS, then build**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: PASS. (The two confirm tests + cleanup pass; create/idempotency/409 suites still green.)
Then: `cmd.exe //c "pnpm --filter @warehouse/api build"` — Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/ingest/receiving.ts apps/api/src/routes/receiving.ts apps/api/src/routes/receiving.test.ts
git commit -m "feat(api): confirm-arrival trigger -> allocateAll (Plan 3 task 5)"
```

---

### Task 6: Picking upsert — create / update / reconcile + idempotency

**Files:**
- Create: `apps/api/src/ingest/picking.ts`
- Create: `apps/api/src/routes/picking.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/ingest/picking.test.ts`

- [ ] **Step 1: Write the failing test** `apps/api/src/ingest/picking.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema/index.js";
import { createDb } from "../db/client.js";
import { createTables } from "../db/tables.js";
import { upsertPickingOrder } from "./picking.js";
import { assertInvariantsHold } from "../db/invariants.guard.js";
import type { PickingPutBody } from "@warehouse/shared";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

test("upsertPickingOrder creates order + items; remaining_qty generated = qty", () => {
  const { sqlite, db } = makeDb();
  const body: PickingPutBody = {
    order: { ref_no: "PO-1", ship_to: "Acme", destination_country: "US" },
    items: [
      { line_id: "L1", part_no: "ABO", qty: 50, required_date_code: "2024O1" },
      { line_id: "L2", part_no: "X1", qty: 10 },
    ],
  };
  const res = db.transaction((tx) => upsertPickingOrder(tx, "PE-1", body));
  assert.equal(res.created, true);
  const po = sqlite.prepare("SELECT status, ship_to FROM picking_orders WHERE external_id='PE-1'").get() as any;
  assert.equal(po.status, "pending");
  assert.equal(po.ship_to, "Acme");
  const items = sqlite.prepare("SELECT line_id, qty, remaining_qty FROM picking_items ORDER BY line_id").all() as any[];
  assert.deepEqual(items, [
    { line_id: "L1", qty: 50, remaining_qty: 50 },
    { line_id: "L2", qty: 10, remaining_qty: 10 },
  ]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("re-PUT identical picking payload is a no-op; update adds/changes/removes untouched lines", () => {
  const { sqlite, db } = makeDb();
  const v1: PickingPutBody = { order: { ref_no: "PO-1" }, items: [
    { line_id: "L1", part_no: "ABO", qty: 50 }, { line_id: "L2", part_no: "X1", qty: 10 }] };
  const r = db.transaction((tx) => upsertPickingOrder(tx, "PE-1", v1));
  const stamp = (sqlite.prepare("SELECT updated_at FROM picking_orders WHERE id=?").get(r.orderId) as any).updated_at;

  const noop = db.transaction((tx) => upsertPickingOrder(tx, "PE-1", v1));
  assert.equal(noop.changed, false);
  assert.equal((sqlite.prepare("SELECT updated_at FROM picking_orders WHERE id=?").get(r.orderId) as any).updated_at, stamp);

  const v2: PickingPutBody = { order: { ref_no: "PO-1" }, items: [
    { line_id: "L1", part_no: "ABO", qty: 80 },   // increase (pending, no work) -> ok
    { line_id: "L3", part_no: "Z9", qty: 3 },     // added
    // L2 removed (pending, no allocations/scans) -> deleted
  ] };
  const r2 = db.transaction((tx) => upsertPickingOrder(tx, "PE-1", v2));
  assert.equal(r2.changed, true);
  const rows = sqlite.prepare("SELECT line_id, qty FROM picking_items ORDER BY line_id").all() as any[];
  assert.deepEqual(rows, [{ line_id: "L1", qty: 80 }, { line_id: "L3", qty: 3 }]);
  assertInvariantsHold(db);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: FAIL — `Cannot find module './picking.js'`.

- [ ] **Step 3: Implement `ingest/picking.ts`**

```ts
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DbOrTx } from "../db/invariants.js";
import { now } from "../db/now.js";
import { resolveOrCreatePart } from "./parts.js";
import type { PickingPutBody } from "@warehouse/shared";

export interface PickingUpsertResult { orderId: string; created: boolean; changed: boolean; }

function validate(body: PickingPutBody): void {
  if (!body?.order?.ref_no) throw new HTTPException(400, { message: "order.ref_no is required" });
  if (!Array.isArray(body.items) || body.items.length === 0)
    throw new HTTPException(400, { message: "items[] is required" });
  for (const it of body.items) {
    if (!it.line_id) throw new HTTPException(400, { message: "line_id is required" });
    if (!it.part_no) throw new HTTPException(400, { message: "part_no is required" });
    if (!Number.isInteger(it.qty) || it.qty < 0) throw new HTTPException(400, { message: "qty must be a non-negative integer" });
  }
}

interface ExistingPickingItem {
  id: string; lineId: string; partId: string; qty: number; pickedQty: number;
  scannedNotBoxedQty: number; requiredDateCode: string | null; sourceShelfCode: string | null; allocCount: number;
}

function loadExisting(tx: DbOrTx, orderId: string): ExistingPickingItem[] {
  return tx.all<ExistingPickingItem>(sql`
    SELECT pi.id, pi.line_id AS lineId, pi.part_id AS partId, pi.qty, pi.picked_qty AS pickedQty,
           pi.scanned_not_boxed_qty AS scannedNotBoxedQty, pi.required_date_code AS requiredDateCode,
           pi.source_shelf_code AS sourceShelfCode,
           (SELECT COUNT(*) FROM allocations a WHERE a.picking_item_id = pi.id) AS allocCount
    FROM picking_items pi WHERE pi.picking_order_id = ${orderId}`);
}

export function upsertPickingOrder(tx: DbOrTx, externalId: string, body: PickingPutBody): PickingUpsertResult {
  validate(body);
  const existing = tx.get<{ id: string; status: string }>(
    sql`SELECT id, status FROM picking_orders WHERE external_id = ${externalId}`
  );

  if (!existing) {
    const orderId = crypto.randomUUID();
    tx.run(
      sql`INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at)
          VALUES (${orderId}, ${externalId}, ${body.order.ref_no}, 'pending', ${body.order.ship_to ?? null},
                  ${body.order.destination_country ?? null}, ${now()}, ${now()})`
    );
    for (const it of body.items) {
      const partId = resolveOrCreatePart(tx, it.part_no);
      tx.run(
        sql`INSERT INTO picking_items (id, picking_order_id, part_id, qty, required_date_code, source_shelf_code, line_id, created_at, updated_at)
            VALUES (${crypto.randomUUID()}, ${orderId}, ${partId}, ${it.qty}, ${it.required_date_code ?? null},
                    ${it.source_shelf_code ?? null}, ${it.line_id}, ${now()}, ${now()})`
      );
    }
    return { orderId, created: true, changed: true };
  }

  // Update path
  let changed = false;
  const po = tx.get<{ refNo: string; shipTo: string | null; dest: string | null }>(
    sql`SELECT ref_no AS refNo, ship_to AS shipTo, destination_country AS dest FROM picking_orders WHERE id = ${existing.id}`
  )!;
  const shipTo = body.order.ship_to ?? null;
  const dest = body.order.destination_country ?? null;
  if (po.refNo !== body.order.ref_no || po.shipTo !== shipTo || po.dest !== dest) {
    tx.run(sql`UPDATE picking_orders SET ref_no = ${body.order.ref_no}, ship_to = ${shipTo},
               destination_country = ${dest}, updated_at = ${now()} WHERE id = ${existing.id}`);
    changed = true;
  }

  const existingItems = loadExisting(tx, existing.id);
  const seen = new Set<string>();

  for (const it of body.items) {
    seen.add(it.line_id);
    const partId = resolveOrCreatePart(tx, it.part_no);
    const ex = existingItems.find((e) => e.lineId === it.line_id);

    if (!ex) {
      tx.run(
        sql`INSERT INTO picking_items (id, picking_order_id, part_id, qty, required_date_code, source_shelf_code, line_id, created_at, updated_at)
            VALUES (${crypto.randomUUID()}, ${existing.id}, ${partId}, ${it.qty}, ${it.required_date_code ?? null},
                    ${it.source_shelf_code ?? null}, ${it.line_id}, ${now()}, ${now()})`
      );
      changed = true;
      continue;
    }

    if (it.qty < ex.qty) {
      const floor = ex.pickedQty + ex.scannedNotBoxedQty; // remaining_qty must stay >= 0
      if (it.qty < floor)
        throw new HTTPException(409, { message: `line ${it.line_id}: qty ${it.qty} below picked+scanned ${floor}` });
    }
    const reqDc = it.required_date_code ?? null;
    const srcShelf = it.source_shelf_code ?? null;
    const same = ex.partId === partId && ex.qty === it.qty && ex.requiredDateCode === reqDc && ex.sourceShelfCode === srcShelf;
    if (!same) {
      tx.run(
        sql`UPDATE picking_items SET part_id = ${partId}, qty = ${it.qty}, required_date_code = ${reqDc},
            source_shelf_code = ${srcShelf}, updated_at = ${now()} WHERE id = ${ex.id}`
      );
      changed = true;
    }
  }

  for (const ex of existingItems) {
    if (seen.has(ex.lineId)) continue;
    if (ex.allocCount > 0 || ex.scannedNotBoxedQty > 0 || ex.pickedQty > 0)
      throw new HTTPException(409, { message: `line ${ex.lineId}: cannot remove after work started` });
    tx.run(sql`DELETE FROM picking_items WHERE id = ${ex.id}`); // cascades (none present here)
    changed = true;
  }

  if (changed) tx.run(sql`UPDATE picking_orders SET updated_at = ${now()} WHERE id = ${existing.id}`);
  return { orderId: existing.id, created: false, changed };
}
```

- [ ] **Step 4: Wire the route (allocate after commit) + mount it**

`apps/api/src/routes/picking.ts`:
```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { IngestUpsertResponse, PickingPutBody } from "@warehouse/shared";
import { db } from "../db.js";
import { upsertPickingOrder } from "../ingest/picking.js";
import { allocatePickingOrder } from "../db/allocate.js";

export const pickingRoute = new Hono();

pickingRoute.put("/picking-orders/:external_id", async (c) => {
  const externalId = c.req.param("external_id");
  let body: PickingPutBody;
  try {
    body = await c.req.json<PickingPutBody>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  const result = db.transaction((tx) => upsertPickingOrder(tx, externalId, body));
  if (result.changed) allocatePickingOrder(db, result.orderId); // AFTER commit; re-plans this order's items
  const res: IngestUpsertResponse = { id: result.orderId, external_id: externalId, created: result.created, changed: result.changed };
  return c.json(res, result.created ? 201 : 200);
});
```

In `apps/api/src/index.ts`, add:
```ts
import { pickingRoute } from "./routes/picking.js";
app.route("/", pickingRoute);
```

- [ ] **Step 5: Run the tests — expect PASS, then build**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: PASS.
Then: `cmd.exe //c "pnpm --filter @warehouse/api build"` — Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/ingest/picking.ts apps/api/src/ingest/picking.test.ts apps/api/src/routes/picking.ts apps/api/src/index.ts
git commit -m "feat(api): picking upsert + allocatePickingOrder trigger (Plan 3 task 6)"
```

---

### Task 7: Picking 409 guards + end-to-end allocation-on-upsert

**Files:**
- Test: `apps/api/src/ingest/picking.test.ts` (append 409 tests)
- Test: `apps/api/src/routes/picking.test.ts` (route-level: upsert triggers allocation)

- [ ] **Step 1: Append failing 409 tests** to `apps/api/src/ingest/picking.test.ts`

```ts
test("picking: decreasing qty below picked+scanned is 409", () => {
  const { sqlite, db } = makeDb();
  const v1: PickingPutBody = { order: { ref_no: "PO" }, items: [{ line_id: "L1", part_no: "P", qty: 100 }] };
  const r = db.transaction((tx) => upsertPickingOrder(tx, "E", v1));
  // simulate progress: picked 40, scanned-not-boxed 20 -> floor 60
  sqlite.prepare("UPDATE picking_items SET picked_qty=40, scanned_not_boxed_qty=20 WHERE picking_order_id=?").run(r.orderId);
  const v2: PickingPutBody = { order: { ref_no: "PO" }, items: [{ line_id: "L1", part_no: "P", qty: 59 }] };
  assert.throws(() => db.transaction((tx) => upsertPickingOrder(tx, "E", v2)), (e: any) => e.status === 409);
  sqlite.close();
});

test("picking: removing a line that has allocations is 409", () => {
  const { sqlite, db } = makeDb();
  const v1: PickingPutBody = { order: { ref_no: "PO" }, items: [
    { line_id: "L1", part_no: "P", qty: 100 }, { line_id: "L2", part_no: "Q", qty: 5 }] };
  const r = db.transaction((tx) => upsertPickingOrder(tx, "E", v1));
  const l2 = (sqlite.prepare("SELECT id FROM picking_items WHERE line_id='L2'").get() as any).id;
  const pP = (sqlite.prepare("SELECT id FROM parts WHERE part_no_norm='P'").get() as any).id;
  // allocation must satisfy the target-XOR check -> point it at a real on-shelf lot
  sqlite.prepare(`INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, created_at, updated_at)
                  VALUES ('lot', ?, 'S1', 5, '0','0')`).run(pP);
  sqlite.prepare(`INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at)
                  VALUES ('a', ?, 5, 'lot', '0','0')`).run(l2);
  const v2: PickingPutBody = { order: { ref_no: "PO" }, items: [{ line_id: "L1", part_no: "P", qty: 100 }] };
  assert.throws(() => db.transaction((tx) => upsertPickingOrder(tx, "E", v2)), (e: any) => e.status === 409);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify the 409 tests PASS (guards were written in Task 6)**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: PASS for both new 409 tests. If "decreasing below floor" fails, the floor guard in Task 6 is wrong — fix before continuing.

- [ ] **Step 3: Write the route-level allocation-on-upsert test** `apps/api/src/routes/picking.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
const dbPath = path.join(dir, "t.sqlite");
process.env.DATABASE_URL = dbPath;
const { app } = await import("../index.js");
const sqlite = new Database(dbPath);

test("PUT picking order runs allocation against existing in_hand receiving stock", async () => {
  // in_hand receiving order for part P with 100 available
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('pP','P','P','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro','re','R','in_hand','2026-01-01','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at)
      VALUES ('rii','ri','pP',100,100,100,'0','0');
  `);
  const res = await app.request("/picking-orders/PE-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: { ref_no: "PO-1" }, items: [{ line_id: "L1", part_no: "P", qty: 30 }] }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { created: boolean; changed: boolean };
  assert.equal(body.created, true);

  const alloc = sqlite.prepare("SELECT qty, receiving_order_id AS ro FROM allocations").get() as any;
  assert.equal(alloc.qty, 30);
  assert.equal(alloc.ro, "ro");
  const rii = sqlite.prepare("SELECT allocated_qty, available_qty FROM receiving_invoice_items WHERE id='rii'").get() as any;
  assert.equal(rii.allocated_qty, 30);
  assert.equal(rii.available_qty, 70);
});

test("cleanup", () => { sqlite.close(); });
```

- [ ] **Step 4: Run the full suite — expect PASS, then build**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: PASS.
Then: `cmd.exe //c "pnpm --filter @warehouse/api build"` — Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ingest/picking.test.ts apps/api/src/routes/picking.test.ts
git commit -m "test(api): picking 409 guards + allocation-on-upsert (Plan 3 task 7)"
```

---

### Task 8: Final verification gate

- [ ] **Step 1: Type build clean**

Run: `cmd.exe //c "pnpm --filter @warehouse/api build"`
Expected: exit 0, no errors.

- [ ] **Step 2: Full test suite green**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: all tests pass. Record the passing count in the commit message (e.g. "42/42").

- [ ] **Step 3: Manual curl smoke against a running server**

Terminal A: `cmd.exe //c "pnpm --filter @warehouse/api dev"`
Terminal B:
```bash
curl -s -X PUT localhost:3001/receiving-orders/SMOKE-1 -H 'content-type: application/json' \
  -d '{"order":{"ref_no":"RO-S"},"invoices":[{"invoice_no":"I1","items":[{"line_no":1,"part_no":"WID-1","qty":100}]}]}'
# expect 201 { created:true }
curl -s -X POST localhost:3001/receiving-orders/SMOKE-1/confirm-arrival
# expect 200 { status:"in_hand" }
curl -s -X PUT localhost:3001/picking-orders/SMOKE-1 -H 'content-type: application/json' \
  -d '{"order":{"ref_no":"PO-S"},"items":[{"line_id":"L1","part_no":"WID-1","qty":40}]}'
# expect 201; check dev.sqlite: allocations row qty 40, receiving item available_qty 60
curl -s -X PUT localhost:3001/receiving-orders/SMOKE-1 -H 'content-type: application/json' \
  -d '{"order":{"ref_no":"RO-S"},"invoices":[{"invoice_no":"I1","items":[{"line_no":1,"part_no":"WID-1","qty":100}]}]}'
# expect 200 { changed:false }  (no-op idempotency)
```
Expected: responses as annotated; in `dev.sqlite`, `receiving_invoice_items.available_qty = 60`, one `allocations` row of qty 40, one `transition_logs` row for the flip.

- [ ] **Step 4: Update docs registry (project documentation system)**

Edit `docs/app-docs/ai/feature-registry.md` and `docs/app-docs/ai/code-map.md` to list the new ingestion endpoints and files (`apps/api/src/routes/receiving.ts`, `routes/picking.ts`, `ingest/*`). If a `docs/app-docs/flows/<flow>/ai-scope.md` covers receiving/picking, note the new API entry points and the "admin payload is proposed, not final" limitation.

- [ ] **Step 5: Commit the gate result (docs only)**

```bash
git add docs/app-docs/ai/feature-registry.md docs/app-docs/ai/code-map.md docs/app-docs/flows
git commit -m "docs(api): register ingestion endpoints (Plan 3 task 8, NN/NN tests)"
```
(If no docs changed, skip this commit.)

---

## Self-review (run after drafting — already applied)

- **Spec coverage:** idempotent PUT keyed by `external_id` (Tasks 2/3/6) ✓; full nested snapshot (Tasks 2/6) ✓; create-if-absent/update-if-present (Tasks 2/3/6) ✓; no-op re-PUT (Tasks 3/6) ✓; line reconciliation + remove-only-if-no-work (Tasks 3/6) ✓; 409 on removal/qty-decrease after work (Tasks 4/7) ✓; qty-only-increase once in_hand (Task 4) ✓; responses return server UUIDs (Tasks 2/5/6) ✓; pending→in_hand trigger → allocateAll after commit (Task 5) ✓; picking upsert → allocatePickingOrder after commit (Tasks 6/7) ✓; norm computation at write time (Task 1) ✓; transition log (Task 5) ✓.
- **Placeholder scan:** the only intentional placeholder (`reconcileReceivingOrder` in Task 2) is replaced in Task 3 — flagged inline. No "TBD"/"handle errors" stubs.
- **Type consistency:** `ReceivingUpsertResult`/`PickingUpsertResult` shapes match between helpers, routes, and `IngestUpsertResponse`; `confirmReceivingArrival` return matches the route; `resolveSupplierId(null|undefined)` is used by both modules.
- **Open flag for the user:** the admin payload field names are **proposed** (`external_id` on the order; receiving lines keyed by `invoice_no`+`line_no`; picking lines keyed by `line_id`). Parsing is isolated in the two route handlers so remapping to the real admin app's names is a small, localized change.
