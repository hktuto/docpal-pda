# Picking Execution (Plan 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the PDA picking-execution slice to the Hono API: scan-to-pick against allocations (with over-pick guards), shipping-box lifecycle, pack/unpack operations, the auto-finish trigger that closes a picking order and creates its measuring task, and the read/polling endpoints the app needs to drive these screens.

**Architecture:** Tx-scoped execution primitives in `apps/api/src/db/pickScan.ts` (sibling of `db/allocate.ts`), all stock math reusing the Plan 1 invariant primitives (`applyPick`, `scanToPackage`, `createAllocation`, `linkAllocation`, `recompute*`). A small Plan-1 extension makes `recomputePickingItem` also maintain `picked_qty` (= Σ boxed packages), so every box op keeps `remaining_qty` (generated) correct for free. Routes in `routes/pickingExecution.ts` + `routes/measuring.ts` open `db.transaction` per request; auto-finish runs **inside** the same tx as the box assignment (mirrors the web). Scans consume receiving allocations **directly from `allocation_receiving_items` portions** — the web's materialize-to-lot step is unnecessary in this schema.

**Tech Stack:** Hono 4 (`hono`, `hono/http-exception`), `drizzle-orm/better-sqlite3`, raw `sql` via `tx.get/all/run`, `node:test` + `tsx`, `crypto.randomUUID()`. No new dependencies.

---

## Conventions (read first)

- **Shell:** prefix **every** verification command with `cmd.exe //c` (plain `pnpm` is broken here):
  - Build: `cmd.exe //c "pnpm --filter @warehouse/api build"` — Tests: `cmd.exe //c "pnpm --filter @warehouse/api test"`. Do not edit `package.json`.
- **Commits:** commit directly to `master`, never push. Stage explicit paths only (`git add <paths>`, never `-A`); never stage the pre-existing stray files.
- **NodeNext:** relative imports end in `.js`. **Timestamps:** `now()` from `db/now.ts`. **IDs:** global `crypto.randomUUID()`.
- **Generated columns (never write):** `picking_items.remaining_qty`, `inventory_lots.available_qty`. **Maintained columns** (`picking_items.{allocated_qty,scanned_not_boxed_qty,picked_qty}`, `receiving_invoice_items.{allocated_qty,available_qty,picked_qty}`, `inventory_lots.allocated_qty`) change **only** via the `db/invariants.ts` primitives — never ad-hoc (test seeds excepted).
- **Test backstop:** every state-changing test ends with `assertInvariantsHold(db)` from `db/invariants.guard.ts`. Isolated DBs via the `makeDb()` pattern from `db/allocate.test.ts`.
- **Route tests** use the temp-`DATABASE_URL` + dynamic `await import("../index.js")` pattern from `routes/receiving.test.ts` (each test file is its own node process; set the env var BEFORE the import).
- All helpers throw `HTTPException` (400 validation / 404 missing / 409 state conflict).

---

## Scope boundaries (decided — do not re-open)

- **IN:** scan against allocation, undo scan (unboxed), box create/cancel, add/add-all/remove package, auto-finish → measuring task, manual finish, picking order list+detail reads, measuring-task polling.
- **IN (Plan-2 carry-forward):** scan-reservation over-pick guard — `picked + scanned_not_boxed + qty > item.qty` → 409, plus `qty > allocation.qty` → 409.
- **OUT (Plan 5):** receiving-order `clear` transition (put-away completion owns it — spec §10/§15), receiving-side candidate scan endpoints (`findReceivingCandidates`/`findPickingCandidates` — the receiving-page scan UI), measuring execution (box verify/weights), put-away, cycle-count verification, seed port, frontend adapter.
- **PROPOSED (flagged, mirrors no web code):** first scan on a `pending` order flips it to `picking` (+transition log). The web never flips in db code (its seeds start at `picking`); spec §13 requires the state, so we introduce it here. If the real app needs a different trigger, this is one guard + one transition log to move.
- **Box IDs:** plain UUIDs. The web's location-prefixed `BOX-HK1-*` id scheme is dropped — the API `shipping_boxes` has no code column.
- **0-qty residue:** scans *reduce* `allocations.qty` / `allocation_receiving_items.qty` toward 0 but **keep the rows** (mirrors the web's "reduce instead of delete" so undo is O(1) and receiving-side history survives). Reads filter `qty > 0`. `deleteAllocation` during re-planning still deletes them; the undo path re-creates if missing (same as web).
- **Actor:** endpoints accept optional `actor_id` (no auth wired yet — spec §14); `transition_logs.actor_id` may be null.

---

## File structure

**Create**
- `apps/api/src/db/pickScan.ts` — all execution primitives (surface below).
- `apps/api/src/routes/pickingExecution.ts` — scan/undo/boxes/pack/finish + `GET /picking-orders` (list/poll) + `GET /picking-orders/:id` (detail).
- `apps/api/src/routes/measuring.ts` — `GET /measuring-tasks?status=&since=`.
- Tests: `apps/api/src/db/invariants.picked.test.ts`, `apps/api/src/db/pickScan.test.ts`, `apps/api/src/db/pickScan.box.test.ts`, `apps/api/src/db/pickScan.undo.test.ts`, `apps/api/src/routes/pickingExecution.test.ts`, `apps/api/src/routes/measuring.test.ts`.

**Modify**
- `apps/api/src/db/invariants.ts` — `recomputePickingItem` also maintains `picked_qty`; `scanToPackage` accepts optional `dateCode/lotCode/coo/cow`.
- `apps/api/src/db/invariants.guard.ts` — `assertInvariantsHold` also checks `picked_qty`.
- `apps/api/src/index.ts` — mount the two new route modules.
- `packages/shared/src/index.ts` — execution DTOs (added in the tasks that use them).

**Function surface (locked)**
```ts
// db/pickScan.ts — all throw HTTPException; all run inside the caller's tx
export function scanAllocation(tx: DbOrTx, a: { allocationId: string; qty: number; actorId?: string | null }): { packageIds: string[] };
export function removeScannedPackage(tx: DbOrTx, p: { packageId: string; actorId?: string | null }): void;
export function createShippingBox(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): string;
export function cancelShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): void;
export function addPackageToBox(tx: DbOrTx, a: { packageId: string; shippingBoxId: string; actorId?: string | null }): void;
export function addAllUnboxedToBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): number;
export function removePackageFromBox(tx: DbOrTx, a: { packageId: string; actorId?: string | null }): void;
export function maybeAutoFinishPickingOrder(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): boolean;
export function finishPickingOrder(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): void;
```

---

### Task 1: `picked_qty` becomes a maintained column (primitives + guard)

**Files:**
- Modify: `apps/api/src/db/invariants.ts`
- Modify: `apps/api/src/db/invariants.guard.ts`
- Test: `apps/api/src/db/invariants.picked.test.ts`

- [ ] **Step 1: Write the failing test** `apps/api/src/db/invariants.picked.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import * as schema from "./schema/index.js";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";
import { recomputePickingItem, scanToPackage, assignPackageToBox } from "./invariants.js";
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

function row(sqlite: any) {
  return sqlite.prepare("SELECT picked_qty, scanned_not_boxed_qty, remaining_qty FROM picking_items WHERE id='pi'").get() as any;
}

test("recomputePickingItem maintains picked_qty = boxed sum (scanned -> boxed -> back)", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => scanToPackage(tx, { id: "pkg1", pickingItemId: "pi", qty: 4, sourceType: "inventory_lot", sourceId: "lotX" }));
  assert.deepEqual(row(sqlite), { picked_qty: 0, scanned_not_boxed_qty: 4, remaining_qty: 6 });

  sqlite.exec(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0')`);
  db.transaction((tx) => assignPackageToBox(tx, { packageId: "pkg1", shippingBoxId: "box" }));
  assert.deepEqual(row(sqlite), { picked_qty: 4, scanned_not_boxed_qty: 0, remaining_qty: 6 });

  // manual revert + recompute returns to scanned
  sqlite.exec(`UPDATE picking_packages SET shipping_box_id=NULL WHERE id='pkg1'`);
  db.transaction((tx) => recomputePickingItem(tx, "pi"));
  assert.deepEqual(row(sqlite), { picked_qty: 0, scanned_not_boxed_qty: 4, remaining_qty: 6 });
  assertInvariantsHold(db);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails** — `cmd.exe //c "pnpm --filter @warehouse/api test"`. Expected: FAIL (picked_qty stays 0 after boxing; guard may also fail once extended).

