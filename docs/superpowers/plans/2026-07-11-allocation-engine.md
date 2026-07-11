# Allocation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side allocation engine that reserves stock to picking items — shelf-first, then receiving FIFO, box-by-box when a receiving item carries a `box_id` — re-runnable and idempotent, composing the Plan 1 invariant primitives.

**Architecture:** A pure, synchronous engine in `apps/api/src/db/allocate.ts`. High-level entrypoints (`allocatePickingOrder`, `allocateAll`) open one `db.transaction(...)`; the inner `allocatePickingItem(tx, …)` releases the item's prior allocations (via `deleteAllocation`) and re-plans from `remaining_qty` against maintained `available_qty`. Phase 1 consumes on-shelf `inventory_lots`; Phase 2 consumes `receiving_invoice_items` (boxed → one allocation+link per box; unboxed → grouped pool per receiving order → one allocation + per-portion links). All stock math flows through Plan 1 primitives, so maintained columns stay correct by construction and the Plan 1 guard (`assertInvariantsHold`) is the backstop in tests.

**Tech Stack:** `@warehouse/api` (apps/api), TypeScript NodeNext, Drizzle `sql` raw queries over better-sqlite3, `node:test` via `tsx`.

**Governing design:** `docs/superpowers/specs/2026-07-10-db-schema-rethink-design.md` §7 (algorithm) and §8 (triggers). Shelf FIFO key (left open in §7) is decided for this plan: `created_at ASC, date_code_norm ASC NULLS LAST` (arrival order, then date code).

---

## Conventions (apply to every task)

- Package: `@warehouse/api` (`apps/api`). Run commands as `pnpm --filter @warehouse/api …` from the repo root `D:/work/docpal/warehouse-pda`.
- NodeNext: every relative import uses `.js`.
- Timestamps via `now()` (`apps/api/src/db/now.ts`); ids via `crypto.randomUUID()` (global, Node 22) — same pattern `applyPutAway` already uses.
- Composers take `DbOrTx` from `./invariants.js` and never open their own transaction — EXCEPT the two high-level entrypoints (`allocatePickingOrder`, `allocateAll`), which take `AppDb` and open exactly one `db.transaction(...)` (spec §7: "allocate() is a pure synchronous db.transaction()").
- Never write generated columns (`picking_items.remaining_qty`, `inventory_lots.available_qty`).
- Test runner: `node:test`. Single file: `cmd.exe //c "pnpm --filter @warehouse/api exec tsx --test <path>"`. Full suite: `cmd.exe //c "pnpm --filter @warehouse/api test"`. Build: `cmd.exe //c "pnpm --filter @warehouse/api build"`.
- **Environment note (Windows + Git Bash):** the `pnpm …` `.cmd` shims cannot find `node` from Git Bash. Prefix every pnpm command with `cmd.exe //c` (e.g. `cmd.exe //c "pnpm --filter @warehouse/api build"`). The `package.json` scripts are correct for normal shells/CI — do not change them.
- Commit after each task with `git add <explicit paths>` (never `git add -A` — unrelated stray files live in the tree).

## File structure

- **Create:** `apps/api/src/db/allocate.ts` — the engine. Exports: `allocatePickingOrder(db, pickingOrderId)`, `allocateAll(db)`, and the composable `allocatePickingItem(tx, pickingItemId)`. Internal: `newId()`, candidate queries (`shelfCandidates`, `receivingOrderCandidates`, `receivingOrderItems`), and a defense-in-depth available re-check.
- **Create:** `apps/api/src/db/allocate.test.ts` — ordering, box/group, idempotency, and entrypoint tests, all closed by `assertInvariantsHold(db)`.
- **No other files changed.** The Plan 1 invariant primitives (`invariants.ts`) and schema are consumed as-is.

### Function surface (locked — names/signatures reused in every task)

```ts
// allocate.ts
export function allocatePickingItem(tx: DbOrTx, pickingItemId: string): void;
export function allocatePickingOrder(db: AppDb, pickingOrderId: string): void;
export function allocateAll(db: AppDb): void;

// internal (not exported)
function newId(): string;                                  // crypto.randomUUID()
function shelfCandidates(tx: DbOrTx, partId: string): { id: string; availableQty: number }[];
function receivingOrderCandidates(tx: DbOrTx, partId: string): { receivingOrderId: string }[];
function receivingOrderItems(tx: DbOrTx, receivingOrderId: string, partId: string):
  { itemId: string; boxId: string | null; availableQty: number }[];
function currentAvailable(tx: DbOrTx, kind: "lot" | "rii", id: string): number; // defense-in-depth re-check
```