- [ ] **Step 3: Extend `recomputePickingItem`** in `apps/api/src/db/invariants.ts` — replace the function with:

```ts
/** Recompute picking_items.allocated_qty, scanned_not_boxed_qty and picked_qty (remaining_qty is generated). */
export function recomputePickingItem(tx: DbOrTx, pickingItemId: string): void {
  const alloc = tx.get<{ s: number }>(sql`SELECT COALESCE(SUM(qty), 0) AS s FROM allocations WHERE picking_item_id = ${pickingItemId}`);
  const scanned = tx.get<{ s: number }>(
    sql`SELECT COALESCE(SUM(qty), 0) AS s FROM picking_packages WHERE picking_item_id = ${pickingItemId} AND shipping_box_id IS NULL`
  );
  const boxed = tx.get<{ s: number }>(
    sql`SELECT COALESCE(SUM(qty), 0) AS s FROM picking_packages WHERE picking_item_id = ${pickingItemId} AND shipping_box_id IS NOT NULL`
  );
  tx.run(
    sql`UPDATE picking_items SET allocated_qty = ${alloc?.s ?? 0}, scanned_not_boxed_qty = ${scanned?.s ?? 0}, picked_qty = ${boxed?.s ?? 0}, updated_at = ${now()} WHERE id = ${pickingItemId}`
  );
}
```
Update the doc comment above the function (it currently says "allocated_qty and scanned_not_boxed_qty").

- [ ] **Step 4: Extend `assertInvariantsHold`** in `apps/api/src/db/invariants.guard.ts` — in the `picking_items` block, add `picked_qty` to the SELECT and a check. Change the `pi` query/type to include `pi.picked_qty AS sPicked` and `COALESCE((SELECT SUM(qty) FROM picking_packages WHERE picking_item_id = pi.id AND shipping_box_id IS NOT NULL), 0) AS ePicked`, and add inside the loop:
```ts
    if (r.sPicked !== r.ePicked) throw new Error(`picking ${r.id}: picked stored ${r.sPicked} expected ${r.ePicked}`);
```

- [ ] **Step 5: Run the FULL suite — expect PASS, then build**
`cmd.exe //c "pnpm --filter @warehouse/api test"` (the new test passes; all Plan 1–3 suites still green — the changed recompute must not break them) then `cmd.exe //c "pnpm --filter @warehouse/api build"` → exit 0.

- [ ] **Step 6: Commit**
```bash
git add apps/api/src/db/invariants.ts apps/api/src/db/invariants.guard.ts apps/api/src/db/invariants.picked.test.ts
git commit -m "feat(api): maintain picking_items.picked_qty as boxed sum (Plan 4 task 1)"
```

---

### Task 2: `scanAllocation` primitive (scan-to-pick against an allocation)

**Files:**
- Modify: `apps/api/src/db/invariants.ts` (extend `scanToPackage` with optional attrs)
- Create: `apps/api/src/db/pickScan.ts`
- Test: `apps/api/src/db/pickScan.test.ts`

- [ ] **Step 1: Extend `scanToPackage`** in `apps/api/src/db/invariants.ts` to accept optional attrs (additive, existing callers unaffected):

```ts
export function scanToPackage(
  tx: DbOrTx,
  p: { id: string; pickingItemId: string; qty: number; sourceType: "receiving_invoice_item" | "inventory_lot"; sourceId: string;
       dateCode?: string | null; lotCode?: string | null; coo?: string | null; cow?: string | null }
): void {
  tx.run(
    sql`INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, date_code, lot_code, coo, cow, created_at, updated_at)
        VALUES (${p.id}, ${p.pickingItemId}, ${p.sourceType}, ${p.sourceId}, ${p.qty}, NULL,
                ${p.dateCode ?? null}, ${p.lotCode ?? null}, ${p.coo ?? null}, ${p.cow ?? null}, ${now()}, ${now()})`
  );
  recomputePickingItem(tx, p.pickingItemId);
}
```

- [ ] **Step 2: Write the failing test** `apps/api/src/db/pickScan.test.ts`

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
import { scanAllocation } from "./pickScan.js";
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

test("scan against a shelf-lot allocation: lot total drops, allocation reduced, one package, invariants hold", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, date_code, created_at, updated_at) VALUES ('lot','p','S1',10,10,'202401','0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot','0','0');
  `);
  const res = db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 4 }));
  assert.equal(res.packageIds.length, 1);
  const lot = sqlite.prepare("SELECT total_qty, allocated_qty, available_qty FROM inventory_lots WHERE id='lot'").get() as any;
  assert.deepEqual(lot, { total_qty: 6, allocated_qty: 6, available_qty: 0 });
  const a = sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any;
  assert.equal(a.qty, 6);
  const pkg = sqlite.prepare("SELECT qty, source_type, source_id, date_code, shipping_box_id FROM picking_packages").get() as any;
  assert.deepEqual(pkg, { qty: 4, source_type: "inventory_lot", source_id: "lot", date_code: "202401", shipping_box_id: null });
  const pi = sqlite.prepare("SELECT scanned_not_boxed_qty, picked_qty, remaining_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { scanned_not_boxed_qty: 4, picked_qty: 0, remaining_qty: 6 });
  assertInvariantsHold(db);
  sqlite.close();
});

test("scan against a receiving allocation consumes link portions FIFO (one package per portion)", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e','R','in_hand','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, allocated_qty, available_qty, date_code, created_at, updated_at) VALUES
      ('riiA','ri','p',25,25,25,0,'202401','0','0'),
      ('riiB','ri','p',25,25,15,10,'202402','0','0');
    INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at) VALUES ('a','pi',40,'ro','0','0');
    INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at) VALUES
      ('lA','a','riiA',25,'0','0'), ('lB','a','riiB',15,'1','0');
  `);
  const res = db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 30 }));
  assert.equal(res.packageIds.length, 2); // 25 from riiA + 5 from riiB
  const riis = sqlite.prepare("SELECT id, picked_qty, allocated_qty, available_qty FROM receiving_invoice_items ORDER BY id").all() as any[];
  assert.deepEqual(riis, [
    { id: "riiA", picked_qty: 25, allocated_qty: 0, available_qty: 0 },
    { id: "riiB", picked_qty: 5, allocated_qty: 10, available_qty: 10 },
  ]);
  assert.equal((sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any).qty, 10);
  const links = sqlite.prepare("SELECT receiving_invoice_item_id AS r, qty FROM allocation_receiving_items ORDER BY id").all() as any[];
  assert.deepEqual(links, [{ r: "riiA", qty: 0 }, { r: "riiB", qty: 10 }]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("scan flips a pending order to picking and logs a transition", () => {
  const { sqlite, db } = makeDb();
  sqlite.prepare("UPDATE picking_orders SET status='pending'").run();
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot','p','S1',10,10,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot','0','0');
  `);
  db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 2, actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT status FROM picking_orders").get() as any).status, "picking");
  const logs = sqlite.prepare("SELECT entity_type, from_status, to_status, actor_id FROM transition_logs ORDER BY created_at").all() as any[];
  assert.deepEqual(logs, [
    { entity_type: "picking_order", from_status: "pending", to_status: "picking", actor_id: "u1" },
    { entity_type: "picking_item", from_status: "picking", to_status: "scanned", actor_id: "u1" },
  ]);
  sqlite.close();
});

test("scan guards: 404 missing allocation, 400 bad qty, 409 qty>allocation, 409 over-pick, 409 issue order", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot','p','S1',10,10,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',6,'lot','0','0');
  `);
  assert.throws(() => db.transaction((tx) => scanAllocation(tx, { allocationId: "nope", qty: 1 })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 0 })), (e: any) => e.status === 400);
  assert.throws(() => db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 7 })), (e: any) => e.status === 409); // > allocation 6
  // over-pick: item picked 5 + scanned 0 + 6 > qty 10
  sqlite.prepare("UPDATE picking_items SET picked_qty=5").run();
  assert.throws(() => db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 6 })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_items SET picked_qty=0").run();
  sqlite.prepare("UPDATE picking_orders SET status='issue'").run();
  assert.throws(() => db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 1 })), (e: any) => e.status === 409);
  sqlite.close();
});
```

- [ ] **Step 3: Run test to verify it fails** — `Cannot find module './pickScan.js'`.

- [ ] **Step 4: Implement `apps/api/src/db/pickScan.ts`**

```ts
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  type DbOrTx,
  applyPick,
  recomputeLot,
  recomputePickingItem,
  recomputeReceivingItem,
  scanToPackage,
} from "./invariants.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

function reduceAllocation(tx: DbOrTx, allocationId: string, qty: number): void {
  tx.run(sql`UPDATE allocations SET qty = qty - ${qty}, updated_at = ${now()} WHERE id = ${allocationId}`);
  const a = tx.get<{ pickingItemId: string; inventoryLotId: string | null }>(
    sql`SELECT picking_item_id AS pickingItemId, inventory_lot_id AS inventoryLotId FROM allocations WHERE id = ${allocationId}`
  );
  if (a) {
    recomputePickingItem(tx, a.pickingItemId);
    if (a.inventoryLotId) recomputeLot(tx, a.inventoryLotId);
  }
}

export function scanAllocation(
  tx: DbOrTx,
  a: { allocationId: string; qty: number; actorId?: string | null }
): { packageIds: string[] } {
  const alloc = tx.get<{ id: string; pickingItemId: string; qty: number; lotId: string | null; receivingOrderId: string | null }>(
    sql`SELECT id, picking_item_id AS pickingItemId, qty, inventory_lot_id AS lotId, receiving_order_id AS receivingOrderId
        FROM allocations WHERE id = ${a.allocationId}`
  );
  if (!alloc) throw new HTTPException(404, { message: "allocation not found" });
  if (!Number.isInteger(a.qty) || a.qty <= 0) throw new HTTPException(400, { message: "qty must be a positive integer" });

  const item = tx.get<{ id: string; pickingOrderId: string; qty: number; pickedQty: number; scannedNotBoxedQty: number }>(
    sql`SELECT id, picking_order_id AS pickingOrderId, qty, picked_qty AS pickedQty, scanned_not_boxed_qty AS scannedNotBoxedQty
        FROM picking_items WHERE id = ${alloc.pickingItemId}`
  )!;
  const order = tx.get<{ id: string; status: string }>(
    sql`SELECT id, status FROM picking_orders WHERE id = ${item.pickingOrderId}`
  )!;
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });
  if (order.status === "finished") throw new HTTPException(409, { message: "picking order already finished" });
  if (a.qty > alloc.qty) throw new HTTPException(409, { message: `qty ${a.qty} exceeds allocation ${alloc.qty}` });
  if (item.pickedQty + item.scannedNotBoxedQty + a.qty > item.qty)
    throw new HTTPException(409, { message: "scan quantity exceeds required" });

  const packageIds: string[] = [];

  if (alloc.lotId) {
    const lot = tx.get<{ id: string; totalQty: number; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }>(
      sql`SELECT id, total_qty AS totalQty, date_code AS dateCode, lot_code AS lotCode, coo, cow FROM inventory_lots WHERE id = ${alloc.lotId}`
    )!;
    if (lot.totalQty < a.qty) throw new HTTPException(409, { message: "insufficient lot quantity" });
    tx.run(sql`UPDATE inventory_lots SET total_qty = total_qty - ${a.qty}, updated_at = ${now()} WHERE id = ${lot.id}`);
    reduceAllocation(tx, alloc.id, a.qty); // allocations.qty -= qty; recomputeLot -> allocated = Σ allocations
    const pid = crypto.randomUUID();
    scanToPackage(tx, { id: pid, pickingItemId: item.id, qty: a.qty, sourceType: "inventory_lot", sourceId: lot.id,
      dateCode: lot.dateCode, lotCode: lot.lotCode, coo: lot.coo, cow: lot.cow });
    packageIds.push(pid);
  } else if (alloc.receivingOrderId) {
    const links = tx.all<{ id: string; riiId: string; qty: number }>(
      sql`SELECT id, receiving_invoice_item_id AS riiId, qty FROM allocation_receiving_items
          WHERE allocation_id = ${alloc.id} AND qty > 0 ORDER BY created_at ASC, id ASC`
    );
    let remaining = a.qty;
    for (const link of links) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, link.qty);
      const rii = tx.get<{ dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }>(
        sql`SELECT date_code AS dateCode, lot_code AS lotCode, coo, cow FROM receiving_invoice_items WHERE id = ${link.riiId}`
      )!;
      tx.run(sql`UPDATE allocation_receiving_items SET qty = qty - ${take}, updated_at = ${now()} WHERE id = ${link.id}`);
      applyPick(tx, link.riiId, take); // picked_qty += take; recompute rii (allocated from Σ links, available)
      const pid = crypto.randomUUID();
      scanToPackage(tx, { id: pid, pickingItemId: item.id, qty: take, sourceType: "receiving_invoice_item", sourceId: link.riiId,
        dateCode: rii.dateCode, lotCode: rii.lotCode, coo: rii.coo, cow: rii.cow });
      packageIds.push(pid);
      remaining -= take;
    }
    if (remaining > 0) throw new HTTPException(409, { message: "allocation links under-cover the requested qty" });
    reduceAllocation(tx, alloc.id, a.qty);
  } else {
    throw new HTTPException(409, { message: "allocation has no source" });
  }

  if (order.status === "pending") {
    tx.run(sql`UPDATE picking_orders SET status = 'picking', updated_at = ${now()} WHERE id = ${order.id}`);
    logTransition(tx, { entityType: "picking_order", entityId: order.id, fromStatus: "pending", toStatus: "picking", actorId: a.actorId ?? null });
  }
  logTransition(tx, { entityType: "picking_item", entityId: item.id, fromStatus: "picking", toStatus: "scanned",
    actorId: a.actorId ?? null, note: `qty=${a.qty} allocation=${alloc.id}` });

  return { packageIds };
}
```

- [ ] **Step 5: Run the FULL suite — expect PASS, then build**
`cmd.exe //c "pnpm --filter @warehouse/api test"` then `cmd.exe //c "pnpm --filter @warehouse/api build"` → exit 0.

- [ ] **Step 6: Commit**
```bash
git add apps/api/src/db/invariants.ts apps/api/src/db/pickScan.ts apps/api/src/db/pickScan.test.ts
git commit -m "feat(api): scanAllocation scan-to-pick primitive (Plan 4 task 2)"
```

---

### Task 3: Scan + undo-scan routes

**Files:**
- Modify: `apps/api/src/db/pickScan.ts` (add `removeScannedPackage`)
- Create: `apps/api/src/routes/pickingExecution.ts` (scan + undo routes only for now; later tasks append)
- Modify: `apps/api/src/index.ts`
- Modify: `packages/shared/src/index.ts` (add `ScanResponse`)
- Test: `apps/api/src/routes/pickingExecution.test.ts`

- [ ] **Step 1: Add `removeScannedPackage`** to `apps/api/src/db/pickScan.ts`