### Algorithm (locked — spec §7, with the shelf-FIFO decision)

For each affected picking item (within one transaction):

1. **Release.** Read existing allocation ids for the item; call `deleteAllocation(tx, id)` for each. (Restores lot/receiving availability via recompute.)
2. **Need.** Read `picking_items.{part_id, remaining_qty}`. If missing → return. `need = remaining_qty`; if `need <= 0` → return (leaves the item with zero allocations — correct rebalancing when qty drops or all scanned).
3. **Phase 1 — shelf.** For each `shelfCandidates(partId)` row in order while `need > 0`: `take = min(need, lot.availableQty, currentAvailable("lot", lot.id))`; if `take > 0` → `createAllocation(tx, { id: newId(), pickingItemId, qty: take, inventoryLotId: lot.id })`; `need -= take`.
4. **Phase 2 — receiving.** For each `receivingOrderCandidates(partId)` (delivery_date FIFO) while `need > 0`:
   - Load `receivingOrderItems(receivingOrderId, partId)` (invoice_no/date_code FIFO); split into `boxed` (`boxId !== null`) then `unboxed`.
   - **Boxed:** for each boxed item while `need > 0`: `take = min(need, item.availableQty, currentAvailable("rii", item.itemId))`; if `take > 0`: `aid = newId()`; `createAllocation(tx, { id: aid, pickingItemId, qty: take, receivingOrderId })`; `linkAllocation(tx, { id: newId(), allocationId: aid, receivingInvoiceItemId: item.itemId, qty: take })`; `need -= take`.
   - **Unboxed (grouped):** walk unboxed items, accumulating portions `[{itemId, qty}]` capped by each item's available until `poolTake` (= min(need, Σ available)) is reached; if `poolTake > 0`: `aid = newId()`; `createAllocation(tx, { id: aid, pickingItemId, qty: poolTake, receivingOrderId })`; for each portion `linkAllocation(tx, { id: newId(), allocationId: aid, receivingInvoiceItemId, qty })`; `need -= poolTake`.
5. **Cross-item order.** `allocateAll` processes picking items ordered by `picking_items.created_at ASC, id ASC` (oldest demand first; deterministic). `allocatePickingOrder` processes that order's items in the same order.

**Deliberate spec-faithful choices (not oversights):**
- No `picking_items.required_date_code` filter in Phase 1 — spec §7 SQL omits it; the column is reserved for a later enhancement.
- Order-level FIFO tie-break is `delivery_date ASC NULLS LAST, external_id ASC` (spec only mandates `delivery_date`; `external_id` is a stable deterministic tie-break for tests).
- Phase 1 snapshot-consumes each candidate once; `currentAvailable` is the spec §7.4 defense-in-depth re-check against concurrent drift inside the same tx (cheap; mostly redundant under the write lock).

**Known limitation handed to Plan 3:** `scanToPackage` does not reserve source stock, so a scanned-but-unboxed package's source is not excluded from re-allocation; need is `remaining_qty` (= qty − picked − scanned_not_boxed), which already excludes scanned work from demand. Reconciling scan-time source reservation is a picking-execution concern, not Plan 2.

---

## Task 1: Internal helpers + shelf candidates

**Files:**
- Create: `apps/api/src/db/allocate.ts`
- Test: `apps/api/src/db/allocate.test.ts`

- [ ] **Step 1: Write the failing test** — `apps/api/src/db/allocate.test.ts`

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
import { allocatePickingItem } from "./allocate.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'0','0');
  `);
  return { sqlite, db };
}

test("Phase 1 consumes on-shelf lots in created_at then date_code_norm order", () => {
  const { sqlite, db } = makeDb();
  // shelf_code IS NOT NULL = on-shelf. available generated = total - allocated (allocated defaults 0).
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, date_code_norm, created_at, updated_at) VALUES
      ('lotNew','p','S1',4,'202401','2024-02-01T00:00:00Z','0'),
      ('lotOld','p','S1',3,'202312','2024-01-01T00:00:00Z','0'),
      ('lotRecv','p',NULL,99,'202001','2023-01-01T00:00:00Z','0');
  `);
  db.transaction((tx) => allocatePickingItem(tx, "pi"));

  const allocs = sqlite.prepare("SELECT inventory_lot_id AS lot, qty FROM allocations WHERE picking_item_id='pi' ORDER BY rowid").all() as any[];
  // need=10; Phase1 order: lotOld (created 2024-01-01) qty3, then lotNew (2024-02-01) qty4 → 7; lotRecv is shelf_code NULL → excluded.
  assert.deepEqual(allocs, [{ lot: "lotOld", qty: 3 }, { lot: "lotNew", qty: 4 }]);
  assertInvariantsHold(db);
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cmd.exe //c "pnpm --filter @warehouse/api exec tsx --test src/db/allocate.test.ts"`
Expected: FAIL — `Cannot find module './allocate.js'`.