```ts
import { createAllocation, linkAllocation } from "./invariants.js"; // add to the existing invariants import

export function removeScannedPackage(tx: DbOrTx, p: { packageId: string; actorId?: string | null }): void {
  const pkg = tx.get<{ id: string; pickingItemId: string; sourceType: string; sourceId: string; qty: number; shippingBoxId: string | null }>(
    sql`SELECT id, picking_item_id AS pickingItemId, source_type AS sourceType, source_id AS sourceId, qty, shipping_box_id AS shippingBoxId
        FROM picking_packages WHERE id = ${p.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId !== null) throw new HTTPException(409, { message: "package already in a box" });

  const item = tx.get<{ id: string; pickingOrderId: string }>(
    sql`SELECT id, picking_order_id AS pickingOrderId FROM picking_items WHERE id = ${pkg.pickingItemId}`
  )!;
  const order = tx.get<{ status: string }>(sql`SELECT status FROM picking_orders WHERE id = ${item.pickingOrderId}`)!;
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });

  if (pkg.sourceType === "inventory_lot") {
    const lot = tx.get<{ id: string }>(sql`SELECT id FROM inventory_lots WHERE id = ${pkg.sourceId}`);
    if (!lot) throw new HTTPException(404, { message: "inventory lot not found" });
    tx.run(sql`UPDATE inventory_lots SET total_qty = total_qty + ${pkg.qty}, updated_at = ${now()} WHERE id = ${lot.id}`);
    const existing = tx.get<{ id: string }>(
      sql`SELECT id FROM allocations WHERE picking_item_id = ${pkg.pickingItemId} AND inventory_lot_id = ${lot.id}`
    );
    if (existing) {
      tx.run(sql`UPDATE allocations SET qty = qty + ${pkg.qty}, updated_at = ${now()} WHERE id = ${existing.id}`);
      recomputePickingItem(tx, pkg.pickingItemId);
      recomputeLot(tx, lot.id);
    } else {
      createAllocation(tx, { id: crypto.randomUUID(), pickingItemId: pkg.pickingItemId, qty: pkg.qty, inventoryLotId: lot.id });
    }
  } else if (pkg.sourceType === "receiving_invoice_item") {
    const rii = tx.get<{ pickedQty: number; receivingOrderId: string }>(
      sql`SELECT rii.picked_qty AS pickedQty, ri.receiving_order_id AS receivingOrderId
          FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
          WHERE rii.id = ${pkg.sourceId}`
    );
    if (!rii) throw new HTTPException(404, { message: "receiving invoice item not found" });
    tx.run(sql`UPDATE receiving_invoice_items SET picked_qty = picked_qty - ${pkg.qty}, updated_at = ${now()} WHERE id = ${pkg.sourceId}`);
    let allocation = tx.get<{ id: string }>(
      sql`SELECT id FROM allocations WHERE picking_item_id = ${pkg.pickingItemId} AND receiving_order_id = ${rii.receivingOrderId}`
    );
    let allocationId: string;
    if (allocation) {
      tx.run(sql`UPDATE allocations SET qty = qty + ${pkg.qty}, updated_at = ${now()} WHERE id = ${allocation.id}`);
      allocationId = allocation.id;
    } else {
      allocationId = crypto.randomUUID();
      createAllocation(tx, { id: allocationId, pickingItemId: pkg.pickingItemId, qty: pkg.qty, receivingOrderId: rii.receivingOrderId });
    }
    const link = tx.get<{ id: string }>(
      sql`SELECT id FROM allocation_receiving_items WHERE allocation_id = ${allocationId} AND receiving_invoice_item_id = ${pkg.sourceId}`
    );
    if (link) {
      tx.run(sql`UPDATE allocation_receiving_items SET qty = qty + ${pkg.qty}, updated_at = ${now()} WHERE id = ${link.id}`);
    } else {
      linkAllocation(tx, { id: crypto.randomUUID(), allocationId, receivingInvoiceItemId: pkg.sourceId, qty: pkg.qty });
    }
    recomputeReceivingItem(tx, pkg.sourceId);
  } else {
    throw new HTTPException(409, { message: "unknown package source type" });
  }

  tx.run(sql`DELETE FROM picking_packages WHERE id = ${pkg.id}`);
  recomputePickingItem(tx, pkg.pickingItemId);
  logTransition(tx, { entityType: "picking_item", entityId: pkg.pickingItemId, fromStatus: "scanned", toStatus: "removed",
    actorId: p.actorId ?? null, note: `qty=${pkg.qty} package=${pkg.id}` });
}
```

- [ ] **Step 2: Write the failing route test** `apps/api/src/routes/pickingExecution.test.ts`

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

function seedPickable() {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot','p','S1',10,10,'0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','pe','R','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',10,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot','0','0');
  `);
}

test("POST /picking-orders/:id/scan picks against the allocation; DELETE package undoes it", async () => {
  seedPickable();
  const scan = await app.request("/picking-orders/po/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allocation_id: "a", qty: 4 }),
  });
  assert.equal(scan.status, 201);
  const body = (await scan.json()) as { package_ids: string[] };
  assert.equal(body.package_ids.length, 1);
  assert.equal((sqlite.prepare("SELECT total_qty FROM inventory_lots WHERE id='lot'").get() as any).total_qty, 6);

  const del = await app.request(`/picking-orders/po/packages/${body.package_ids[0]}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  // lot restored, allocation restored, package gone
  assert.equal((sqlite.prepare("SELECT total_qty FROM inventory_lots WHERE id='lot'").get() as any).total_qty, 10);
  assert.equal((sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any).qty, 10);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM picking_packages").get() as any).c, 0);
});

test("scan of an allocation from another order is 404; bad qty is 400", async () => {
  const other = await app.request("/picking-orders/other/scan", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ allocation_id: "a", qty: 1 }),
  });
  assert.equal(other.status, 404);
  const bad = await app.request("/picking-orders/po/scan", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ allocation_id: "a", qty: -1 }),
  });
  assert.equal(bad.status, 400);
});

test("cleanup", () => { sqlite.close(); });
```

- [ ] **Step 3: Run test to verify it fails** (route not found).

- [ ] **Step 4: Add `ScanResponse` to `packages/shared/src/index.ts`**
```ts
export interface ScanResponse { package_ids: string[]; }
```

- [ ] **Step 5: Create `apps/api/src/routes/pickingExecution.ts`** (scan + undo for now)

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import type { ScanResponse } from "@warehouse/shared";
import { db } from "../db.js";
import { scanAllocation, removeScannedPackage } from "../db/pickScan.js";

export const pickingExecutionRoute = new Hono();

async function readJson<T>(c: any): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

pickingExecutionRoute.post("/picking-orders/:id/scan", async (c) => {
  const orderId = c.req.param("id");
  const body = await readJson<{ allocation_id?: string; qty?: number; actor_id?: string | null }>(c);
  if (!body.allocation_id) throw new HTTPException(400, { message: "allocation_id is required" });
  const result = db.transaction((tx) => {
    const order = tx.get<{ id: string }>(sql`SELECT id FROM picking_orders WHERE id = ${orderId}`);
    if (!order) throw new HTTPException(404, { message: "picking order not found" });
    const owner = tx.get<{ ok: number }>(sql`
      SELECT 1 AS ok FROM allocations a
      JOIN picking_items pi ON pi.id = a.picking_item_id
      WHERE a.id = ${body.allocation_id} AND pi.picking_order_id = ${orderId}`);
    if (!owner) throw new HTTPException(404, { message: "allocation not found in this order" });
    return scanAllocation(tx, { allocationId: body.allocation_id!, qty: body.qty as number, actorId: body.actor_id ?? null });
  });
  const res: ScanResponse = { package_ids: result.packageIds };
  return c.json(res, 201);
});

pickingExecutionRoute.delete("/picking-orders/:id/packages/:package_id", async (c) => {
  const orderId = c.req.param("id");
  const packageId = c.req.param("package_id");
  const actorId = c.req.query("actor_id") ?? null;
  db.transaction((tx) => {
    const pkg = tx.get<{ pickingOrderId: string }>(sql`
      SELECT pi.picking_order_id AS pickingOrderId FROM picking_packages pp
      JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${packageId}`);
    if (!pkg || pkg.pickingOrderId !== orderId) throw new HTTPException(404, { message: "package not found in this order" });
    removeScannedPackage(tx, { packageId, actorId });
  });
  return c.json({ ok: true }, 200);
});
```

- [ ] **Step 6: Mount in `apps/api/src/index.ts`**
```ts
import { pickingExecutionRoute } from "./routes/pickingExecution.js";
app.route("/", pickingExecutionRoute);
```

- [ ] **Step 7: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/pickScan.ts apps/api/src/routes/pickingExecution.ts apps/api/src/index.ts packages/shared/src/index.ts apps/api/src/routes/pickingExecution.test.ts
git commit -m "feat(api): scan + undo-scan routes (Plan 4 task 3)"
```

---

### Task 4: Shipping-box lifecycle (create / cancel)

**Files:**
- Modify: `apps/api/src/db/pickScan.ts` (add `createShippingBox`, `cancelShippingBox`)
- Modify: `apps/api/src/routes/pickingExecution.ts` (add `POST /picking-orders/:id/boxes`, `POST /picking-orders/:id/boxes/:box_id/cancel`)
- Test: `apps/api/src/db/pickScan.box.test.ts` (new file; box tests grow here and in Task 5)

- [ ] **Step 1: Write the failing test** `apps/api/src/db/pickScan.box.test.ts`

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
import { createShippingBox, cancelShippingBox } from "./pickScan.js";
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

test("createShippingBox creates an open box + transition log; cancel removes an empty open box", () => {
  const { sqlite, db } = makeDb();
  const boxId = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po", actorId: "u1" }));
  const box = sqlite.prepare("SELECT status, picking_order_id FROM shipping_boxes WHERE id=?").get(boxId) as any;
  assert.deepEqual(box, { status: "open", picking_order_id: "po" });
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shipping_box' AND to_status='open'").get() as any).c, 1);

  db.transaction((tx) => cancelShippingBox(tx, { shippingBoxId: boxId, actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM shipping_boxes").get() as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("box guards: create on finished/issue order is 409; cancel non-empty or non-open box is 409; missing is 404", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "nope" })), (e: any) => e.status === 404);
  sqlite.prepare("UPDATE picking_orders SET status='finished'").run();
  assert.throws(() => db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_orders SET status='issue'").run();
  assert.throws(() => db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_orders SET status='picking'").run();

  const boxId = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  // non-empty
  sqlite.exec(`INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
               VALUES ('pp','pi','inventory_lot','lot',1,?,'0','0')`.replace("?", `'${boxId}'`));
  assert.throws(() => db.transaction((tx) => cancelShippingBox(tx, { shippingBoxId: boxId })), (e: any) => e.status === 409);
  sqlite.prepare("DELETE FROM picking_packages").run();
  // non-open
  sqlite.prepare("UPDATE shipping_boxes SET status='closed' WHERE id=?").run(boxId);
  assert.throws(() => db.transaction((tx) => cancelShippingBox(tx, { shippingBoxId: boxId })), (e: any) => e.status === 409);
  assert.throws(() => db.transaction((tx) => cancelShippingBox(tx, { shippingBoxId: "nope" })), (e: any) => e.status === 404);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails** (functions not exported).

- [ ] **Step 3: Implement** in `apps/api/src/db/pickScan.ts` (append)

```ts
function loadOrderForWrite(tx: DbOrTx, orderId: string): { id: string; status: string } {
  const order = tx.get<{ id: string; status: string }>(sql`SELECT id, status FROM picking_orders WHERE id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "picking order not found" });
  return order;
}

function assertOrderWritable(order: { status: string }): void {
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });
  if (order.status === "finished") throw new HTTPException(409, { message: "picking order already finished" });
}

export function createShippingBox(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): string {
  const order = loadOrderForWrite(tx, a.pickingOrderId);
  assertOrderWritable(order);
  const id = crypto.randomUUID();
  tx.run(
    sql`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at)
        VALUES (${id}, ${a.pickingOrderId}, 'open', ${now()}, ${now()})`
  );
  logTransition(tx, { entityType: "shipping_box", entityId: id, fromStatus: null, toStatus: "open", actorId: a.actorId ?? null,
    note: `picking_order=${a.pickingOrderId}` });
  return id;
}

export function cancelShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): void {
  const box = tx.get<{ id: string; status: string; pickingOrderId: string }>(
    sql`SELECT id, status, picking_order_id AS pickingOrderId FROM shipping_boxes WHERE id = ${a.shippingBoxId}`
  );
  if (!box) throw new HTTPException(404, { message: "box not found" });
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const used = tx.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM picking_packages WHERE shipping_box_id = ${box.id}`)!;
  if (used.c > 0) throw new HTTPException(409, { message: "box is not empty" });
  tx.run(sql`DELETE FROM shipping_boxes WHERE id = ${box.id}`);
  logTransition(tx, { entityType: "shipping_box", entityId: box.id, fromStatus: box.status, toStatus: "cancelled",
    actorId: a.actorId ?? null, note: `picking_order=${box.pickingOrderId}` });
}
```

- [ ] **Step 4: Add routes** to `apps/api/src/routes/pickingExecution.ts` (append; import `createShippingBox`, `cancelShippingBox` from `../db/pickScan.js`)

```ts
pickingExecutionRoute.post("/picking-orders/:id/boxes", async (c) => {
  const orderId = c.req.param("id");
  let actorId: string | null = null;
  try { actorId = (await c.req.json<{ actor_id?: string | null }>()).actor_id ?? null; } catch { /* empty body ok */ }
  const boxId = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: orderId, actorId }));
  return c.json({ id: boxId }, 201);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes/:box_id/cancel", (c) => {
  const boxId = c.req.param("box_id");
  db.transaction((tx) => cancelShippingBox(tx, { shippingBoxId: boxId, actorId: null }));
  return c.json({ ok: true }, 200);
});
```

- [ ] **Step 5: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/pickScan.ts apps/api/src/db/pickScan.box.test.ts apps/api/src/routes/pickingExecution.ts
git commit -m "feat(api): shipping box create/cancel (Plan 4 task 4)"
```

---

### Task 5: Pack operations + auto-finish → measuring task

**Files:**
- Modify: `apps/api/src/db/pickScan.ts` (add `addPackageToBox`, `addAllUnboxedToBox`, `removePackageFromBox`, `maybeAutoFinishPickingOrder`)
- Modify: `apps/api/src/routes/pickingExecution.ts` (add 3 routes)
- Test: `apps/api/src/db/pickScan.box.test.ts` (append)

- [ ] **Step 1: Append failing tests** to `apps/api/src/db/pickScan.box.test.ts`

```ts
function seedScanned(sqlite: any, qty = 10) {
  // one unboxed scanned package of qty on item 'pi'
  sqlite.exec(`
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
    VALUES ('pp','pi','inventory_lot','lot',${qty},NULL,'0','0');
    UPDATE picking_items SET scanned_not_boxed_qty=${qty};
  `);
}

test("addPackageToBox moves package into the box: scanned drops, picked rises; auto-finish creates measuring task", () => {
  const { sqlite, db } = makeDb();
  seedScanned(sqlite, 10); // item qty is 10 -> fully boxed after this
  const boxId = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  db.transaction((tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: boxId, actorId: "u1" }));

  const pi = sqlite.prepare("SELECT picked_qty, scanned_not_boxed_qty, remaining_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { picked_qty: 10, scanned_not_boxed_qty: 0, remaining_qty: 0 });
  const po = sqlite.prepare("SELECT status FROM picking_orders WHERE id='po'").get() as any;
  assert.equal(po.status, "finished");
  const tasks = sqlite.prepare("SELECT picking_order_id, status FROM measuring_tasks").all() as any[];
  assert.deepEqual(tasks, [{ picking_order_id: "po", status: "pending" }]);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='picking_order' AND to_status='finished'").get() as any).c, 1);
  assertInvariantsHold(db);

  // idempotent: a second maybeAutoFinish does not duplicate the task or the transition
  db.transaction((tx) => { const done = maybeAutoFinishPickingOrder(tx, { pickingOrderId: "po" }); assert.equal(done, false); });
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM measuring_tasks").get() as any).c, 1);
  sqlite.close();
});

test("addPackageToBox guards: cross-order package 409, box not open 409, already-boxed 409", () => {
  const { sqlite, db } = makeDb();
  seedScanned(sqlite, 4);
  sqlite.exec(`INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po2','e2','R2','picking','0','0')`);
  const otherBox = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po2" }));
  assert.throws(() => db.transaction((tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: otherBox })), (e: any) => e.status === 409);

  const box = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  sqlite.prepare("UPDATE shipping_boxes SET status='closed' WHERE id=?").run(box);
  assert.throws(() => db.transaction((tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: box })), (e: any) => e.status === 409);

  sqlite.prepare("UPDATE shipping_boxes SET status='open' WHERE id=?").run(box);
  db.transaction((tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: box }));
  assert.throws(() => db.transaction((tx) => addPackageToBox(tx, { packageId: "pp", shippingBoxId: box })), (e: any) => e.status === 409);
  sqlite.close();
});

test("addAllUnboxedToBox packs every unboxed package of the order; removePackageFromBox reverts picked/scanned", () => {
  const { sqlite, db } = makeDb();
  seedScanned(sqlite, 4);
  sqlite.exec(`INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
               VALUES ('pp2','pi','inventory_lot','lot',2,NULL,'0','0');
               UPDATE picking_items SET scanned_not_boxed_qty=6;`);
  const box = db.transaction((tx) => createShippingBox(tx, { pickingOrderId: "po" }));
  const n = db.transaction((tx) => addAllUnboxedToBox(tx, { shippingBoxId: box, actorId: "u1" }));
  assert.equal(n, 2);
  let pi = sqlite.prepare("SELECT picked_qty, scanned_not_boxed_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { picked_qty: 6, scanned_not_boxed_qty: 0 });

  db.transaction((tx) => removePackageFromBox(tx, { packageId: "pp2", actorId: "u1" }));
  pi = sqlite.prepare("SELECT picked_qty, scanned_not_boxed_qty FROM picking_items WHERE id='pi'").get() as any;
  assert.deepEqual(pi, { picked_qty: 4, scanned_not_boxed_qty: 2 });
  const pkg = sqlite.prepare("SELECT shipping_box_id, verified FROM picking_packages WHERE id='pp2'").get() as any;
  assert.deepEqual(pkg, { shipping_box_id: null, verified: 0 });
  assertInvariantsHold(db);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails** (functions not exported).

- [ ] **Step 3: Implement** in `apps/api/src/db/pickScan.ts` (append)

```ts
import { assignPackageToBox } from "./invariants.js"; // add to the existing invariants import

export function maybeAutoFinishPickingOrder(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): boolean {
  const order = tx.get<{ id: string; status: string }>(sql`SELECT id, status FROM picking_orders WHERE id = ${a.pickingOrderId}`);
  if (!order) return false;
  if (order.status !== "pending" && order.status !== "picking") return false;
  const items = tx.all<{ qty: number; pickedQty: number }>(
    sql`SELECT qty, picked_qty AS pickedQty FROM picking_items WHERE picking_order_id = ${order.id}`
  );
  if (items.length === 0) return false;
  if (!items.every((i) => i.pickedQty >= i.qty)) return false;

  tx.run(sql`UPDATE picking_orders SET status = 'finished', updated_at = ${now()} WHERE id = ${order.id}`);
  tx.run(
    sql`INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${order.id}, 'pending', ${now()}, ${now()})
        ON CONFLICT (picking_order_id) DO NOTHING`
  );
  logTransition(tx, { entityType: "picking_order", entityId: order.id, fromStatus: order.status, toStatus: "finished", actorId: a.actorId ?? null });
  return true;
}

function loadBoxForPack(tx: DbOrTx, boxId: string): { id: string; status: string; pickingOrderId: string } {
  const box = tx.get<{ id: string; status: string; pickingOrderId: string }>(
    sql`SELECT id, status, picking_order_id AS pickingOrderId FROM shipping_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "box not found" });
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  return box;
}