- [ ] **Step 3: Implement helpers + Phase 1** — `apps/api/src/db/allocate.ts`

```ts
import { sql } from "drizzle-orm";
import type { AppDb } from "../db.js";
import {
  type DbOrTx,
  createAllocation,
  deleteAllocation,
} from "./invariants.js";

function newId(): string {
  return crypto.randomUUID();
}

function shelfCandidates(tx: DbOrTx, partId: string): { id: string; availableQty: number }[] {
  return tx.all<{ id: string; availableQty: number }>(sql`
    SELECT id, available_qty AS availableQty
    FROM inventory_lots
    WHERE part_id = ${partId} AND shelf_code IS NOT NULL AND available_qty > 0
    ORDER BY created_at ASC, date_code_norm ASC NULLS LAST
  `);
}

function currentAvailable(tx: DbOrTx, kind: "lot" | "rii", id: string): number {
  if (kind === "lot") {
    return tx.get<{ v: number }>(sql`SELECT available_qty AS v FROM inventory_lots WHERE id = ${id}`)?.v ?? 0;
  }
  return tx.get<{ v: number }>(sql`SELECT available_qty AS v FROM receiving_invoice_items WHERE id = ${id}`)?.v ?? 0;
}

export function allocatePickingItem(tx: DbOrTx, pickingItemId: string): void {
  const existing = tx.all<{ id: string }>(sql`SELECT id FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  for (const a of existing) deleteAllocation(tx, a.id);

  const row = tx.get<{ partId: string; remaining: number }>(
    sql`SELECT part_id AS partId, remaining_qty AS remaining FROM picking_items WHERE id = ${pickingItemId}`
  );
  if (!row) return;
  let need = row.remaining;
  if (need <= 0) return;

  for (const lot of shelfCandidates(tx, row.partId)) {
    if (need <= 0) break;
    const take = Math.min(need, lot.availableQty, currentAvailable(tx, "lot", lot.id));
    if (take <= 0) continue;
    createAllocation(tx, { id: newId(), pickingItemId, qty: take, inventoryLotId: lot.id });
    need -= take;
  }
}
```

- [ ] **Step 4: Run — expect pass**

Run: `cmd.exe //c "pnpm --filter @warehouse/api exec tsx --test src/db/allocate.test.ts"`
Expected: PASS — `tests 1, pass 1, fail 0`.
Run: `cmd.exe //c "pnpm --filter @warehouse/api build"`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/allocate.ts apps/api/src/db/allocate.test.ts
git commit -m "feat(api): add shelf-first allocation (Phase 1) with release-and-replan"
```

---

## Task 2: Receiving candidate queries

**Files:**
- Modify: `apps/api/src/db/allocate.ts` (append helpers)
- Test: `apps/api/src/db/allocate.test.ts` (append test)

- [ ] **Step 1: Append the failing test** to `apps/api/src/db/allocate.test.ts`

Add `receivingOrderCandidates` and `receivingOrderItems` to the import line (they are not exported — instead test them indirectly through `allocatePickingItem` in Task 3; here, test the candidate ORDERING by re-exporting temporarily is NOT allowed). Instead, append this behavioral test that exercises receiving FIFO end-to-end via `allocatePickingItem` (the candidate order is what produces the result):

```ts
test("Phase 2 consumes receiving orders by delivery_date FIFO, invoice_no, date_code", () => {
  const { sqlite, db } = makeDb();
  // Two in_hand receiving orders for part 'p', no shelf stock. roLate delivered later, roEarly earlier.
  sqlite.exec(`
    INSERT INTO receiving_orders (id, external_id, ref_no, status, delivery_date, created_at, updated_at) VALUES
      ('roLate','el','RL','in_hand','2024-06-01','0','0'),
      ('roEarly','ee','RE','in_hand','2024-01-01','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES
      ('riLate','roLate','INV-L','0','0'),
      ('riEarly','roEarly','INV-E','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, date_code, created_at, updated_at) VALUES
      ('riiLate','riLate','p',100,100,100,'202402','0','0'),
      ('riiEarly','riEarly','p',4,4,4,'202401','0','0');
  `);
  db.transaction((tx) => allocatePickingItem(tx, "pi"));

  // need=10; no shelf; Phase2 order: roEarly (delivery 2024-01-01) fills 4 from riiEarly, then roLate fills 6 from riiLate.
  const a = sqlite.prepare("SELECT receiving_order_id AS ro, qty FROM allocations WHERE picking_item_id='pi' ORDER BY rowid").all() as any[];
  assert.deepEqual(a, [{ ro: "roEarly", qty: 4 }, { ro: "roLate", qty: 6 }]);
  const links = sqlite.prepare("SELECT receiving_invoice_item_id AS rii, qty FROM allocation_receiving_items ORDER BY rowid").all() as any[];
  assert.deepEqual(links, [{ rii: "riiEarly", qty: 4 }, { rii: "riiLate", qty: 6 }]);
  assertInvariantsHold(db);
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cmd.exe //c "pnpm --filter @warehouse/api exec tsx --test src/db/allocate.test.ts"`
Expected: FAIL — the new test fails because Phase 2 is not implemented yet (only the early-order 4 / late-order 0 or no allocations → assertion mismatch). The first test still passes.

- [ ] **Step 3: Append candidate helpers + Phase 2** to `apps/api/src/db/allocate.ts`

Append these helpers (after `currentAvailable`):

```ts
function receivingOrderCandidates(tx: DbOrTx, partId: string): { receivingOrderId: string }[] {
  return tx.all<{ receivingOrderId: string }>(sql`
    SELECT DISTINCT ro.id AS receivingOrderId
    FROM receiving_orders ro
    JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
    JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
    WHERE rii.part_id = ${partId} AND ro.status = 'in_hand' AND rii.available_qty > 0
    ORDER BY ro.delivery_date ASC NULLS LAST, ro.external_id ASC
  `);
}

function receivingOrderItems(
  tx: DbOrTx,
  receivingOrderId: string,
  partId: string
): { itemId: string; boxId: string | null; availableQty: number }[] {
  return tx.all<{ itemId: string; boxId: string | null; availableQty: number }>(sql`
    SELECT rii.id AS itemId, rii.box_id AS boxId, rii.available_qty AS availableQty
    FROM receiving_invoice_items rii
    JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
    WHERE ri.receiving_order_id = ${receivingOrderId} AND rii.part_id = ${partId} AND rii.available_qty > 0
    ORDER BY ri.invoice_no ASC, rii.date_code ASC NULLS LAST
  `);
}
```

Add `linkAllocation` to the `invariants.js` import (append it to the existing import list):

```ts
import {
  type DbOrTx,
  createAllocation,
  linkAllocation,
  deleteAllocation,
} from "./invariants.js";
```

Extend `allocatePickingItem` with Phase 2 — replace the function body AFTER the Phase 1 loop (keep the release/need/Phase-1 code from Task 1 exactly, then append):

```ts
  for (const ord of receivingOrderCandidates(tx, row.partId)) {
    if (need <= 0) break;
    const items = receivingOrderItems(tx, ord.receivingOrderId, row.partId);
    const boxed = items.filter((i) => i.boxId !== null);
    const unboxed = items.filter((i) => i.boxId === null);

    for (const b of boxed) {
      if (need <= 0) break;
      const take = Math.min(need, b.availableQty, currentAvailable(tx, "rii", b.itemId));
      if (take <= 0) continue;
      const aid = newId();
      createAllocation(tx, { id: aid, pickingItemId, qty: take, receivingOrderId: ord.receivingOrderId });
      linkAllocation(tx, { id: newId(), allocationId: aid, receivingInvoiceItemId: b.itemId, qty: take });
      need -= take;
    }

    if (need <= 0) continue;
    let poolNeed = need;
    const portions: { itemId: string; qty: number }[] = [];
    for (const u of unboxed) {
      if (poolNeed <= 0) break;
      const take = Math.min(poolNeed, u.availableQty, currentAvailable(tx, "rii", u.itemId));
      if (take <= 0) continue;
      portions.push({ itemId: u.itemId, qty: take });
      poolNeed -= take;
    }
    const poolTake = need - poolNeed;
    if (poolTake > 0) {
      const aid = newId();
      createAllocation(tx, { id: aid, pickingItemId, qty: poolTake, receivingOrderId: ord.receivingOrderId });
      for (const p of portions) {
        linkAllocation(tx, { id: newId(), allocationId: aid, receivingInvoiceItemId: p.itemId, qty: p.qty });
      }
      need -= poolTake;
    }
  }
```

- [ ] **Step 4: Run — expect pass**

Run: `cmd.exe //c "pnpm --filter @warehouse/api exec tsx --test src/db/allocate.test.ts"`
Expected: PASS — `tests 2, pass 2, fail 0`.
Run: `cmd.exe //c "pnpm --filter @warehouse/api build"`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/allocate.ts apps/api/src/db/allocate.test.ts
git commit -m "feat(api): add receiving FIFO allocation (Phase 2 grouped + box-by-box)"
```

---

## Task 3: Box-by-box vs grouped split within one receiving order

**Files:**
- Test: `apps/api/src/db/allocate.test.ts` (append test)

(Implementation is already in place from Task 2; this task locks the mixed boxed/unboxed behavior.)

- [ ] **Step 1: Append the test** to `apps/api/src/db/allocate.test.ts`

```ts
test("within one receiving order: boxed items allocate box-by-box, unboxed group into one pool", () => {
  const { sqlite, db } = makeDb();
  // One in_hand order with part 'p' spread across two invoices: one boxed item (box 'B1' qty 3) and two unboxed items (qty 2 + 2).
  sqlite.exec(`
    INSERT INTO receiving_orders (id, external_id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro','e','R','in_hand','2024-01-01','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES
      ('riA','ro','A','0','0'),('riB','ro','B','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, box_id, date_code, created_at, updated_at) VALUES
      ('riiBox','riA','p',3,3,3,'B1','202401','0','0'),
      ('riiU1','riA','p',2,2,2,NULL,'202401','0','0'),
      ('riiU2','riB','p',2,2,2,NULL,'202401','0','0');
  `);
  db.transaction((tx) => allocatePickingItem(tx, "pi"));

  // need=10. Boxed riiBox (invoice A, date 202401) → its own allocation qty3. Unboxed riiU1+riiU2 (A then B) grouped → one allocation qty4 with two link rows.
  const allocs = sqlite.prepare("SELECT id, receiving_order_id AS ro, qty FROM allocations WHERE picking_item_id='pi' ORDER BY rowid").all() as any[];
  assert.equal(allocs.length, 2);
  assert.deepEqual(allocs.map((x) => x.qty).sort(), [3, 4]);

  const boxAlloc = allocs.find((x) => x.qty === 3)!;
  const poolAlloc = allocs.find((x) => x.qty === 4)!;
  const boxLinks = sqlite.prepare("SELECT receiving_invoice_item_id AS rii, qty FROM allocation_receiving_items WHERE allocation_id=?").all(boxAlloc.id) as any[];
  assert.deepEqual(boxLinks, [{ rii: "riiBox", qty: 3 }]);
  const poolLinks = sqlite.prepare("SELECT receiving_invoice_item_id AS rii, qty FROM allocation_receiving_items WHERE allocation_id=? ORDER BY rowid").all(poolAlloc.id) as any[];
  assert.deepEqual(poolLinks, [{ rii: "riiU1", qty: 2 }, { rii: "riiU2", qty: 2 }]);
  assertInvariantsHold(db);
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect pass** (no new implementation)

Run: `cmd.exe //c "pnpm --filter @warehouse/api exec tsx --test src/db/allocate.test.ts"`
Expected: PASS — `tests 3, pass 3, fail 0`.
If it FAILS, the bug is in the Task 2 Phase 2 code (boxed-before-unboxed ordering, or poolTake math) — fix `allocatePickingItem`, do NOT weaken the test.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/allocate.test.ts
git commit -m "test(api): lock box-by-box vs grouped split within a receiving order"
```

---

## Task 4: Idempotency and re-runnability

**Files:**
- Test: `apps/api/src/db/allocate.test.ts` (append test)

- [ ] **Step 1: Append the test** to `apps/api/src/db/allocate.test.ts`

```ts
test("re-running allocatePickingItem releases and re-plans to the same result", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, created_at, updated_at) VALUES ('lot','p','S1',6,'2024-01-01T00:00:00Z','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro','e','R','in_hand','2024-01-01','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','INV','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, created_at, updated_at) VALUES ('rii','ri','p',10,10,10,'0','0');
  `);
  db.transaction((tx) => allocatePickingItem(tx, "pi"));
  const first = sqlite.prepare("SELECT inventory_lot_id AS lot, receiving_order_id AS ro, qty FROM allocations WHERE picking_item_id='pi' ORDER BY rowid").all() as any[];
  // Run again — must release prior allocations and produce an identical plan (no double-allocate).
  db.transaction((tx) => allocatePickingItem(tx, "pi"));
  const second = sqlite.prepare("SELECT inventory_lot_id AS lot, receiving_order_id AS ro, qty FROM allocations WHERE picking_item_id='pi' ORDER BY rowid").all() as any[];
  assert.deepEqual(second, first);
  // need=10: shelf lot 6 + receiving 4.
  assert.deepEqual(second, [{ lot: "lot", ro: null, qty: 6 }, { lot: null, ro: "ro", qty: 4 }]);
  const pi = sqlite.prepare("SELECT allocated_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.equal(pi.allocated_qty, 10);
  assertInvariantsHold(db);
  sqlite.close();
});

test("allocatePickingItem with remaining_qty <= 0 releases allocations and plans nothing", () => {
  const { sqlite, db } = makeDb();
  // Pre-allocate fully via a first run, then drop the picking qty to 0 by marking fully picked.
  sqlite.exec(`INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, created_at, updated_at) VALUES ('lot','p','S1',10,'2024-01-01T00:00:00Z','0');`);
  db.transaction((tx) => allocatePickingItem(tx, "pi"));
  assert.equal((sqlite.prepare("SELECT count(*) c FROM allocations WHERE picking_item_id='pi'").get() as any).c, 1);
  // Simulate fully picked: picked_qty = qty → remaining_qty = 0.
  sqlite.exec(`UPDATE picking_items SET picked_qty = 10 WHERE id='pi';`);
  db.transaction((tx) => allocatePickingItem(tx, "pi"));
  assert.equal((sqlite.prepare("SELECT count(*) c FROM allocations WHERE picking_item_id='pi'").get() as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect pass**

Run: `cmd.exe //c "pnpm --filter @warehouse/api exec tsx --test src/db/allocate.test.ts"`
Expected: PASS — `tests 5, pass 5, fail 0`.
If the idempotency test fails (double-allocate or differing plan), the release step in `allocatePickingItem` is wrong — fix it, do NOT weaken the test.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/allocate.test.ts
git commit -m "test(api): lock allocation idempotency and release-and-replan"
```

---

## Task 5: Entrypoints `allocatePickingOrder` and `allocateAll`

**Files:**
- Modify: `apps/api/src/db/allocate.ts` (append exports)
- Test: `apps/api/src/db/allocate.test.ts` (append tests)

- [ ] **Step 1: Append the failing tests** to `apps/api/src/db/allocate.test.ts`

Add `allocatePickingOrder` and `allocateAll` to the import line:

```ts
import { allocatePickingItem, allocatePickingOrder, allocateAll } from "./allocate.js";
```

Append:

```ts
test("allocatePickingOrder plans every item of the order; allocateAll plans all remaining demand oldest-first", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p2','Y','Y','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po2','e2','R2','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES
      ('piOld','po','p',5,'2024-01-01T00:00:00Z','0'),
      ('piNew','po2','p2',4,'2024-02-01T00:00:00Z','0');
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, created_at, updated_at) VALUES
      ('lotP','p','S1',3,'2024-01-01T00:00:00Z','0'),
      ('lotP2','p2','S1',10,'2024-01-01T00:00:00Z','0');
  `);
  // po has two items now: 'pi' (qty10 from makeDb) and 'piOld' (qty5). allocatePickingOrder plans both of po's items only.
  allocatePickingOrder(db, "po");
  // 'pi' (qty10, part p) and 'piOld' (qty5, part p) share the single shelf lot lotP (3) + nothing else → oldest item piOld? No:
  // order is by picking_items.created_at: 'pi' created '0' (makeDb) < 'piOld' 2024-01-01, so 'pi' consumes lotP(3) first.
  const piAlloc = sqlite.prepare("SELECT allocated_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.equal(piAlloc.allocated_qty, 3);
  const piOldAlloc = sqlite.prepare("SELECT allocated_qty FROM picking_items WHERE id='piOld'").get() as any;
  assert.equal(piOldAlloc.allocated_qty, 0);
  // po2 / piNew untouched by allocatePickingOrder('po'):
  assert.equal((sqlite.prepare("SELECT count(*) c FROM allocations WHERE picking_item_id='piNew'").get() as any).c, 0);

  // Now global replan across all remaining demand.
  allocateAll(db);
  assertInvariantsHold(db);
  // piNew (part p2) now allocated from lotP2.
  assert.equal((sqlite.prepare("SELECT allocated_qty FROM picking_items WHERE id='piNew'").get() as any).allocated_qty, 4);
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cmd.exe //c "pnpm --filter @warehouse/api exec tsx --test src/db/allocate.test.ts"`
Expected: FAIL — `allocatePickingOrder is not exported`.

- [ ] **Step 3: Append the entrypoints** to `apps/api/src/db/allocate.ts`

```ts
export function allocatePickingOrder(db: AppDb, pickingOrderId: string): void {
  db.transaction((tx) => {
    const items = tx.all<{ id: string }>(
      sql`SELECT id FROM picking_items WHERE picking_order_id = ${pickingOrderId} ORDER BY created_at ASC, id ASC`
    );
    for (const it of items) allocatePickingItem(tx, it.id);
  });
}

export function allocateAll(db: AppDb): void {
  db.transaction((tx) => {
    const items = tx.all<{ id: string }>(
      sql`SELECT id FROM picking_items WHERE remaining_qty > 0 ORDER BY created_at ASC, id ASC`
    );
    for (const it of items) allocatePickingItem(tx, it.id);
  });
}
```

- [ ] **Step 4: Run — expect pass**

Run: `cmd.exe //c "pnpm --filter @warehouse/api exec tsx --test src/db/allocate.test.ts"`
Expected: PASS — `tests 6, pass 6, fail 0`.
Run: `cmd.exe //c "pnpm --filter @warehouse/api build"`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/allocate.ts apps/api/src/db/allocate.test.ts
git commit -m "feat(api): add allocatePickingOrder and allocateAll entrypoints"
```

---

## Task 6: Property test — randomized sequences keep the guard green

**Files:**
- Test: `apps/api/src/db/allocate.property.test.ts`

- [ ] **Step 1: Write the property test** — `apps/api/src/db/allocate.property.test.ts`

This proof drives randomized stock + picking setup, calls `allocateAll(db)`, and asserts the invariant guard after every run. Fixed seed for reproduction.

```ts
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { allocateAll } from "./allocate.js";
import { assertInvariantsHold } from "./invariants.guard.js";

const SEED = 987654321;
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test(`allocateAll preserves invariants over randomized stock (seed=${SEED})`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  const rand = rng(SEED);
  const ri = (n: number) => Math.floor(rand() * n);

  // 3 parts, a few shelf lots + receiving orders with mixed boxed/unboxed, several picking items.
  sqlite.exec(`INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p0','A','A','0','0'),('p1','B','B','0','0'),('p2','C','C','0','0');`);
  for (let p = 0; p < 3; p++) {
    for (let l = 0; l < 2; l++) {
      const tot = ri(8) + 1;
      sqlite.exec(`INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, date_code_norm, created_at, updated_at) VALUES ('lot${p}_${l}','p${p}','S${l}',${tot},'20240${ri(9)}','2024-0${l + 1}-0${p + 1}T00:00:00Z','0');`);
    }
    for (let r = 0; r < 2; r++) {
      sqlite.exec(`INSERT INTO receiving_orders (id, external_id, ref_no, status, delivery_date, created_at, updated_at) VALUES ('ro${p}_${r}','e${p}_${r}','R${p}${r}','in_hand','2024-0${r + 1}-15','0','0');`);
      sqlite.exec(`INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri${p}_${r}','ro${p}_${r}','INV${p}${r}','0','0');`);
      const qty = ri(10) + 5;
      const boxed = ri(2) === 0;
      sqlite.exec(`INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, available_qty, box_id, date_code, created_at, updated_at) VALUES ('rii${p}_${r}','ri${p}_${r}','p${p}',${qty},${qty},${qty},${boxed ? `'B${p}${r}'` : "NULL"},'202401','0','0');`);
    }
    for (let k = 0; k < 2; k++) {
      sqlite.exec(`INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po${p}_${k}','ep${p}_${k}','RP${p}${k}','picking','2024-0${k + 1}-0${p + 1}T00:00:00Z','0');`);
      sqlite.exec(`INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi${p}_${k}','po${p}_${k}','p${p}',${ri(12) + 1},'2024-0${k + 1}-0${p + 1}T00:00:00Z','0');`);
    }
  }

  try {
    for (let step = 0; step < 50; step++) {
      allocateAll(db);
      assertInvariantsHold(db);
    }
  } catch (e) {
    sqlite.close();
    throw new Error(`failed at step (seed=${SEED}): ${(e as Error).message}`);
  }
  sqlite.close();
});
```

- [ ] **Step 2: Run — expect pass**

Run: `cmd.exe //c "pnpm --filter @warehouse/api exec tsx --test src/db/allocate.property.test.ts"`
Expected: PASS — `tests 1, pass 1, fail 0`.
If it FAILS, the invariant guard caught a real drift in `allocatePickingItem` — paste the full `(seed=…)` message and STOP; do NOT weaken the test or the guard.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/allocate.property.test.ts
git commit -m "test(api): add seeded property test for allocateAll invariant preservation"
```

---

## Task 7: Final verification gate

No new files. Confirms the engine compiles and every test passes together.

- [ ] **Step 1: Full typecheck**

Run: `cmd.exe //c "pnpm --filter @warehouse/api build"`
Expected: exit 0, no type errors.

- [ ] **Step 2: Full test suite**

Run: `cmd.exe //c "pnpm --filter @warehouse/api test"`
Expected: PASS — Plan 1 baseline (18) + allocate (6) + allocate.property (1) = 25 tests, 0 failures.

- [ ] **Step 3: Commit (only if anything in Tasks 5–6 left the tree dirty beyond their own commits)**

No commit required if Tasks 1–6 each committed. If Step 1/2 is red, fix in the relevant task before proceeding.

---

## Follow-on plans (not part of Plan 2)

- **Plan 3 — Ingestion + triggers:** `PUT /api/receiving-orders/:external_id` and `PUT /api/picking-orders/:external_id` (idempotent snapshot upsert, line reconciliation, 409 rules); wire `allocatePickingOrder()` to PO-upsert and `allocateAll()` to receiving-order `pending → in_hand`.
- **Plan 4 — Tasks + polling:** measuring/verification task creation on PO-finished; cycle-count assignment; `GET /api/tasks/poll` by `(status, updated_at)`.
- **Plan 5 — Seed + cutover:** minimal seed for the API; point the Nuxt app at the API; remove PGlite.

---

## Self-review (run by the plan author — completed)

**1. Spec coverage (§7/§8):**
- §7.1 release-and-replan → Task 1 (release in `allocatePickingItem`) + Task 4 (idempotency tests). ✅
- §7.2 Phase 1 shelf-first, `ORDER BY created_at, date_code_norm NULLS LAST`, maintained available → Task 1. ✅
- §7.3 Phase 2 receiving FIFO `ORDER BY delivery_date, invoice_no, date_code`, maintained available, no CTE/correlated subqueries → Task 2. ✅
- §7 box-by-box (boxed → one link per box) vs grouped (pool → one allocation + per-portion links) → Task 2 (impl) + Task 3 (mixed-order lock). ✅
- §7.4 defense-in-depth `available_qty >= qty` re-check → `currentAvailable` clamp in both phases (Task 1/2). ✅
- §7 idempotency/re-runnable → Task 4. ✅
- §8 triggers (PO create/update → its items; RO in_hand → all remaining) → entrypoints Task 5 (`allocatePickingOrder`, `allocateAll`); the HTTP wiring is explicitly Plan 3. ✅
- Re-randomized proof → Task 6. ✅

**2. Placeholder scan:** no "TBD/TODO/implement later/similar to Task N"; every code step shows complete code; every test step shows complete assertions. ✅

**3. Type/signature consistency:** `allocatePickingItem(tx: DbOrTx, pickingItemId: string)` (Task 1) is reused verbatim in Tasks 2/5; `createAllocation`/`linkAllocation`/`deleteAllocation` shapes match `invariants.ts`; candidate helper return shapes match their usage in Phase 2; `AppDb`/`DbOrTx` imports match `db.ts`/`invariants.ts`. ✅