export function addPackageToBox(tx: DbOrTx, a: { packageId: string; shippingBoxId: string; actorId?: string | null }): void {
  const pkg = tx.get<{ id: string; pickingItemId: string; pickingOrderId: string; shippingBoxId: string | null; qty: number }>(
    sql`SELECT pp.id, pp.picking_item_id AS pickingItemId, pi.picking_order_id AS pickingOrderId, pp.shipping_box_id AS shippingBoxId, pp.qty
        FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${a.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId !== null) throw new HTTPException(409, { message: "package already in a box" });
  const box = loadBoxForPack(tx, a.shippingBoxId);
  if (box.pickingOrderId !== pkg.pickingOrderId) throw new HTTPException(409, { message: "package does not belong to this picking order" });
  const order = loadOrderForWrite(tx, box.pickingOrderId);
  assertOrderWritable(order);

  assignPackageToBox(tx, { packageId: pkg.id, shippingBoxId: box.id }); // sets box + recomputePickingItem (picked up, scanned down)
  logTransition(tx, { entityType: "picking_item", entityId: pkg.pickingItemId, fromStatus: "scanned", toStatus: "boxed",
    actorId: a.actorId ?? null, note: `qty=${pkg.qty} box=${box.id}` });
  maybeAutoFinishPickingOrder(tx, { pickingOrderId: pkg.pickingOrderId, actorId: a.actorId ?? null });
}

export function addAllUnboxedToBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): number {
  const box = loadBoxForPack(tx, a.shippingBoxId);
  const order = loadOrderForWrite(tx, box.pickingOrderId);
  assertOrderWritable(order);
  const packages = tx.all<{ id: string }>(
    sql`SELECT pp.id FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id
        WHERE pi.picking_order_id = ${box.pickingOrderId} AND pp.shipping_box_id IS NULL ORDER BY pp.created_at ASC, pp.id ASC`
  );
  for (const pkg of packages) {
    assignPackageToBox(tx, { packageId: pkg.id, shippingBoxId: box.id });
  }
  maybeAutoFinishPickingOrder(tx, { pickingOrderId: box.pickingOrderId, actorId: a.actorId ?? null });
  return packages.length;
}

export function removePackageFromBox(tx: DbOrTx, a: { packageId: string; actorId?: string | null }): void {
  const pkg = tx.get<{ id: string; pickingItemId: string; shippingBoxId: string | null; qty: number }>(
    sql`SELECT id, picking_item_id AS pickingItemId, shipping_box_id AS shippingBoxId, qty FROM picking_packages WHERE id = ${a.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId === null) throw new HTTPException(409, { message: "package is not in a box" });
  const box = loadBoxForPack(tx, pkg.shippingBoxId);
  const order = loadOrderForWrite(tx, box.pickingOrderId);
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });

  tx.run(sql`UPDATE picking_packages SET shipping_box_id = NULL, verified = 0, updated_at = ${now()} WHERE id = ${pkg.id}`);
  recomputePickingItem(tx, pkg.pickingItemId);
  logTransition(tx, { entityType: "picking_item", entityId: pkg.pickingItemId, fromStatus: "boxed", toStatus: "scanned",
    actorId: a.actorId ?? null, note: `qty=${pkg.qty} box=${box.id}` });
}
```

- [ ] **Step 4: Add routes** to `apps/api/src/routes/pickingExecution.ts` (append; import the three new functions)

```ts
pickingExecutionRoute.post("/picking-orders/:id/boxes/:box_id/packages", async (c) => {
  const boxId = c.req.param("box_id");
  const body = await readJson<{ package_id?: string; actor_id?: string | null }>(c);
  if (!body.package_id) throw new HTTPException(400, { message: "package_id is required" });
  db.transaction((tx) => addPackageToBox(tx, { packageId: body.package_id!, shippingBoxId: boxId, actorId: body.actor_id ?? null }));
  return c.json({ ok: true }, 200);
});

pickingExecutionRoute.post("/picking-orders/:id/boxes/:box_id/add-all-unboxed", (c) => {
  const boxId = c.req.param("box_id");
  const n = db.transaction((tx) => addAllUnboxedToBox(tx, { shippingBoxId: boxId, actorId: null }));
  return c.json({ packed: n }, 200);
});

pickingExecutionRoute.delete("/picking-orders/:id/boxes/:box_id/packages/:package_id", (c) => {
  const packageId = c.req.param("package_id");
  db.transaction((tx) => removePackageFromBox(tx, { packageId, actorId: null }));
  return c.json({ ok: true }, 200);
});
```

- [ ] **Step 5: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/pickScan.ts apps/api/src/db/pickScan.box.test.ts apps/api/src/routes/pickingExecution.ts
git commit -m "feat(api): pack ops + auto-finish -> measuring task (Plan 4 task 5)"
```

---

### Task 6: Undo-scan tests + manual finish

**Files:**
- Test: `apps/api/src/db/pickScan.undo.test.ts` (new — `removeScannedPackage` unit coverage, incl. receiving-portion undo)
- Modify: `apps/api/src/db/pickScan.ts` (add `finishPickingOrder`)
- Modify: `apps/api/src/routes/pickingExecution.ts` (add `POST /picking-orders/:id/finish`)

- [ ] **Step 1: Write the failing test** `apps/api/src/db/pickScan.undo.test.ts`

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
import { scanAllocation, removeScannedPackage, finishPickingOrder } from "./pickScan.js";
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

test("undo a lot-scan restores lot + allocation + removes package", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO inventory_lots (id, part_id, shelf_code, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot','p','S1',10,10,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('a','pi',10,'lot','0','0');
  `);
  const { packageIds } = db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 4 }));
  db.transaction((tx) => removeScannedPackage(tx, { packageId: packageIds[0], actorId: "u1" }));
  assert.deepEqual(sqlite.prepare("SELECT total_qty, allocated_qty FROM inventory_lots WHERE id='lot'").get() as any, { total_qty: 10, allocated_qty: 10 });
  assert.equal((sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any).qty, 10);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM picking_packages").get() as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("undo a receiving-portion scan restores picked_qty, link qty and allocation", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`
    INSERT INTO receiving_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('ro','e','R','in_hand','0','0');
    INSERT INTO receiving_invoices (id, receiving_order_id, invoice_no, created_at, updated_at) VALUES ('ri','ro','I','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, allocated_qty, available_qty, created_at, updated_at)
      VALUES ('rii','ri','p',10,10,10,0,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, receiving_order_id, created_at, updated_at) VALUES ('a','pi',10,'ro','0','0');
    INSERT INTO allocation_receiving_items (id, allocation_id, receiving_invoice_item_id, qty, created_at, updated_at) VALUES ('l','a','rii',10,'0','0');
  `);
  const { packageIds } = db.transaction((tx) => scanAllocation(tx, { allocationId: "a", qty: 4 }));
  db.transaction((tx) => removeScannedPackage(tx, { packageId: packageIds[0] }));
  assert.deepEqual(
    sqlite.prepare("SELECT picked_qty, allocated_qty, available_qty FROM receiving_invoice_items WHERE id='rii'").get() as any,
    { picked_qty: 0, allocated_qty: 10, available_qty: 0 }
  );
  assert.equal((sqlite.prepare("SELECT qty FROM allocations WHERE id='a'").get() as any).qty, 10);
  assert.equal((sqlite.prepare("SELECT qty FROM allocation_receiving_items WHERE id='l'").get() as any).qty, 10);
  assertInvariantsHold(db);
  sqlite.close();
});

test("undo guards: 404 missing package, 409 boxed package", () => {
  const { sqlite, db } = makeDb();
  sqlite.exec(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0')`);
  sqlite.exec(`INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
               VALUES ('pp','pi','inventory_lot','lot',1,'box','0','0')`);
  assert.throws(() => db.transaction((tx) => removeScannedPackage(tx, { packageId: "nope" })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => removeScannedPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  sqlite.close();
});

test("finishPickingOrder: finishes a fully-picked order; 409 when not fully picked; 404 missing", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => finishPickingOrder(tx, { pickingOrderId: "nope" })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => finishPickingOrder(tx, { pickingOrderId: "po" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_items SET picked_qty=10").run();
  db.transaction((tx) => finishPickingOrder(tx, { pickingOrderId: "po" }));
  assert.equal((sqlite.prepare("SELECT status FROM picking_orders").get() as any).status, "finished");
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM measuring_tasks WHERE picking_order_id='po'").get() as any).c, 1);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails** (`finishPickingOrder` not exported).

- [ ] **Step 3: Add `finishPickingOrder`** to `apps/api/src/db/pickScan.ts`

```ts
export function finishPickingOrder(tx: DbOrTx, a: { pickingOrderId: string; actorId?: string | null }): void {
  const order = tx.get<{ id: string; status: string }>(sql`SELECT id, status FROM picking_orders WHERE id = ${a.pickingOrderId}`);
  if (!order) throw new HTTPException(404, { message: "picking order not found" });
  if (order.status === "finished") throw new HTTPException(409, { message: "picking order already finished" });
  if (order.status === "issue") throw new HTTPException(409, { message: "picking order has an open issue" });
  const items = tx.all<{ qty: number; pickedQty: number }>(
    sql`SELECT qty, picked_qty AS pickedQty FROM picking_items WHERE picking_order_id = ${order.id}`
  );
  if (items.length === 0) throw new HTTPException(409, { message: "no items to pick" });
  if (!items.every((i) => i.pickedQty >= i.qty)) throw new HTTPException(409, { message: "not all items fully boxed" });
  const done = maybeAutoFinishPickingOrder(tx, a);
  if (!done) throw new HTTPException(409, { message: "picking order could not be finished" });
}
```

- [ ] **Step 4: Add the route** to `apps/api/src/routes/pickingExecution.ts` (append; import `finishPickingOrder`)

```ts
pickingExecutionRoute.post("/picking-orders/:id/finish", (c) => {
  const orderId = c.req.param("id");
  db.transaction((tx) => finishPickingOrder(tx, { pickingOrderId: orderId, actorId: null }));
  return c.json({ ok: true }, 200);
});
```

- [ ] **Step 5: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/pickScan.ts apps/api/src/db/pickScan.undo.test.ts apps/api/src/routes/pickingExecution.ts
git commit -m "feat(api): undo-scan tests + manual finish (Plan 4 task 6)"
```

---

### Task 7: Read + polling endpoints (picking detail/list, measuring list)

**Files:**
- Modify: `apps/api/src/routes/pickingExecution.ts` (add `GET /picking-orders`, `GET /picking-orders/:id`)
- Create: `apps/api/src/routes/measuring.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/routes/measuring.test.ts` + extend `apps/api/src/routes/pickingExecution.test.ts` (append read tests)

**Detail response shape** (what the PDA renders + matches scans against):
```json
{
  "order": { "id", "external_id", "ref_no", "status", "ship_to", "destination_country", "created_at", "updated_at" },
  "items": [{ "id", "part_id", "part_no", "qty", "picked_qty", "scanned_not_boxed_qty", "remaining_qty", "allocated_qty", "line_id" }],
  "allocations": [{ "id", "picking_item_id", "qty", "inventory_lot_id", "receiving_order_id",
    "lot": { "shelf_code", "box_id", "date_code", "lot_code", "coo", "cow", "date_code_norm", "lot_code_norm", "coo_norm", "cow_norm" } | null,
    "receiving_items": [{ "receiving_invoice_item_id", "qty", "invoice_no", "box_id",
      "date_code_norm", "lot_code_norm", "coo_norm", "cow_norm" }] }],
  "packages": [{ "id", "picking_item_id", "source_type", "source_id", "qty", "shipping_box_id", "date_code", "lot_code", "coo", "cow", "verified" }],
  "boxes": [{ "id", "status", "box_size", "net_weight_g", "gross_weight_g", "destination_country", "created_at", "updated_at" }]
}
```
Allocations with `qty = 0` are audit residue — **exclude** them (and links with `qty = 0`) from the detail response.

- [ ] **Step 1: Append failing tests** to `apps/api/src/routes/pickingExecution.test.ts`

```ts
test("GET /picking-orders/:id returns detail with items, allocations, packages, boxes", async () => {
  const res = await app.request("/picking-orders/po");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;
  assert.equal(d.order.ref_no, "R");
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].part_no, "X");
  assert.equal(d.allocations.length, 1);
  assert.equal(d.allocations[0].lot.shelf_code, "S1");
  assert.deepEqual(d.allocations[0].receiving_items, []);
  assert.deepEqual(d.packages, []);
  assert.deepEqual(d.boxes, []);
  const missing = await app.request("/picking-orders/nope");
  assert.equal(missing.status, 404);
});

test("GET /picking-orders filters by status and updated_since", async () => {
  const all = await app.request("/picking-orders");
  assert.equal(all.status, 200);
  assert.equal(((await all.json()) as any[]).length >= 1, true);
  const picking = await app.request("/picking-orders?status=picking");
  assert.equal(((await picking.json()) as any[]).every((o: any) => o.status === "picking"), true);
  const future = await app.request("/picking-orders?updated_since=2999-01-01T00:00:00.000Z");
  assert.deepEqual(await future.json(), []);
});
```

And create `apps/api/src/routes/measuring.test.ts`:

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

test("GET /measuring-tasks filters by status and since", async () => {
  sqlite.exec(`INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','pe','R','finished','0','0')`);
  sqlite.exec(`INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES
    ('mt','po','pending','2026-07-10T00:00:00.000Z','2026-07-10T00:00:00.000Z')`);
  const all = await app.request("/measuring-tasks");
  assert.equal(all.status, 200);
  assert.equal(((await all.json()) as any[]).length, 1);
  const pending = await app.request("/measuring-tasks?status=pending");
  assert.equal(((await pending.json()) as any[])[0].id, "mt");
  const since = await app.request("/measuring-tasks?since=2026-07-11T00:00:00.000Z");
  assert.deepEqual(await since.json(), []);
});

test("cleanup", () => { sqlite.close(); });
```

- [ ] **Step 2: Run tests to verify they fail** (routes not found).

- [ ] **Step 3: Add the reads** to `apps/api/src/routes/pickingExecution.ts` (append)

```ts
pickingExecutionRoute.get("/picking-orders", (c) => {
  const status = c.req.query("status");
  const updatedSince = c.req.query("updated_since");
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at
    FROM picking_orders
    WHERE (${status ?? null} IS NULL OR status = ${status ?? null})
      AND (${updatedSince ?? null} IS NULL OR updated_at > ${updatedSince ?? null})
    ORDER BY updated_at ASC, id ASC LIMIT 200`);
  return c.json(rows, 200);
});

pickingExecutionRoute.get("/picking-orders/:id", (c) => {
  const orderId = c.req.param("id");
  const order = db.get<Record<string, unknown>>(sql`
    SELECT id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at
    FROM picking_orders WHERE id = ${orderId}`);
  if (!order) throw new HTTPException(404, { message: "picking order not found" });

  const items = db.all<Record<string, unknown>>(sql`
    SELECT pi.id, pi.part_id, p.part_no, pi.qty, pi.picked_qty, pi.scanned_not_boxed_qty,
           pi.remaining_qty, pi.allocated_qty, pi.line_id
    FROM picking_items pi JOIN parts p ON p.id = pi.part_id
    WHERE pi.picking_order_id = ${orderId} ORDER BY pi.created_at ASC, pi.id ASC`);

  const allocations = db.all<Record<string, unknown>>(sql`
    SELECT a.id, a.picking_item_id, a.qty, a.inventory_lot_id, a.receiving_order_id
    FROM allocations a JOIN picking_items pi ON pi.id = a.picking_item_id
    WHERE pi.picking_order_id = ${orderId} AND a.qty > 0 ORDER BY a.created_at ASC, a.id ASC`);
  for (const a of allocations) {
    a.lot = a.inventory_lot_id
      ? db.get<Record<string, unknown>>(sql`
          SELECT shelf_code, box_id, date_code, lot_code, coo, cow,
                 date_code_norm, lot_code_norm, coo_norm, cow_norm
          FROM inventory_lots WHERE id = ${a.inventory_lot_id}`) ?? null
      : null;
    a.receiving_items = db.all<Record<string, unknown>>(sql`
      SELECT ari.receiving_invoice_item_id, ari.qty, ri.invoice_no, rii.box_id,
             rii.date_code_norm, rii.lot_code_norm, rii.coo_norm, rii.cow_norm
      FROM allocation_receiving_items ari
      JOIN receiving_invoice_items rii ON rii.id = ari.receiving_invoice_item_id
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      WHERE ari.allocation_id = ${a.id} AND ari.qty > 0 ORDER BY ari.created_at ASC, ari.id ASC`);
  }

  const packages = db.all<Record<string, unknown>>(sql`
    SELECT pp.id, pp.picking_item_id, pp.source_type, pp.source_id, pp.qty, pp.shipping_box_id,
           pp.date_code, pp.lot_code, pp.coo, pp.cow, pp.verified
    FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id
    WHERE pi.picking_order_id = ${orderId} ORDER BY pp.created_at ASC, pp.id ASC`);

  const boxes = db.all<Record<string, unknown>>(sql`
    SELECT id, status, box_size, net_weight_g, gross_weight_g, destination_country, created_at, updated_at
    FROM shipping_boxes WHERE picking_order_id = ${orderId} ORDER BY created_at ASC, id ASC`);

  return c.json({ order, items, allocations, packages, boxes }, 200);
});
```

- [ ] **Step 4: Create `apps/api/src/routes/measuring.ts`**

```ts
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db.js";

export const measuringRoute = new Hono();

measuringRoute.get("/measuring-tasks", (c) => {
  const status = c.req.query("status");
  const since = c.req.query("since");
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT id, picking_order_id, status, created_at, updated_at
    FROM measuring_tasks
    WHERE (${status ?? null} IS NULL OR status = ${status ?? null})
      AND (${since ?? null} IS NULL OR updated_at > ${since ?? null})
    ORDER BY updated_at ASC, id ASC LIMIT 200`);
  return c.json(rows, 200);
});
```

- [ ] **Step 5: Mount** in `apps/api/src/index.ts`: `import { measuringRoute } from "./routes/measuring.js";` + `app.route("/", measuringRoute);`

- [ ] **Step 6: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/routes/pickingExecution.ts apps/api/src/routes/measuring.ts apps/api/src/index.ts apps/api/src/routes/measuring.test.ts apps/api/src/routes/pickingExecution.test.ts
git commit -m "feat(api): picking detail/list + measuring polling (Plan 4 task 7)"
```

---

### Task 8: Final verification gate

- [ ] **Step 1: Type build clean** — `cmd.exe //c "pnpm --filter @warehouse/api build"` → exit 0.
- [ ] **Step 2: Full suite green** — `cmd.exe //c "pnpm --filter @warehouse/api test"` → record the pass count for the docs commit.

- [ ] **Step 3: Live curl smoke of the full picking flow** (isolated temp DB + dedicated port, kill the server + delete the temp DB after; do NOT touch `apps/api/dev.sqlite`):
```bash
# PUT receiving (qty 100) -> confirm-arrival -> PUT picking (qty 40) [from Plan 3 endpoints]
# GET /picking-orders/<po_id>           -> capture allocation id
# POST /picking-orders/<po_id>/scan     {allocation_id, qty:40}   -> 201, one package
# POST /picking-orders/<po_id>/boxes    -> 201 box
# POST /picking-orders/<po_id>/boxes/<box>/packages {package_id}  -> 200; order auto-finishes
# GET /picking-orders/<po_id>           -> order.status == "finished", items picked_qty 40
# GET /measuring-tasks?status=pending   -> exactly one task for this order
```
Expected: every annotation holds; in the temp sqlite: `measuring_tasks` has one row, `picking_orders.status='finished'`, one `transition_logs` row `picking -> finished`, and `receiving_invoice_items.available_qty = 60`.

- [ ] **Step 4: Update docs registry** — `docs/app-docs/ai/feature-registry.md` + `docs/app-docs/ai/code-map.md`: add the picking-execution endpoints (`POST scan`, `DELETE package`, `POST boxes`, `POST boxes/:id/cancel`, `POST boxes/:id/packages`, `POST boxes/:id/add-all-unboxed`, `DELETE boxes/:id/packages/:pkg`, `POST finish`, `GET /picking-orders`, `GET /picking-orders/:id`, `GET /measuring-tasks`) and files (`apps/api/src/db/pickScan.ts`, `routes/pickingExecution.ts`, `routes/measuring.ts`). Update `docs/app-docs/flows/picking/ai-scope.md` (new API entry points; picked_qty now maintained as boxed sum) and `docs/app-docs/flows/measuring/ai-scope.md` if it exists (task now created by the API auto-finish trigger). Follow each file's existing format.

- [ ] **Step 5: Commit docs**
```bash
git add docs/app-docs/ai/feature-registry.md docs/app-docs/ai/code-map.md docs/app-docs/flows
git commit -m "docs(api): register picking execution endpoints (Plan 4 task 8, NN/NN tests)"
```

---

## Self-review (run after drafting — already applied)

- **Spec coverage:** scan per allocation with over-pick guard (Tasks 2/3) ✓; undo scan (Tasks 3/6) ✓; box create/assign incl. existing-empty-box reuse via `POST boxes` + add (Tasks 4/5) ✓; all items picked+boxed → order finished + measuring task (Task 5) ✓; idempotent measuring task via `ON CONFLICT` (Task 5) ✓; transition logs on every state change (Tasks 2–6) ✓; picked_qty invariant maintained + guarded (Task 1) ✓; polling list endpoints with `updated_since` watermark (Task 7) ✓; receiving-order `clear` explicitly deferred to Plan 5 ✓.
- **Placeholder scan:** none — every step carries full code.
- **Type consistency:** `packageIds` (camel) returned by `scanAllocation` ↔ `package_ids` (snake) in `ScanResponse`; `{ ok: true }` bodies for action routes; `loadOrderForWrite`/`assertOrderWritable` reused by box + pack ops; `readJson` helper defined in Task 3 and reused in Task 5.
- **Invariants after every op:** scan — lot: `total` and `Σ allocations` both drop by qty (available unchanged); receiving: link portions and `picked_qty` move together (available unchanged); boxing — `picked + scanned + remaining` conserved via one recompute.
- **Open flags for the user:** (1) pending→picking flip on first scan is proposed, not mirrored from web code; (2) box ids are UUIDs, dropping the `BOX-HK1-*` scheme; (3) receiving-side candidate scan endpoints (`findReceivingCandidates`/`findPickingCandidates`) deferred to Plan 5.
