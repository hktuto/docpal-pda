# Put-away + Receiving Clear + Cycle-Count Verification (Plan 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the put-away flow to the Hono API (scan received pieces into a pool, assign them into shelf boxes on a shelf, materializing real inventory lots) so a receiving order can reach `status='clear'`; then add cycle-count verification — a next-day recount task auto-scheduled on any shelf-box stock change, which the worker clears by re-verifying each item in the box.

**Architecture:** Tx-scoped primitives in new `apps/api/src/db/putAway.ts` (sibling of `db/measure.ts` / `db/pickScan.ts`), reusing the Plan 1 invariant primitives (`recomputeReceivingItem`, `recomputeLot`). Cycle-count verification extends `completeVerificationTask` in `db/measure.ts` to handle `kind='cycle_count'`. Routes split: new `routes/putAway.ts` (put-away scans + shelf-box lifecycle + put-away reads), new `routes/goodsVerify.ts` (cycle-count shelf reads + verify-item), extend `routes/verification.ts` (`due_before` filter + cycle-count complete). Every mutating route opens `db.transaction` per request and does ownership pre-checks inside it, mirroring Plan 4/5.

**Tech Stack:** Hono 4, `drizzle-orm/better-sqlite3`, raw `sql` via `db.get/all/run` and `tx.get/all/run`, `node:test` + `tsx`, `crypto.randomUUID()`. No new dependencies.

**Governing docs:** `docs/superpowers/specs/2026-07-10-db-schema-rethink-design.md` (§10 task triggers, §13 state machines), `docs/superpowers/specs/2026-07-07-api-endpoints-design.md` (§6 put-away, §8 goods-verify, §12 internals), web references `apps/web/db/putAway.ts` (ported ~1:1) and `apps/web/db/goodsVerify.ts` (cycle-count read/verify shapes), scan-first spec `docs/superpowers/specs/2026-07-06-put-away-scan-first-design.md`.

---

## Conventions (read first)

- **Shell:** prefix **every** verification command with `cmd.exe //c` (plain `pnpm` is broken here):
  - Build: `cmd.exe //c "pnpm --filter @warehouse/api build"` — Tests: `cmd.exe //c "pnpm --filter @warehouse/api test"`. Do not edit `package.json`.
- **Commits:** commit directly to `master`, never push. Stage explicit paths only (`git add <paths>`, never `-A`); never stage the pre-existing stray files (`apps/web/public/labels-data.json` M, `tmp_screencap_*.png` D, `apps/web/public/box-shelf-labels.pdf`, `apps/web/scripts/generate-box-shelf-labels-pdf.mjs`, `apps/web/utils/scroll.ts`, `ui.xml`–`ui5.xml`).
- **NodeNext:** relative imports end in `.js`. **Timestamps:** `now()` from `db/now.ts` (returns ISO 8601). **IDs:** global `crypto.randomUUID()`. **Transitions:** `logTransition` from `ingest/transition.js` (`{ entityType, entityId, fromStatus?, toStatus?, actorId?, note? }`).
- **Generated columns (never write):** `picking_items.remaining_qty`, `inventory_lots.available_qty`. **Maintained columns** change only via `db/invariants.ts` primitives (`recomputeReceivingItem`, `recomputeLot`). Plan 6 writes `inventory_lots.total_qty` directly (it is NOT a maintained column — pickScan already writes it directly), and `receiving_invoice_items.put_away_qty` directly followed by `recomputeReceivingItem`.
- **Test backstop:** every state-changing test ends with `assertInvariantsHold(db)` from `db/invariants.guard.ts`. Isolated DBs via the `makeDb()` pattern from `db/measure.test.ts`.
- **Route tests** use the temp-`DATABASE_URL` + dynamic `await import("../index.js")` pattern from `routes/boxes.test.ts` (each test file is its own node process; set the env var BEFORE the import).
- All helpers throw `HTTPException` (400 validation / 404 missing / 409 state conflict).
- **`verified` is INTEGER 0/1** in sqlite; better-sqlite3 returns numbers.
- **Schema evolution:** add new columns to the `CREATE TABLE` DDL in `db/tables.ts` AND add an `ensureColumn(sqlite, table, column, decl)` call in `createTables` (idempotent for the existing `dev.sqlite`). Mirror the change in the drizzle schema under `db/schema/`.

---

## Scope boundaries (decided — do not re-open)

- **IN:** put-away (record scan, assign/add-all/remove scan, create/cancel/close shelf box) with real inventory-lot materialization; `tryMarkReceivingOrderClear` (receiving order `in_hand → clear`); cycle-count task auto-scheduling on any shelf-box stock change; cycle-count verification (verify-item + task completion); the put-away + goods-verify read endpoints; `due_before` filter on `GET /verification-tasks`.
- **OUT (Plan 7):** frontend adapter (point Nuxt at the API), seed port, scan-candidate matching endpoints (`findReceivingCandidates`/`findPickingCandidates`), stock-search endpoint. `shelf_box_items` table stays unused (we aggregate live from `put_away_scans`, matching the web).
- **DECIDED (cycle-count trigger — user-confirmed "all shelf stock changes"):** `scheduleCycleCount(tx, shelfBoxId)` is called from every operation that changes a shelf box's stock: `assignScanToBox`, `removeScanFromBox`, AND picking from a boxed lot (new hook in `db/pickScan.ts` — when the source `inventory_lot` has `box_id` set). It inserts `verification_tasks(kind='cycle_count', shelf_box_id, due_at=<next local 09:00>)` coalesced to one task per box per calendar day (the existing `verification_tasks_cycle_coalesce_uq` index on `(kind, shelf_box_id, date(due_at))` is the backstop). On inserting a NEW task it also resets that box's recount state: `put_away_scans.verified=0, verified_at=NULL`, and `shelf_boxes.status` `verified → closed` (stock changed ⇒ no longer verified).
- **DECIDED (lot materialization — user-confirmed):** `assignScanToBox` creates/increments an `inventory_lots` row at `(part_id, date_code, lot_code, coo, cow, shelf_code=box.shelf_code, box_id=box.id)` with null-safe attribute equality, and upserts `inventory_lot_sources(inventory_lot_id, receiving_invoice_item_id, qty)`. No lot unique index (NULL attribute columns make it unreliable in sqlite); the synchronous find-or-create is the guard.
- **DECIDED (due_at — user-confirmed "next local morning 09:00"):** computed as next local day 09:00, stored via `.toISOString()` (UTC). The coalesce index's `date(due_at)` then buckets by the UTC calendar date of that instant — acceptable for the demo; the exact timezone cutoff is a known cosmetic caveat.
- **DECIDED (scan-first):** put-away is two steps — `recordPutAwayScan` drops a piece into a per-item unboxed pool (no inventory change, reserves qty), `assignScanToBox` moves a whole scanned piece into a box (inventory moves at assignment, not scan). Matches the web and the scan-first spec.
- **DECIDED (receiving clear):** `tryMarkReceivingOrderClear` runs after assign/remove/close. It sets `receiving_orders.status='clear'` when the order is `in_hand` and EVERY invoice item has `received − picked − put_away − allocated − unboxed_scanned ≤ 0` (i.e. fully picked, allocated, put away, or reserved by an unboxed scan). Forward-only; no revert to `in_hand` from put-away.
- **DECIDED (cycle-count verify semantics):** per-item verify sets `put_away_scans.verified=1` for ALL scan rows of a part in the box (via the `receiving_invoice_items.part_id` join — API `put_away_scans` has no `part_id`). Completing a `cycle_count` task requires every `put_away_scans` row in the box verified, then flips `shelf_boxes.status → verified` and the task `→ completed` (merges the web's `markShelfBoxVerified` into task completion).
- **DECIDED (request bodies):** snake_case (`receiving_invoice_item_id`, `shelf_box_id`, `part_id`, `shelf_code`, `qty`, `actor_id`).
- **Actor:** endpoints accept optional `actor_id` (body for body-bearing POSTs, `?actor_id=` query for body-less POSTs) — same split as Plan 4/5.

---

## File structure

**Create**
- `apps/api/src/db/putAway.ts` — all put-away + shelf-box + cycle-count-trigger primitives (surface below).
- `apps/api/src/routes/putAway.ts` — `/put-away/*`, `/receiving-orders/:id/shelf-boxes`, `/shelf-boxes/:id/{close,add-all-unboxed}` + put-away reads.
- `apps/api/src/routes/goodsVerify.ts` — cycle-count shelf reads + `/shelf-boxes/:id/verify-item`.
- Tests: `apps/api/src/db/putAway.test.ts` (T2–T6), `apps/api/src/db/cycleCount.test.ts` (T6–T7), `apps/api/src/routes/putAway.test.ts` (T2–T5, T8), `apps/api/src/routes/goodsVerify.test.ts` (T7–T8).

**Modify**
- `apps/api/src/db/tables.ts` — `shelf_boxes` +`status`/+`receiving_order_id` (DDL + `ensureColumn`) (T1).
- `apps/api/src/db/schema/inventory.ts` — drizzle mirror of the two new `shelf_boxes` columns (T1).
- `apps/api/src/db/measure.ts` — extend `completeVerificationTask` for `cycle_count` (T7).
- `apps/api/src/db/pickScan.ts` — hook `scheduleCycleCount` on boxed-lot pick (T6).
- `apps/api/src/routes/verification.ts` — `due_before` filter (T7).
- `apps/api/src/index.ts` — mount `putAwayRoute`, `goodsVerifyRoute` (T2, T7).
- `packages/shared/src/index.ts` — request DTOs (T2–T5, T7).

**Function surface (locked)** — `db/putAway.ts`, all throw `HTTPException`, all run inside the caller's tx:
```ts
export function createShelfBox(tx: DbOrTx, a: { receivingOrderId: string; shelfCode: string; actorId?: string | null }): { id: string };
export function cancelShelfBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): void;
export function recordPutAwayScan(tx: DbOrTx, a: { receivingInvoiceItemId: string; qty: number; dateCode?: string | null; lotCode?: string | null; coo?: string | null; cow?: string | null }): { id: string };
export function removeScannedPiece(tx: DbOrTx, a: { scanId: string }): void;
export function assignScanToBox(tx: DbOrTx, a: { scanId: string; shelfBoxId: string; actorId?: string | null }): void;
export function addAllUnboxedToBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): { count: number };
export function removeScanFromBox(tx: DbOrTx, a: { scanId: string; actorId?: string | null }): void;
export function closeShelfBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): void;
export function verifyShelfBoxItem(tx: DbOrTx, a: { shelfBoxId: string; partId: string; actorId?: string | null }): void;
export function tryMarkReceivingOrderClear(tx: DbOrTx, a: { receivingOrderId: string; actorId?: string | null }): void;
export function scheduleCycleCount(tx: DbOrTx, shelfBoxId: string): void;
```

**Route surface (locked)**
```
POST   /receiving-orders/:id/shelf-boxes        (T2)
DELETE /shelf-boxes/:id                          (T2)
POST   /put-away/scans                           (T3)
POST   /put-away/scans/:id/remove-piece          (T3)
POST   /put-away/scans/:id/assign-to-box         (T4)
POST   /shelf-boxes/:id/add-all-unboxed          (T4)
POST   /put-away/scans/:id/remove-from-box       (T5)
POST   /shelf-boxes/:id/close                    (T5)
POST   /shelf-boxes/:id/verify-item              (T7)
GET    /verification-tasks?...&due_before=       (T7, extend)
POST   /verification-tasks/:id/complete          (T7, extend for cycle_count)
GET    /put-away/candidates                      (T8)
GET    /receiving-orders/:id/put-away-lots       (T8)
GET    /receiving-orders/:id/put-away-scans      (T8)
GET    /receiving-orders/:id/shelf-boxes         (T8)
GET    /shelves                                  (T8)
GET    /shelves/with-box-counts                  (T8)
GET    /shelves/:code/boxes                      (T8)
GET    /shelf-boxes/:id                          (T8)
```

---

### Task 1: Schema evolution — `shelf_boxes` gains `status` + `receiving_order_id`

**Files:**
- Modify: `apps/api/src/db/tables.ts` (DDL + `ensureColumn`)
- Modify: `apps/api/src/db/schema/inventory.ts` (drizzle mirror)
- Test: `apps/api/src/db/schemaEvolution.test.ts` (new)

- [ ] **Step 1: Write the failing test** `apps/api/src/db/schemaEvolution.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "./client.js";
import { createTables } from "./tables.js";

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  return createDb(path.join(dir, "t.sqlite")).sqlite;
}
function shelfBoxCols(sqlite: any): string[] {
  return (sqlite.prepare("PRAGMA table_info(shelf_boxes)").all() as any[]).map((c) => c.name);
}

test("createTables gives fresh + stale DBs the new shelf_boxes columns", () => {
  // fresh DB: columns come straight from the DDL
  const a = freshDb();
  createTables(a);
  const colsA = shelfBoxCols(a);
  assert.ok(colsA.includes("status") && colsA.includes("receiving_order_id"));
  a.close();

  // stale DB: pre-create the OLD shelf_boxes shape + a row, then createTables must upgrade it
  const b = freshDb();
  b.exec(`CREATE TABLE shelf_boxes (id TEXT PRIMARY KEY, shelf_code TEXT NOT NULL, box_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
          INSERT INTO shelf_boxes (id, shelf_code, created_at, updated_at) VALUES ('b1','S1','0','0');`);
  createTables(b);
  const colsB = shelfBoxCols(b);
  assert.ok(colsB.includes("status") && colsB.includes("receiving_order_id"));
  // existing rows backfill status='open'
  assert.equal((b.prepare("SELECT status FROM shelf_boxes WHERE id='b1'").get() as any).status, "open");
  b.close();
});
```

- [ ] **Step 2: Run test to verify it fails** (columns not present).

- [ ] **Step 3: Update the DDL in `apps/api/src/db/tables.ts`.** Replace the `shelf_boxes` `CREATE TABLE` (currently `id, shelf_code, box_id, created_at, updated_at`) with:

```sql
CREATE TABLE IF NOT EXISTS shelf_boxes (
  id TEXT PRIMARY KEY, shelf_code TEXT NOT NULL, box_id TEXT,
  receiving_order_id TEXT REFERENCES receiving_orders(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','verified')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS shelf_boxes_shelf_idx ON shelf_boxes(shelf_code);
CREATE INDEX IF NOT EXISTS shelf_boxes_status_idx ON shelf_boxes(status);
CREATE INDEX IF NOT EXISTS shelf_boxes_receiving_order_idx ON shelf_boxes(receiving_order_id);
```

- [ ] **Step 4: Add the `ensureColumn` calls** in `createTables` (alongside the existing two, before `sqlite.exec(createTablesSql)`):

```ts
ensureColumn(sqlite, "shelf_boxes", "receiving_order_id", "receiving_order_id TEXT REFERENCES receiving_orders(id)");
ensureColumn(sqlite, "shelf_boxes", "status", "status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','verified'))");
```

- [ ] **Step 5: Mirror the drizzle schema** in `apps/api/src/db/schema/inventory.ts`. Add `import { receivingOrders } from "./receiving.js";` (confirm the export name in that file), extend `shelfBoxes`:

```ts
export const shelfBoxes = sqliteTable(
  "shelf_boxes",
  {
    id: text("id").primaryKey(),
    shelfCode: text("shelf_code").notNull(),
    boxId: text("box_id"),
    receivingOrderId: text("receiving_order_id").references(() => receivingOrders.id),
    status: text("status", { enum: ["open", "closed", "verified"] }).notNull().default("open"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => ({
    shelfIdx: index("shelf_boxes_shelf_idx").on(t.shelfCode),
    statusIdx: index("shelf_boxes_status_idx").on(t.status),
    receivingOrderIdx: index("shelf_boxes_receiving_order_idx").on(t.receivingOrderId),
  })
);
```

- [ ] **Step 6: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/tables.ts apps/api/src/db/schema/inventory.ts apps/api/src/db/schemaEvolution.test.ts
git commit -m "feat(api): shelf_boxes status + receiving_order_id columns (Plan 6 task 1)"
```

---

### Task 2: Create + cancel a shelf box (`createShelfBox`, `cancelShelfBox`)

**Files:**
- Create: `apps/api/src/db/putAway.ts`
- Create: `apps/api/src/routes/putAway.ts`
- Modify: `apps/api/src/index.ts` (mount `putAwayRoute`)
- Modify: `packages/shared/src/index.ts` (add `CreateShelfBoxRequest`)
- Test: `apps/api/src/db/putAway.test.ts` (new) + `apps/api/src/routes/putAway.test.ts` (new)

- [ ] **Step 1: Write the failing test** `apps/api/src/db/putAway.test.ts`

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
import { createShelfBox, cancelShelfBox } from "./putAway.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','e','RO-1','in_hand','sup','0','0');
    INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
  `);
  return { sqlite, db };
}

test("createShelfBox creates an open box scoped to the order + shelf; cancelShelfBox deletes an empty open box", () => {
  const { sqlite, db } = makeDb();
  const { id } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1", actorId: "u1" }));
  assert.match(id, /^SBOX-\d{4}$/);
  const box = sqlite.prepare("SELECT receiving_order_id, shelf_code, status FROM shelf_boxes WHERE id=?").get(id) as any;
  assert.deepEqual(box, { receiving_order_id: "ro", shelf_code: "A1", status: "open" });
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shelf_box' AND to_status='open'").get() as any).c, 1);

  db.transaction((tx) => cancelShelfBox(tx, { shelfBoxId: id, actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM shelf_boxes WHERE id=?").get(id) as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("create/cancel guards: 404 order, 404 shelf, 409 cancel non-empty", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "nope", shelfCode: "A1" })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "ZZ" })), (e: any) => e.status === 404);
  const { id } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  sqlite.prepare("UPDATE shelf_boxes SET status='closed' WHERE id=?").run(id);
  assert.throws(() => db.transaction((tx) => cancelShelfBox(tx, { shelfBoxId: id })), (e: any) => e.status === 409); // not open
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails** (`Cannot find module './putAway.js'`).

- [ ] **Step 3: Implement `apps/api/src/db/putAway.ts`** (start the file; later tasks append)

```ts
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbOrTx, recomputeReceivingItem, recomputeLot } from "./invariants.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

interface ShelfBoxRow { id: string; receivingOrderId: string | null; shelfCode: string; status: string }

function loadShelfBox(tx: DbOrTx, boxId: string): ShelfBoxRow {
  const box = tx.get<ShelfBoxRow>(
    sql`SELECT id, receiving_order_id AS receivingOrderId, shelf_code AS shelfCode, status FROM shelf_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shelf box not found" });
  return box;
}

function nextShelfBoxId(tx: DbOrTx): string {
  const rows = tx.all<{ id: string }>(sql`SELECT id FROM shelf_boxes WHERE id LIKE 'SBOX-%'`);
  let max = 0;
  for (const r of rows) { const n = Number(r.id.slice(5)); if (Number.isInteger(n) && n > max) max = n; }
  return `SBOX-${String(max + 1).padStart(4, "0")}`;
}

export function createShelfBox(tx: DbOrTx, a: { receivingOrderId: string; shelfCode: string; actorId?: string | null }): { id: string } {
  const order = tx.get<{ id: string }>(sql`SELECT id FROM receiving_orders WHERE id = ${a.receivingOrderId}`);
  if (!order) throw new HTTPException(404, { message: "receiving order not found" });
  const shelf = tx.get<{ code: string }>(sql`SELECT code FROM shelves WHERE code = ${a.shelfCode}`);
  if (!shelf) throw new HTTPException(404, { message: "shelf not found" });
  const id = nextShelfBoxId(tx);
  tx.run(
    sql`INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at, updated_at)
        VALUES (${id}, ${a.receivingOrderId}, ${a.shelfCode}, 'open', ${now()}, ${now()})`
  );
  logTransition(tx, { entityType: "shelf_box", entityId: id, toStatus: "open", actorId: a.actorId ?? null, note: `order=${a.receivingOrderId} shelf=${a.shelfCode}` });
  return { id };
}

export function cancelShelfBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): void {
  const box = loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const cnt = tx.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM put_away_scans WHERE shelf_box_id = ${box.id}`)!.c;
  if (cnt > 0) throw new HTTPException(409, { message: "shelf box is not empty" });
  logTransition(tx, { entityType: "shelf_box", entityId: box.id, fromStatus: "open", toStatus: "cancelled", actorId: a.actorId ?? null });
  tx.run(sql`DELETE FROM shelf_boxes WHERE id = ${box.id}`);
}
```

(The `recomputeReceivingItem` / `recomputeLot` imports are used by later tasks; if tsc flags them unused in THIS task, omit them for now — later tasks re-add. Check whether `apps/api/tsconfig.json` tolerates unused imports first.)

- [ ] **Step 4: Add `CreateShelfBoxRequest` to `packages/shared/src/index.ts`**
```ts
export interface CreateShelfBoxRequest { shelf_code: string; actor_id?: string | null; }
```

- [ ] **Step 5: Create `apps/api/src/routes/putAway.ts`** (create + delete only; later tasks append) and mount in `index.ts`

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { CreateShelfBoxRequest } from "@warehouse/shared";
import { db } from "../db.js";
import { createShelfBox, cancelShelfBox } from "../db/putAway.js";

export const putAwayRoute = new Hono();

async function readJson<T>(c: Context): Promise<T> {
  try { return await c.req.json<T>(); } catch { throw new HTTPException(400, { message: "invalid JSON body" }); }
}

putAwayRoute.post("/receiving-orders/:id/shelf-boxes", async (c) => {
  const receivingOrderId = c.req.param("id");
  const body = await readJson<CreateShelfBoxRequest>(c);
  if (!body.shelf_code) throw new HTTPException(400, { message: "shelf_code is required" });
  const result = db.transaction((tx) => createShelfBox(tx, { receivingOrderId, shelfCode: body.shelf_code, actorId: body.actor_id ?? null }));
  return c.json(result, 201);
});

putAwayRoute.delete("/shelf-boxes/:id", (c) => {
  const shelfBoxId = c.req.param("id");
  db.transaction((tx) => cancelShelfBox(tx, { shelfBoxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});
```

```ts
// apps/api/src/index.ts additions
import { putAwayRoute } from "./routes/putAway.js";
app.route("/", putAwayRoute);
```

- [ ] **Step 6: Write the failing route test** `apps/api/src/routes/putAway.test.ts`, run, watch fail, then re-run after steps 3–5

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

sqlite.exec(`
  INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
  INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','e','RO-1','in_hand','sup','0','0');
  INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
`);

test("POST /receiving-orders/:id/shelf-boxes creates; DELETE /shelf-boxes/:id cancels; 404 missing shelf", async () => {
  const created = await app.request("/receiving-orders/ro/shelf-boxes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_code: "A1" }),
  });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as any;
  const del = await app.request(`/shelf-boxes/${id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const bad = await app.request("/receiving-orders/ro/shelf-boxes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_code: "ZZ" }),
  });
  assert.equal(bad.status, 404);
});

test("cleanup", () => { sqlite.close(); });
```

- [ ] **Step 7: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/putAway.ts apps/api/src/db/putAway.test.ts apps/api/src/routes/putAway.ts apps/api/src/routes/putAway.test.ts apps/api/src/index.ts packages/shared/src/index.ts
git commit -m "feat(api): create + cancel shelf box (Plan 6 task 2)"
```

---

### Task 3: Record + remove a put-away scan (`recordPutAwayScan`, `removeScannedPiece`)

**Files:**
- Modify: `apps/api/src/db/putAway.ts` (add `recordPutAwayScan`, `removeScannedPiece`)
- Modify: `apps/api/src/routes/putAway.ts` (add routes)
- Modify: `packages/shared/src/index.ts` (add `RecordPutAwayScanRequest`)
- Test: append to `apps/api/src/db/putAway.test.ts` + `apps/api/src/routes/putAway.test.ts`

- [ ] **Step 1: Append failing tests** to `apps/api/src/db/putAway.test.ts`

```ts
// seed a part + invoice + receivable item (received 10) — call after makeDb
function seedReceivableItem(sqlite: any) {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
      VALUES ('inv','e','ro','INV-1','sup','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, created_at, updated_at)
      VALUES ('rii','inv','p',10,10,'0','0');
  `);
}

test("recordPutAwayScan drops an unboxed scan; over-scan 409; removeScannedPiece deletes unboxed", () => {
  const { sqlite, db } = makeDb();
  seedReceivableItem(sqlite);
  const { id } = db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 4, dateCode: "D1" }));
  const row = sqlite.prepare("SELECT receiving_invoice_item_id, qty, shelf_box_id, date_code FROM put_away_scans WHERE id=?").get(id) as any;
  assert.deepEqual(row, { receiving_invoice_item_id: "rii", qty: 4, shelf_box_id: null, date_code: "D1" });
  // 4 scanned + another 7 would exceed remaining 10
  assert.throws(() => db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 7 })), (e: any) => e.status === 409);
  db.transaction((tx) => removeScannedPiece(tx, { scanId: id }));
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM put_away_scans WHERE id=?").get(id) as any).c, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("record/remove guards: 404 item, 400 bad qty, 404 scan, 409 remove boxed", () => {
  const { sqlite, db } = makeDb();
  seedReceivableItem(sqlite);
  assert.throws(() => db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "nope", qty: 1 })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 0 })), (e: any) => e.status === 400);
  assert.throws(() => db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1.5 })), (e: any) => e.status === 400);
  assert.throws(() => db.transaction((tx) => removeScannedPiece(tx, { scanId: "nope" })), (e: any) => e.status === 404);
  const { id } = db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1 }));
  sqlite.prepare("UPDATE put_away_scans SET shelf_box_id='somebox' WHERE id=?").run(id);
  assert.throws(() => db.transaction((tx) => removeScannedPiece(tx, { scanId: id })), (e: any) => e.status === 409); // boxed
  sqlite.close();
});
```

(`recordPutAwayScan`, `removeScannedPiece` must be added to the `./putAway.js` import.)

- [ ] **Step 2: Run tests to verify they fail** (not exported).

- [ ] **Step 3: Implement** in `apps/api/src/db/putAway.ts` (append)

```ts
export function recordPutAwayScan(
  tx: DbOrTx,
  a: { receivingInvoiceItemId: string; qty: number; dateCode?: string | null; lotCode?: string | null; coo?: string | null; cow?: string | null }
): { id: string } {
  const item = tx.get<{ id: string; received: number; picked: number; putAway: number; allocated: number }>(
    sql`SELECT id, received_qty AS received, picked_qty AS picked, put_away_qty AS putAway, allocated_qty AS allocated
        FROM receiving_invoice_items WHERE id = ${a.receivingInvoiceItemId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving invoice item not found" });
  if (!Number.isInteger(a.qty) || a.qty <= 0) throw new HTTPException(400, { message: "qty must be a positive integer" });
  const unboxed = tx.get<{ s: number }>(
    sql`SELECT COALESCE(SUM(qty), 0) AS s FROM put_away_scans WHERE receiving_invoice_item_id = ${item.id} AND shelf_box_id IS NULL`
  )!.s;
  const remaining = item.received - item.picked - item.putAway - item.allocated - unboxed;
  if (a.qty > remaining) throw new HTTPException(409, { message: "scanned qty exceeds remaining" });
  const id = crypto.randomUUID();
  tx.run(
    sql`INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, date_code, lot_code, coo, cow, created_at, updated_at)
        VALUES (${id}, ${item.id}, ${a.qty}, NULL, ${a.dateCode ?? null}, ${a.lotCode ?? null}, ${a.coo ?? null}, ${a.cow ?? null}, ${now()}, ${now()})`
  );
  return { id };
}

export function removeScannedPiece(tx: DbOrTx, a: { scanId: string }): void {
  const scan = tx.get<{ id: string; shelfBoxId: string | null }>(
    sql`SELECT id, shelf_box_id AS shelfBoxId FROM put_away_scans WHERE id = ${a.scanId}`
  );
  if (!scan) throw new HTTPException(404, { message: "put-away scan not found" });
  if (scan.shelfBoxId !== null) throw new HTTPException(409, { message: "scan is already in a box" });
  tx.run(sql`DELETE FROM put_away_scans WHERE id = ${scan.id}`);
}
```

- [ ] **Step 4: Add `RecordPutAwayScanRequest` to `packages/shared/src/index.ts`**
```ts
export interface RecordPutAwayScanRequest { receiving_invoice_item_id: string; qty: number; date_code?: string | null; lot_code?: string | null; coo?: string | null; cow?: string | null; }
```

- [ ] **Step 5: Add the routes** to `apps/api/src/routes/putAway.ts` (append)

```ts
putAwayRoute.post("/put-away/scans", async (c) => {
  const body = await readJson<RecordPutAwayScanRequest>(c);
  if (!body.receiving_invoice_item_id) throw new HTTPException(400, { message: "receiving_invoice_item_id is required" });
  const result = db.transaction((tx) => recordPutAwayScan(tx, {
    receivingInvoiceItemId: body.receiving_invoice_item_id, qty: body.qty,
    dateCode: body.date_code ?? null, lotCode: body.lot_code ?? null, coo: body.coo ?? null, cow: body.cow ?? null,
  }));
  return c.json(result, 201);
});

putAwayRoute.post("/put-away/scans/:id/remove-piece", (c) => {
  const scanId = c.req.param("id");
  db.transaction((tx) => removeScannedPiece(tx, { scanId }));
  return c.json({ ok: true }, 200);
});
```

- [ ] **Step 6: Append route test** to `apps/api/src/routes/putAway.test.ts` (before `cleanup`)

```ts
test("POST /put-away/scans records; remove-piece deletes; over-scan 409", async () => {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at)
      VALUES ('inv','e','ro','INV-1','sup','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, created_at, updated_at)
      VALUES ('rii','inv','p',10,10,'0','0');
  `);
  const created = await app.request("/put-away/scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_invoice_item_id: "rii", qty: 4 }),
  });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as any;
  const over = await app.request("/put-away/scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_invoice_item_id: "rii", qty: 7 }),
  });
  assert.equal(over.status, 409);
  const del = await app.request(`/put-away/scans/${id}/remove-piece`, { method: "POST" });
  assert.equal(del.status, 200);
});
```

- [ ] **Step 7: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/putAway.ts apps/api/src/db/putAway.test.ts apps/api/src/routes/putAway.ts apps/api/src/routes/putAway.test.ts packages/shared/src/index.ts
git commit -m "feat(api): record + remove put-away scan (Plan 6 task 3)"
```

---

### Task 4: Assign scan to box (`assignScanToBox` + `addAllUnboxedToBox` + `scheduleCycleCount` + `tryMarkReceivingOrderClear`)

This is the core put-away write: moving a scanned piece into a box materializes a real inventory lot, reduces receiving-item availability, schedules a cycle-count recount, and may clear the receiving order.

**Files:**
- Modify: `apps/api/src/db/putAway.ts` (add the four functions)
- Modify: `apps/api/src/routes/putAway.ts` (add routes)
- Modify: `packages/shared/src/index.ts` (add `AssignScanToBoxRequest`)
- Test: append to `apps/api/src/db/putAway.test.ts` + `apps/api/src/routes/putAway.test.ts`

- [ ] **Step 1: Append failing tests** to `apps/api/src/db/putAway.test.ts`

```ts
test("assignScanToBox boxes the scan, materializes the lot, reduces availability, schedules recount, clears order", () => {
  const { sqlite, db } = makeDb();
  seedReceivableItem(sqlite); // item rii received 10
  const { id: scanId } = db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 10, dateCode: "D1", lotCode: "L1" }));
  const { id: boxId } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  db.transaction((tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId, actorId: "u1" }));

  assert.equal((sqlite.prepare("SELECT shelf_box_id FROM put_away_scans WHERE id=?").get(scanId) as any).shelf_box_id, boxId);
  const lot = sqlite.prepare("SELECT part_id, shelf_code, box_id, total_qty, date_code, lot_code FROM inventory_lots WHERE box_id=?").get(boxId) as any;
  assert.deepEqual(lot, { part_id: "p", shelf_code: "A1", box_id: boxId, total_qty: 10, date_code: "D1", lot_code: "L1" });
  assert.equal((sqlite.prepare("SELECT qty FROM inventory_lot_sources WHERE receiving_invoice_item_id='rii'").get() as any).qty, 10);
  const rii = sqlite.prepare("SELECT put_away_qty, available_qty FROM receiving_invoice_items WHERE id='rii'").get() as any;
  assert.deepEqual(rii, { put_away_qty: 10, available_qty: 0 });
  assert.equal((sqlite.prepare("SELECT status FROM receiving_orders WHERE id='ro'").get() as any).status, "clear");
  const vt = sqlite.prepare("SELECT kind, status, shelf_box_id FROM verification_tasks WHERE shelf_box_id=?").get(boxId) as any;
  assert.deepEqual(vt, { kind: "cycle_count", status: "pending", shelf_box_id: boxId });
  assertInvariantsHold(db);
  sqlite.close();
});

test("assignScanToBox guards: 404 scan, 409 already boxed, 409 box not open, 409 different order", () => {
  const { sqlite, db } = makeDb();
  seedReceivableItem(sqlite);
  const { id: boxId } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  assert.throws(() => db.transaction((tx) => assignScanToBox(tx, { scanId: "nope", shelfBoxId: boxId })), (e: any) => e.status === 404);
  const { id: scanId } = db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1 }));
  sqlite.prepare("UPDATE put_away_scans SET shelf_box_id='other' WHERE id=?").run(scanId);
  assert.throws(() => db.transaction((tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId })), (e: any) => e.status === 409); // already boxed
  sqlite.prepare("UPDATE put_away_scans SET shelf_box_id=NULL WHERE id=?").run(scanId);
  sqlite.prepare("UPDATE shelf_boxes SET status='closed' WHERE id=?").run(boxId);
  assert.throws(() => db.transaction((tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId })), (e: any) => e.status === 409); // not open
  sqlite.close();
});

test("addAllUnboxedToBox boxes every unboxed scan of the box's order", () => {
  const { sqlite, db } = makeDb();
  seedReceivableItem(sqlite);
  db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 4 }));
  db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 6 }));
  const { id: boxId } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  const { count } = db.transaction((tx) => addAllUnboxedToBox(tx, { shelfBoxId: boxId, actorId: "u1" }));
  assert.equal(count, 2);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM put_away_scans WHERE shelf_box_id IS NULL").get() as any).c, 0);
  assert.equal((sqlite.prepare("SELECT status FROM receiving_orders WHERE id='ro'").get() as any).status, "clear");
  assertInvariantsHold(db);
  sqlite.close();
});
```

(`assignScanToBox`, `addAllUnboxedToBox`, `scheduleCycleCount`, `tryMarkReceivingOrderClear` must be added to the `./putAway.js` import as used.)

- [ ] **Step 2: Run tests to verify they fail** (not exported).

- [ ] **Step 3: Implement** in `apps/api/src/db/putAway.ts` (append)

```ts
/** Next local day 09:00 as an ISO (UTC) string. Coalesced per box per UTC calendar day. */
function nextMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/** spec §10: any shelf-box stock change schedules a next-day recount, coalesced per box per day. */
export function scheduleCycleCount(tx: DbOrTx, shelfBoxId: string): void {
  const dueAt = nextMorning();
  const existing = tx.get<{ id: string }>(
    sql`SELECT id FROM verification_tasks WHERE kind = 'cycle_count' AND shelf_box_id = ${shelfBoxId} AND date(due_at) = date(${dueAt})`
  );
  if (existing) return; // one task per box per day
  tx.run(
    sql`INSERT INTO verification_tasks (id, kind, status, due_at, shelf_box_id, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, 'cycle_count', 'pending', ${dueAt}, ${shelfBoxId}, ${now()}, ${now()})`
  );
  // stock changed => the box needs re-verification
  tx.run(sql`UPDATE put_away_scans SET verified = 0, verified_at = NULL, updated_at = ${now()} WHERE shelf_box_id = ${shelfBoxId}`);
  tx.run(sql`UPDATE shelf_boxes SET status = 'closed', updated_at = ${now()} WHERE id = ${shelfBoxId} AND status = 'verified'`);
}

/** spec §10/§15: receiving order in_hand -> clear once every invoice item is fully picked/allocated/put-away/scanned. */
export function tryMarkReceivingOrderClear(tx: DbOrTx, a: { receivingOrderId: string; actorId?: string | null }): void {
  const order = tx.get<{ id: string; status: string }>(sql`SELECT id, status FROM receiving_orders WHERE id = ${a.receivingOrderId}`);
  if (!order || order.status !== "in_hand") return;
  const items = tx.all<{ id: string; received: number; picked: number; putAway: number; allocated: number }>(
    sql`SELECT rii.id, rii.received_qty AS received, rii.picked_qty AS picked, rii.put_away_qty AS putAway, rii.allocated_qty AS allocated
        FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE ri.receiving_order_id = ${order.id}`
  );
  if (items.length === 0) return;
  for (const it of items) {
    const unboxed = tx.get<{ s: number }>(
      sql`SELECT COALESCE(SUM(qty), 0) AS s FROM put_away_scans WHERE receiving_invoice_item_id = ${it.id} AND shelf_box_id IS NULL`
    )!.s;
    if (it.received - it.picked - it.putAway - it.allocated - unboxed > 0) return; // something still left
  }
  tx.run(sql`UPDATE receiving_orders SET status = 'clear', updated_at = ${now()} WHERE id = ${order.id}`);
  logTransition(tx, { entityType: "receiving_order", entityId: order.id, fromStatus: "in_hand", toStatus: "clear", actorId: a.actorId ?? null });
}

export function assignScanToBox(tx: DbOrTx, a: { scanId: string; shelfBoxId: string; actorId?: string | null }): void {
  const scan = tx.get<{ id: string; itemId: string; qty: number; shelfBoxId: string | null; dateCode: string | null; lotCode: string | null; coo: string | null; cow: string | null }>(
    sql`SELECT id, receiving_invoice_item_id AS itemId, qty, shelf_box_id AS shelfBoxId,
               date_code AS dateCode, lot_code AS lotCode, coo AS coo, cow AS cow
        FROM put_away_scans WHERE id = ${a.scanId}`
  );
  if (!scan) throw new HTTPException(404, { message: "put-away scan not found" });
  if (scan.shelfBoxId !== null) throw new HTTPException(409, { message: "scan is already in a box" });
  const box = loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const item = tx.get<{ partId: string; receivingOrderId: string }>(
    sql`SELECT rii.part_id AS partId, ri.receiving_order_id AS receivingOrderId
        FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE rii.id = ${scan.itemId}`
  );
  if (!item) throw new HTTPException(404, { message: "receiving invoice item not found" });
  if (box.receivingOrderId !== item.receivingOrderId) throw new HTTPException(409, { message: "scan and box belong to different receiving orders" });

  tx.run(sql`UPDATE put_away_scans SET shelf_box_id = ${box.id}, updated_at = ${now()} WHERE id = ${scan.id}`);

  // materialize / increment the inventory lot at (part, date, lot, coo, cow, shelf, box) — null-safe attribute match via IS
  const lot = tx.get<{ id: string }>(
    sql`SELECT id FROM inventory_lots
        WHERE part_id = ${item.partId} AND shelf_code = ${box.shelfCode} AND box_id = ${box.id}
          AND date_code IS ${scan.dateCode} AND lot_code IS ${scan.lotCode} AND coo IS ${scan.coo} AND cow IS ${scan.cow}`
  );
  let lotId: string;
  if (lot) {
    lotId = lot.id;
    tx.run(sql`UPDATE inventory_lots SET total_qty = total_qty + ${scan.qty}, updated_at = ${now()} WHERE id = ${lotId}`);
  } else {
    lotId = crypto.randomUUID();
    tx.run(
      sql`INSERT INTO inventory_lots (id, part_id, date_code, lot_code, coo, cow, shelf_code, box_id, total_qty, allocated_qty, created_at, updated_at)
          VALUES (${lotId}, ${item.partId}, ${scan.dateCode}, ${scan.lotCode}, ${scan.coo}, ${scan.cow}, ${box.shelfCode}, ${box.id}, ${scan.qty}, 0, ${now()}, ${now()})`
    );
  }

  const src = tx.get<{ id: string }>(
    sql`SELECT id FROM inventory_lot_sources WHERE inventory_lot_id = ${lotId} AND receiving_invoice_item_id = ${scan.itemId}`
  );
  if (src) tx.run(sql`UPDATE inventory_lot_sources SET qty = qty + ${scan.qty}, updated_at = ${now()} WHERE id = ${src.id}`);
  else tx.run(
    sql`INSERT INTO inventory_lot_sources (id, inventory_lot_id, receiving_invoice_item_id, qty, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${lotId}, ${scan.itemId}, ${scan.qty}, ${now()}, ${now()})`
  );

  tx.run(sql`UPDATE receiving_invoice_items SET put_away_qty = put_away_qty + ${scan.qty}, updated_at = ${now()} WHERE id = ${scan.itemId}`);
  recomputeReceivingItem(tx, scan.itemId);

  scheduleCycleCount(tx, box.id);
  tryMarkReceivingOrderClear(tx, { receivingOrderId: item.receivingOrderId, actorId: a.actorId ?? null });
}

export function addAllUnboxedToBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): { count: number } {
  const box = loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const scans = tx.all<{ id: string }>(
    sql`SELECT pas.id FROM put_away_scans pas
        JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
        JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
        WHERE pas.shelf_box_id IS NULL AND ri.receiving_order_id = ${box.receivingOrderId}
        ORDER BY pas.created_at ASC`
  );
  for (const s of scans) assignScanToBox(tx, { scanId: s.id, shelfBoxId: box.id, actorId: a.actorId ?? null });
  return { count: scans.length };
}
```

- [ ] **Step 4: Add `AssignScanToBoxRequest` to `packages/shared/src/index.ts`**
```ts
export interface AssignScanToBoxRequest { shelf_box_id: string; actor_id?: string | null; }
```

- [ ] **Step 5: Add the routes** to `apps/api/src/routes/putAway.ts` (append)

```ts
putAwayRoute.post("/put-away/scans/:id/assign-to-box", async (c) => {
  const scanId = c.req.param("id");
  const body = await readJson<AssignScanToBoxRequest>(c);
  if (!body.shelf_box_id) throw new HTTPException(400, { message: "shelf_box_id is required" });
  db.transaction((tx) => assignScanToBox(tx, { scanId, shelfBoxId: body.shelf_box_id, actorId: body.actor_id ?? null }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.post("/shelf-boxes/:id/add-all-unboxed", (c) => {
  const shelfBoxId = c.req.param("id");
  const result = db.transaction((tx) => addAllUnboxedToBox(tx, { shelfBoxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json(result, 200);
});
```

- [ ] **Step 6: Append route test** to `apps/api/src/routes/putAway.test.ts` (before `cleanup`)

```ts
test("POST assign-to-box materializes lot + clears order; add-all-unboxed boxes the rest", async () => {
  // reuses 'ro'/'inv'/'rii' from the earlier scan test in this file; ensure a fresh item to avoid cross-test qty coupling
  sqlite.exec(`
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, created_at, updated_at)
      VALUES ('rii2','inv','p',5,5,'0','0');
  `);
  const boxRes = await app.request("/receiving-orders/ro/shelf-boxes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_code: "A1" }),
  });
  const boxId = ((await boxRes.json()) as any).id;
  const scanRes = await app.request("/put-away/scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_invoice_item_id: "rii2", qty: 5 }),
  });
  const scanId = ((await scanRes.json()) as any).id;
  const assign = await app.request(`/put-away/scans/${scanId}/assign-to-box`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_box_id: boxId }),
  });
  assert.equal(assign.status, 200);
  assert.equal((sqlite.prepare("SELECT total_qty FROM inventory_lots WHERE box_id=?").get(boxId) as any).total_qty, 5);

  const addAll = await app.request(`/shelf-boxes/${boxId}/add-all-unboxed`, { method: "POST" });
  assert.equal(addAll.status, 200);
});
```
NOTE: this route test relies on `ro`/`inv` from the earlier route tests in the same file (sequential, shared sqlite). Confirm those run first; if coupling is a problem, seed fresh ids. Report the choice.

- [ ] **Step 7: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/putAway.ts apps/api/src/db/putAway.test.ts apps/api/src/routes/putAway.ts apps/api/src/routes/putAway.test.ts packages/shared/src/index.ts
git commit -m "feat(api): assign put-away scan to box + lot materialization + receiving clear (Plan 6 task 4)"
```

---

### Task 5: Remove scan from box + close box (`removeScanFromBox`, `closeShelfBox`)

**Files:**
- Modify: `apps/api/src/db/putAway.ts` (add both)
- Modify: `apps/api/src/routes/putAway.ts` (add routes)
- Test: append to `apps/api/src/db/putAway.test.ts` + `apps/api/src/routes/putAway.test.ts`

- [ ] **Step 1: Append failing tests** to `apps/api/src/db/putAway.test.ts`

```ts
test("removeScanFromBox reverses the assignment (scan unboxed, lot + source removed, availability restored)", () => {
  const { sqlite, db } = makeDb();
  seedReceivableItem(sqlite);
  const { id: scanId } = db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 10 }));
  const { id: boxId } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  db.transaction((tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId }));
  db.transaction((tx) => removeScanFromBox(tx, { scanId, actorId: "u1" }));

  assert.equal((sqlite.prepare("SELECT shelf_box_id FROM put_away_scans WHERE id=?").get(scanId) as any).shelf_box_id, null);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM inventory_lots WHERE box_id=?").get(boxId) as any).c, 0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM inventory_lot_sources WHERE receiving_invoice_item_id='rii'").get() as any).c, 0);
  const rii = sqlite.prepare("SELECT put_away_qty, available_qty FROM receiving_invoice_items WHERE id='rii'").get() as any;
  assert.deepEqual(rii, { put_away_qty: 0, available_qty: 10 });
  assertInvariantsHold(db);
  sqlite.close();
});

test("remove/close guards: 404 scan, 409 not in box, 409 box not open; close 409 empty + not open", () => {
  const { sqlite, db } = makeDb();
  seedReceivableItem(sqlite);
  const { id: scanId } = db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 1 }));
  assert.throws(() => db.transaction((tx) => removeScanFromBox(tx, { scanId: "nope" })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => removeScanFromBox(tx, { scanId })), (e: any) => e.status === 409); // not in a box
  const { id: boxId } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  db.transaction((tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId }));
  sqlite.prepare("UPDATE shelf_boxes SET status='closed' WHERE id=?").run(boxId);
  assert.throws(() => db.transaction((tx) => removeScanFromBox(tx, { scanId })), (e: any) => e.status === 409); // box not open
  // close: empty box 409
  const { id: empty } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  assert.throws(() => db.transaction((tx) => closeShelfBox(tx, { shelfBoxId: empty })), (e: any) => e.status === 409);
  // close: not open 409 (boxId already closed)
  assert.throws(() => db.transaction((tx) => closeShelfBox(tx, { shelfBoxId: boxId })), (e: any) => e.status === 409);
  sqlite.close();
});

test("closeShelfBox closes a non-empty open box + logs transition", () => {
  const { sqlite, db } = makeDb();
  seedReceivableItem(sqlite);
  const { id: scanId } = db.transaction((tx) => recordPutAwayScan(tx, { receivingInvoiceItemId: "rii", qty: 2 }));
  const { id: boxId } = db.transaction((tx) => createShelfBox(tx, { receivingOrderId: "ro", shelfCode: "A1" }));
  db.transaction((tx) => assignScanToBox(tx, { scanId, shelfBoxId: boxId }));
  db.transaction((tx) => closeShelfBox(tx, { shelfBoxId: boxId, actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT status FROM shelf_boxes WHERE id=?").get(boxId) as any).status, "closed");
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shelf_box' AND to_status='closed'").get() as any).c, 1);
  assertInvariantsHold(db);
  sqlite.close();
});
```

(`removeScanFromBox`, `closeShelfBox` must be added to the `./putAway.js` import.)

- [ ] **Step 2: Run tests to verify they fail** (not exported).

- [ ] **Step 3: Implement** in `apps/api/src/db/putAway.ts` (append)

```ts
export function removeScanFromBox(tx: DbOrTx, a: { scanId: string; actorId?: string | null }): void {
  const scan = tx.get<{ id: string; itemId: string; qty: number; shelfBoxId: string | null }>(
    sql`SELECT id, receiving_invoice_item_id AS itemId, qty, shelf_box_id AS shelfBoxId FROM put_away_scans WHERE id = ${a.scanId}`
  );
  if (!scan) throw new HTTPException(404, { message: "put-away scan not found" });
  if (scan.shelfBoxId === null) throw new HTTPException(409, { message: "scan is not in a box" });
  const box = loadShelfBox(tx, scan.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const item = tx.get<{ partId: string; receivingOrderId: string }>(
    sql`SELECT rii.part_id AS partId, ri.receiving_order_id AS receivingOrderId
        FROM receiving_invoice_items rii JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id WHERE rii.id = ${scan.itemId}`
  )!;

  tx.run(sql`UPDATE put_away_scans SET shelf_box_id = NULL, verified = 0, verified_at = NULL, updated_at = ${now()} WHERE id = ${scan.id}`);

  // reverse the lot materialization (find the lot via its source row in this box)
  const src = tx.get<{ id: string; lotId: string; qty: number }>(
    sql`SELECT ils.id, ils.inventory_lot_id AS lotId, ils.qty FROM inventory_lot_sources ils
        JOIN inventory_lots il ON il.id = ils.inventory_lot_id
        WHERE ils.receiving_invoice_item_id = ${scan.itemId} AND il.box_id = ${box.id}`
  );
  if (src) {
    if (src.qty - scan.qty <= 0) tx.run(sql`DELETE FROM inventory_lot_sources WHERE id = ${src.id}`);
    else tx.run(sql`UPDATE inventory_lot_sources SET qty = qty - ${scan.qty}, updated_at = ${now()} WHERE id = ${src.id}`);
    const lot = tx.get<{ total: number }>(sql`SELECT total_qty AS total FROM inventory_lots WHERE id = ${src.lotId}`)!;
    if (lot.total - scan.qty <= 0) tx.run(sql`DELETE FROM inventory_lots WHERE id = ${src.lotId}`);
    else tx.run(sql`UPDATE inventory_lots SET total_qty = total_qty - ${scan.qty}, updated_at = ${now()} WHERE id = ${src.lotId}`);
  }

  tx.run(sql`UPDATE receiving_invoice_items SET put_away_qty = put_away_qty - ${scan.qty}, updated_at = ${now()} WHERE id = ${scan.itemId}`);
  recomputeReceivingItem(tx, scan.itemId);

  scheduleCycleCount(tx, box.id);
  tryMarkReceivingOrderClear(tx, { receivingOrderId: item.receivingOrderId, actorId: a.actorId ?? null });
}

export function closeShelfBox(tx: DbOrTx, a: { shelfBoxId: string; actorId?: string | null }): void {
  const box = loadShelfBox(tx, a.shelfBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "shelf box is not open" });
  const cnt = tx.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM put_away_scans WHERE shelf_box_id = ${box.id}`)!.c;
  if (cnt === 0) throw new HTTPException(409, { message: "cannot close an empty shelf box" });
  tx.run(sql`UPDATE shelf_boxes SET status = 'closed', updated_at = ${now()} WHERE id = ${box.id}`);
  logTransition(tx, { entityType: "shelf_box", entityId: box.id, fromStatus: "open", toStatus: "closed", actorId: a.actorId ?? null });
  if (box.receivingOrderId) tryMarkReceivingOrderClear(tx, { receivingOrderId: box.receivingOrderId, actorId: a.actorId ?? null });
}
```

(If `recomputeLot` is imported but unused after this task, drop it from the import; it is not needed by Plan 6 — lot `total_qty` is written directly and `allocated_qty` is untouched here.)

- [ ] **Step 4: Add the routes** to `apps/api/src/routes/putAway.ts` (append)

```ts
putAwayRoute.post("/put-away/scans/:id/remove-from-box", (c) => {
  const scanId = c.req.param("id");
  db.transaction((tx) => removeScanFromBox(tx, { scanId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});

putAwayRoute.post("/shelf-boxes/:id/close", (c) => {
  const shelfBoxId = c.req.param("id");
  db.transaction((tx) => closeShelfBox(tx, { shelfBoxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});
```

- [ ] **Step 5: Append route test** to `apps/api/src/routes/putAway.test.ts` (before `cleanup`)

```ts
test("POST remove-from-box unboxes; POST close closes a non-empty box", async () => {
  const boxRes = await app.request("/receiving-orders/ro/shelf-boxes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_code: "A1" }),
  });
  const boxId = ((await boxRes.json()) as any).id;
  const scanRes = await app.request("/put-away/scans", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiving_invoice_item_id: "rii", qty: 2 }),
  });
  const scanId = ((await scanRes.json()) as any).id;
  await app.request(`/put-away/scans/${scanId}/assign-to-box`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelf_box_id: boxId }),
  });
  const close = await app.request(`/shelf-boxes/${boxId}/close`, { method: "POST" });
  assert.equal(close.status, 200);
  assert.equal((sqlite.prepare("SELECT status FROM shelf_boxes WHERE id=?").get(boxId) as any).status, "closed");
});
```
NOTE: relies on `ro`/`inv`/`rii` from earlier tests in this file (sequential shared sqlite). Confirm ordering; seed fresh ids if tangled. Report the choice.

- [ ] **Step 6: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/putAway.ts apps/api/src/db/putAway.test.ts apps/api/src/routes/putAway.ts apps/api/src/routes/putAway.test.ts
git commit -m "feat(api): remove scan from box + close shelf box (Plan 6 task 5)"
```

---

### Task 6: Schedule cycle-count on pick-from-boxed-lot (`pickScan.ts` hook)

`scheduleCycleCount` already fires on put-away assign/remove (T4/T5). The user's decision is "all shelf stock changes", so picking stock OUT of a boxed lot (and un-scanning it back) must also schedule a recount. This task wires `scheduleCycleCount` into the two `inventory_lots.total_qty` mutations in `db/pickScan.ts`.

**Files:**
- Modify: `apps/api/src/db/pickScan.ts` (hook `scheduleCycleCount` on boxed-lot decrement + restore)
- Test: `apps/api/src/db/cycleCount.test.ts` (new)

- [ ] **Step 1: Write the failing test** `apps/api/src/db/cycleCount.test.ts`

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
    INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','e','RO-1','in_hand','sup','0','0');
    INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at) VALUES ('inv','e','ro','INV-1','sup','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, put_away_qty, created_at, updated_at) VALUES ('rii','inv','p',5,5,5,'0','0');
    INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at, updated_at) VALUES ('box','ro','A1','verified','0','0');
    INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, verified, created_at, updated_at) VALUES ('pas','rii',5,'box',1,'0','0');
    INSERT INTO inventory_lots (id, part_id, shelf_code, box_id, total_qty, allocated_qty, created_at, updated_at) VALUES ('lot','p','A1','box',5,5,'0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','PO-1','picking','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, created_at, updated_at) VALUES ('pi','po','p',5,'0','0');
    INSERT INTO allocations (id, picking_item_id, qty, inventory_lot_id, created_at, updated_at) VALUES ('alloc','pi',5,'lot','0','0');
  `);
  return { sqlite, db };
}

test("scanAllocation from a boxed lot schedules a cycle-count recount and resets the box", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => scanAllocation(tx, { allocationId: "alloc", qty: 2, actorId: "u1" }));
  const vt = sqlite.prepare("SELECT kind, status, shelf_box_id FROM verification_tasks WHERE shelf_box_id='box'").get() as any;
  assert.deepEqual(vt, { kind: "cycle_count", status: "pending", shelf_box_id: "box" });
  // stock changed => box back to closed, scans unverified
  assert.equal((sqlite.prepare("SELECT status FROM shelf_boxes WHERE id='box'").get() as any).status, "closed");
  assert.equal((sqlite.prepare("SELECT verified FROM put_away_scans WHERE id='pas'").get() as any).verified, 0);
  assertInvariantsHold(db);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails** (no cycle_count task created yet).

- [ ] **Step 3: Wire the hook in `apps/api/src/db/pickScan.ts`.**
  - Add `scheduleCycleCount` to a new import: `import { scheduleCycleCount } from "./putAway.js";`
  - In `scanAllocation`, extend the boxed-lot SELECT (the `if (alloc.lotId)` branch) to also read `box_id AS boxId`, add `boxId: string | null` to that row's type, and immediately AFTER the `UPDATE inventory_lots SET total_qty = total_qty - ...` line add:
    ```ts
    if (lot.boxId) scheduleCycleCount(tx, lot.boxId);
    ```
  - In `removeScannedPackage` (the `pkg.sourceType === "inventory_lot"` branch), extend that lot SELECT to read `box_id AS boxId`, add it to the type, and immediately AFTER the `UPDATE inventory_lots SET total_qty = total_qty + ...` restore add:
    ```ts
    if (lot.boxId) scheduleCycleCount(tx, lot.boxId);
    ```
  Confirm there is no circular import (`putAway.ts` must NOT import from `pickScan.ts` — it imports only `invariants.js`, `now.js`, `transition.js`).

- [ ] **Step 4: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/pickScan.ts apps/api/src/db/cycleCount.test.ts
git commit -m "feat(api): schedule cycle-count on pick-from-boxed-lot (Plan 6 task 6)"
```

---

### Task 7: Verify a cycle-count box (`verifyShelfBoxItem` + `completeVerificationTask` cycle-count branch)

**Files:**
- Modify: `apps/api/src/db/putAway.ts`
- Modify: `apps/api/src/db/measure.ts` (only `completeVerificationTask`)
- Create: `apps/api/src/routes/goodsVerify.ts`
- Modify: `apps/api/src/routes/verificationTasks.ts` (add `due_before` filter)
- Modify: `apps/api/src/index.ts` (mount goodsVerify routes)
- Modify: `apps/api/src/dto.ts` (add `VerifyShelfBoxItemRequest`)
- Test: `apps/api/src/db/goodsVerify.test.ts` + route tests in same file

**Behavior (locked):**
- `verifyShelfBoxItem(tx, { shelfBoxId, partId, actorId? })`: marks all put-away scans in the box for that part as verified. Part is derived via the `receiving_invoice_items` join (scans have no `part_id`). 0 rows updated → 404.
- `completeVerificationTask` gains a `cycle_count` branch: guard task pending, guard no unverified scans left in the box (else 409), set `shelf_boxes.status='verified'` + log transition, set task completed + log. The existing pre_shipment path is unchanged; the current blanket 409 for non-pre_shipment kinds is replaced by the new branch.

- [ ] **Step 1: Write the failing tests.**

```ts
// apps/api/src/db/goodsVerify.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "./client.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema/index.js";
import { createTables } from "./tables.js";
import { verifyShelfBoxItem } from "./putAway.js";
import { completeVerificationTask } from "./measure.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO suppliers (id, code, name, created_at, updated_at) VALUES ('sup','S','Sup','0','0');
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0'), ('p2','Y','Y','0','0');
    INSERT INTO shelves (id, code, created_at, updated_at) VALUES ('sh','A1','0','0');
    INSERT INTO receiving_orders (id, external_id, ref_no, status, supplier_id, created_at, updated_at) VALUES ('ro','e','RO-1','in_hand','sup','0','0');
    INSERT INTO receiving_invoices (id, external_id, receiving_order_id, invoice_no, supplier_id, created_at, updated_at) VALUES ('inv','e','ro','INV-1','sup','0','0');
    INSERT INTO receiving_invoice_items (id, receiving_invoice_id, part_id, qty, received_qty, put_away_qty, created_at, updated_at) VALUES ('rii','inv','p',5,5,5,'0','0'), ('rii2','inv','p2',3,3,3,'0','0');
    INSERT INTO shelf_boxes (id, receiving_order_id, shelf_code, status, created_at, updated_at) VALUES ('box','ro','A1','closed','0','0');
    INSERT INTO put_away_scans (id, receiving_invoice_item_id, qty, shelf_box_id, verified, created_at, updated_at) VALUES ('pas','rii',5,'box',0,'0','0'), ('pas2','rii2',3,'box',0,'0','0');
    INSERT INTO verification_tasks (id, kind, status, shelf_box_id, due_at, created_at, updated_at) VALUES ('vt','cycle_count','pending','box','2099-01-01T09:00:00.000Z','0','0');
  `);
  return { sqlite, db };
}

test("verifyShelfBoxItem verifies only the given part's scans in the box", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p", actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT verified FROM put_away_scans WHERE id='pas'").get() as any).verified, 1);
  assert.equal((sqlite.prepare("SELECT verified FROM put_away_scans WHERE id='pas2'").get() as any).verified, 0);
  assertInvariantsHold(db);
  sqlite.close();
});

test("verifyShelfBoxItem 404s when the part has no scans in the box", () => {
  const { sqlite, db } = makeDb();
  assert.throws(
    () => db.transaction((tx) => verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "nope" })),
    (e: any) => e.status === 404,
  );
  sqlite.close();
});

test("completeVerificationTask(cycle_count) 409s while scans remain unverified", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p" }));
  assert.throws(
    () => db.transaction((tx) => completeVerificationTask(tx, { taskId: "vt", actorId: "u1" })),
    (e: any) => e.status === 409,
  );
  sqlite.close();
});

test("completeVerificationTask(cycle_count) completes task and marks box verified", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => {
    verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p" });
    verifyShelfBoxItem(tx, { shelfBoxId: "box", partId: "p2" });
    completeVerificationTask(tx, { taskId: "vt", actorId: "u1" });
  });
  assert.equal((sqlite.prepare("SELECT status FROM verification_tasks WHERE id='vt'").get() as any).status, "completed");
  assert.equal((sqlite.prepare("SELECT status FROM shelf_boxes WHERE id='box'").get() as any).status, "verified");
  assertInvariantsHold(db);
  sqlite.close();
});
```

Route tests (same file, temp `DATABASE_URL` + dynamic `await import("../index.js")`, as in earlier route tests — re-seed fresh ids, do NOT rely on ids from other test files):

```ts
test("POST /shelf-boxes/:id/verify-item marks scans verified", async () => {
  // seed via API or direct sqlite insert (see earlier route-test pattern): box with one unverified scan for part p
  const res = await app.request("/shelf-boxes/box/verify-item", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ part_id: "p", actor_id: "u1" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.verified_count, 1);
});

test("GET /verification-tasks?due_before=... filters by due_at", async () => {
  const res = await app.request("/verification-tasks?due_before=2099-01-02T00:00:00.000Z");
  assert.equal(res.status, 200);
  const tasks = await res.json();
  assert.ok(tasks.some((t: any) => t.id === "vt"));
  const res2 = await app.request("/verification-tasks?due_before=2020-01-01T00:00:00.000Z");
  assert.equal((await res2.json()).length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail.**

- [ ] **Step 3: Implement `verifyShelfBoxItem` in `apps/api/src/db/putAway.ts`.**

```ts
export function verifyShelfBoxItem(
  tx: DbOrTx,
  { shelfBoxId, partId, actorId }: { shelfBoxId: string; partId: string; actorId?: string | null },
) {
  const now = new Date().toISOString();
  const result = tx
    .update(putAwayScans)
    .set({ verified: 1, verifiedAt: now, verifiedBy: actorId ?? null, updatedAt: now })
    .where(
      and(
        eq(putAwayScans.shelfBoxId, shelfBoxId),
        sql`${putAwayScans.receivingInvoiceItemId} IN (SELECT id FROM receiving_invoice_items WHERE part_id = ${partId})`,
        eq(putAwayScans.verified, 0),
      ),
    )
    .run();
  if (result.changes === 0) {
    throw new HTTPException(404, { message: "no unverified scans for part in box" });
  }
  return { verifiedCount: result.changes };
}
```

Check the actual `put_away_scans` column names in `schema/inventory.ts` (`verified_at` / `verified_by` — if `verified_by` does not exist, omit it from the `.set(...)` and note that; do NOT add a column in this task). Import `and`, `eq`, `sql` from `drizzle-orm` consistently with the rest of the file.

- [ ] **Step 4: Extend `completeVerificationTask` in `apps/api/src/db/measure.ts`.**
  - Locate the current guard that 409s any task whose `kind !== "pre_shipment"`.
  - Replace it with: `if (task.kind === "cycle_count") { ...new branch... } else if (task.kind !== "pre_shipment") { throw 409 }`.
  - New `cycle_count` branch:
    1. Guard `task.status === "pending"` (reuse the existing pending guard if it already applies to all kinds — do not double-guard).
    2. `const boxId = task.shelfBoxId;` — if null, 409 "cycle_count task has no shelf box".
    3. Count unverified scans: `SELECT COUNT(*) AS n FROM put_away_scans WHERE shelf_box_id = ? AND verified = 0`. If `n > 0` → 409 "box has unverified items".
    4. `UPDATE shelf_boxes SET status='verified', updated_at=now WHERE id=boxId`; `logTransition(tx, { entityType: "shelf_box", entityId: boxId, fromStatus: <current box status>, toStatus: "verified", actorId })`. Load the box row first for the from-status; 404 if missing.
    5. Set the task `status='completed', completed_at=now, completed_by=actorId` + `logTransition` for the task — mirror exactly how the pre_shipment branch completes the task (reuse the same update/log calls).

- [ ] **Step 5: Add the route file `apps/api/src/routes/goodsVerify.ts`.**

```ts
import { Hono } from "hono";
import { verifyShelfBoxItem } from "../db/putAway.js";
import { db } from "../db/client.js"; // match how other route files obtain db

export const goodsVerifyRoutes = new Hono();

goodsVerifyRoutes.post("/shelf-boxes/:id/verify-item", async (c) => {
  const shelfBoxId = c.req.param("id");
  const body = await c.req.json();
  const { part_id, actor_id } = body;
  if (!part_id || typeof part_id !== "string") {
    return c.json({ error: "part_id is required" }, 400);
  }
  const result = db.transaction((tx) =>
    verifyShelfBoxItem(tx, { shelfBoxId, partId: part_id, actorId: actor_id ?? null }),
  );
  return c.json({ ok: true, verified_count: result.verifiedCount });
});
```

Match the exact db-access and error-propagation pattern of an existing route file (e.g. `routes/measure.ts`) — helpers throw `HTTPException`, which the app's existing error handler maps to status codes; do not add a try/catch.

- [ ] **Step 6: Mount in `apps/api/src/index.ts`:** `app.route("/", goodsVerifyRoutes);` next to the other route mounts. Add the DTO to `apps/api/src/dto.ts`:
```ts
export interface VerifyShelfBoxItemRequest {
  part_id: string;
  actor_id?: string | null;
}
```

- [ ] **Step 7: Add `due_before` filter to `GET /verification-tasks` in `apps/api/src/routes/verificationTasks.ts`.**
  In the existing WHERE assembly, add:
  ```ts
  const dueBefore = c.req.query("due_before");
  // ...in the SQL: AND (${dueBefore ?? null} IS NULL OR due_at <= ${dueBefore ?? null})
  ```
  Follow the file's existing parameter style (if it builds SQL with bound params, add `due_at <= ?` conditionally instead of interpolating).

- [ ] **Step 8: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/putAway.ts apps/api/src/db/measure.ts apps/api/src/routes/goodsVerify.ts apps/api/src/routes/verificationTasks.ts apps/api/src/index.ts apps/api/src/dto.ts apps/api/src/db/goodsVerify.test.ts
git commit -m "feat(api): cycle-count verify-item + task completion (Plan 6 task 7)"
```

---

### Task 8: Read endpoints — put-away screens + shelf/box browse

**Files:**
- Create: `apps/api/src/routes/putAway.ts`
- Modify: `apps/api/src/routes/goodsVerify.ts` (add shelf/box read endpoints)
- Modify: `apps/api/src/index.ts` (mount putAway routes)
- Test: `apps/api/src/routes/putAway.test.ts` + extend route tests in `apps/api/src/db/goodsVerify.test.ts` (or a new `apps/api/src/routes/goodsVerify.test.ts` — follow whichever file the T7 route tests landed in)

**Port source (web, read-only reference — do NOT copy verbatim):**
- `apps/web/db/putAway.ts` lines 108–221 (`getPutAwayCandidates`, `getPutAwayLots`, `getPutAwayScansForReceivingOrder`) and 580–632 (`getShelfBoxesForReceivingOrder`)
- `apps/web/db/goodsVerify.ts` lines 45–152 (`getShelvesWithBoxes`, `getShelfBoxesByShelf`, `getShelfBoxDetail`)

**Mandatory adaptations (the API schema differs from the web):**
1. **`put_away_scans` has NO `part_id` column in the API.** Everywhere the web reads `pas.part_id`, join `receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id` and use `rii.part_id`.
2. **`rii.available_qty` is a real maintained column in the API** (recomputed by `recomputeReceivingItem` in `db/invariants.ts`: `received_qty - picked_qty - put_away_qty - allocated_qty`). Do NOT port the web's `availableReceivingQtySql` / `allocationsCte()` — read the column directly.
3. **sqlite has no `bool_and`.** "Fully verified" for a part-group = `MIN(pas.verified)` (ints 0/1; 1 only if all rows verified).
4. sqlite allows bare columns with `GROUP BY ro.id` / `GROUP BY rii.id` — keep queries simple and group by the primary key only.
5. Output JSON uses snake_case keys matching the web field names (e.g. `available_qty`, `receiving_invoice_item_id`, `shelf_box_id`, `part_no`) so the future frontend port stays mechanical. `verified` is returned as 0/1 integer; timestamps are ISO strings or null — do NOT convert to Date objects.

**Endpoints in `routes/putAway.ts`:**

`GET /put-away/candidates`
```sql
SELECT ro.id, ro.ref_no, ro.status, s.name AS supplier_name,
       SUM(rii.available_qty) AS available_qty,
       COALESCE(SUM(u.unboxed_qty), 0) AS unboxed_qty
FROM receiving_orders ro
JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
LEFT JOIN suppliers s ON s.id = ro.supplier_id
LEFT JOIN (
  SELECT receiving_invoice_item_id, SUM(qty) AS unboxed_qty
  FROM put_away_scans WHERE shelf_box_id IS NULL
  GROUP BY receiving_invoice_item_id
) u ON u.receiving_invoice_item_id = rii.id
WHERE ro.status = 'in_hand'
GROUP BY ro.id
HAVING SUM(rii.available_qty) > 0 OR COALESCE(SUM(u.unboxed_qty), 0) > 0
ORDER BY ro.ref_no
```

`GET /receiving-orders/:id/put-away-lots`
```sql
SELECT rii.id AS receiving_invoice_item_id, p.id AS part_id, p.part_no,
       rii.date_code, rii.lot_code, rii.coo, rii.cow,
       rii.qty AS total_qty, rii.available_qty AS available_qty,
       COALESCE(SUM(pas.qty), 0) AS scanned_qty,
       COALESCE(SUM(CASE WHEN pas.shelf_box_id IS NOT NULL THEN pas.qty ELSE 0 END), 0) AS boxed_qty
FROM receiving_orders ro
JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
JOIN parts p ON p.id = rii.part_id
LEFT JOIN put_away_scans pas ON pas.receiving_invoice_item_id = rii.id
WHERE ro.id = ? AND ro.status = 'in_hand'
GROUP BY rii.id
HAVING rii.available_qty > 0
    OR COALESCE(SUM(CASE WHEN pas.shelf_box_id IS NULL THEN pas.qty ELSE 0 END), 0) > 0
ORDER BY p.part_no, rii.date_code
```

`GET /receiving-orders/:id/put-away-scans`
```sql
SELECT pas.id, pas.receiving_invoice_item_id, rii.part_id, pas.qty,
       pas.date_code, pas.lot_code, pas.coo, pas.cow,
       pas.shelf_box_id, pas.verified, pas.verified_at, pas.created_at
FROM put_away_scans pas
JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
WHERE ri.receiving_order_id = ?
ORDER BY pas.created_at DESC
```

`GET /receiving-orders/:id/shelf-boxes` — boxes of the order, open first then newest first, each with an `items` array aggregated per part:
```sql
-- boxes:
SELECT id, receiving_order_id, shelf_code, status, created_at, updated_at
FROM shelf_boxes WHERE receiving_order_id = ?
ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC
-- items (one query, grouped in JS by shelf_box_id):
SELECT pas.shelf_box_id, rii.part_id, p.part_no,
       SUM(pas.qty) AS qty, MIN(pas.verified) AS verified
FROM put_away_scans pas
JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
JOIN parts p ON p.id = rii.part_id
WHERE pas.shelf_box_id IN (...)
GROUP BY pas.shelf_box_id, rii.part_id, p.part_no
```
If the order has no boxes, return `[]` and skip the items query. Build the `IN (...)` list with bound parameters, not string interpolation.

**Endpoints in `routes/goodsVerify.ts`:**

`GET /shelves` — `SELECT code, zone FROM shelves ORDER BY code`.

`GET /shelves/with-box-counts`
```sql
SELECT s.code, s.zone, COALESCE(COUNT(sb.id), 0) AS box_count
FROM shelves s
LEFT JOIN shelf_boxes sb ON sb.shelf_code = s.code
GROUP BY s.code
ORDER BY s.code
```

`GET /shelves/:code/boxes`
```sql
SELECT sb.id, sb.shelf_code, sb.status, sb.created_at,
       COUNT(bi.part_id) AS item_count,
       COUNT(CASE WHEN bi.fully_verified = 1 THEN 1 END) AS verified_count,
       lc.last_check_at
FROM shelf_boxes sb
LEFT JOIN (
  SELECT pas.shelf_box_id, rii.part_id, MIN(pas.verified) AS fully_verified
  FROM put_away_scans pas
  JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
  GROUP BY pas.shelf_box_id, rii.part_id
) bi ON bi.shelf_box_id = sb.id
LEFT JOIN (
  SELECT shelf_box_id, MAX(verified_at) AS last_check_at
  FROM put_away_scans GROUP BY shelf_box_id
) lc ON lc.shelf_box_id = sb.id
WHERE sb.shelf_code = ?
GROUP BY sb.id
ORDER BY sb.created_at DESC
```
Add a `checked_today` boolean per row: `last_check_at` starts with today's local date (`new Date().toISOString().slice(0,10)` comparison against the ISO prefix is acceptable — note this in a comment).

`GET /shelf-boxes/:id` — box detail:
```sql
SELECT sb.id, sb.receiving_order_id, sb.shelf_code, sb.status, sb.created_at,
       s.zone AS shelf_zone, ro.ref_no AS receiving_order_ref_no
FROM shelf_boxes sb
LEFT JOIN shelves s ON s.code = sb.shelf_code
LEFT JOIN receiving_orders ro ON ro.id = sb.receiving_order_id
WHERE sb.id = ?
```
404 if no row. Then items:
```sql
SELECT rii.part_id AS part_id, p.part_no, p.description,
       SUM(pas.qty) AS qty, MIN(pas.verified) AS verified,
       MAX(pas.verified_at) AS verified_at
FROM put_away_scans pas
JOIN receiving_invoice_items rii ON rii.id = pas.receiving_invoice_item_id
JOIN parts p ON p.id = rii.part_id
WHERE pas.shelf_box_id = ?
GROUP BY rii.part_id, p.part_no, p.description
```
Response shape: `{ id, receiving_order_id, shelf_code, status, created_at, shelf: {code, zone}|null, receiving_order: {id, ref_no}|null, items: [...] }`.

- [ ] **Step 1: Write the failing route tests.** Temp `DATABASE_URL` + dynamic `await import("../index.js")`, fresh seed ids per file (do not depend on ids seeded by other test files):
  - candidates: seed one in_hand order with available qty and one with zero available + no scans → only the first appears; seed an order whose items are fully put away but has an unboxed scan → it appears via `unboxed_qty`.
  - put-away-lots / put-away-scans / shelf-boxes: seed order + invoice + item + scans (one boxed, one unboxed) → assert rows, sums, ordering (open box first).
  - shelves endpoints: seed 2 shelves, 2 boxes on one → box_count 2 / 0; boxes list shows item_count/verified_count; box detail returns nested shelf + receiving_order + items; unknown box id → 404.

- [ ] **Step 2: Run tests to verify they fail** (routes 404).

- [ ] **Step 3: Implement `routes/putAway.ts` and the goodsVerify additions.** Use the same db-access pattern as existing route files (`db` from `db/client.js` or however `routes/boxes.ts` does it — check and match). Raw queries via the underlying better-sqlite3 prepared statements or `db.all(sql`...`)` — match how `routes/receiving.ts` / `routes/picking.ts` run list queries. Mount `putAwayRoutes` in `index.ts`.

- [ ] **Step 4: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/routes/putAway.ts apps/api/src/routes/putAway.test.ts apps/api/src/routes/goodsVerify.ts apps/api/src/index.ts
git commit -m "feat(api): put-away + shelf-box read endpoints (Plan 6 task 8)"
```

---

### Task 9: Final gate — full verification, smoke test, docs, commit

**Files:**
- Modify: `docs/app-docs/ai/feature-registry.md`
- Modify: `docs/app-docs/ai/code-map.md`
- Modify: `docs/app-docs/flows/put-away/ai-scope.md` (create if missing, using `docs/app-docs/ai/scope-remark-template.md`)
- Modify: `docs/app-docs/flows/goods-verify/ai-scope.md` (create if missing)

- [ ] **Step 1: Full suite + build (must both be green before anything else):**
```bash
cmd.exe //c "pnpm --filter @warehouse/api test"
cmd.exe //c "pnpm --filter @warehouse/api build"
```
Record the test count in the commit message. If anything is red, stop and fix — do not proceed.

- [ ] **Step 2: Curl smoke test against a real server.** Start the API on a temp db (`DATABASE_URL=$(mktemp -u).sqlite node apps/api/dist/server.js`, or the project's usual start command — check `apps/api/package.json` scripts), then exercise the whole Plan 6 flow end to end with curl and save transcripts:
  1. Seed path: create receiving order via the existing ingest endpoints (check `routes/receiving.ts` for the create/confirm endpoints from earlier plans), confirm arrival (`status → in_hand`).
  2. `GET /put-away/candidates` → order appears.
  3. Create a shelf box (`POST` from Task 2), record a scan (Task 3), assign scan to box (Task 4) → `inventory_lots` row materialized; close box (Task 5).
  4. Repeat until all items put away → receiving order auto-flips to `clear` (`tryMarkReceivingOrderClear`).
  5. Cycle count: confirm a `cycle_count` verification task exists for the box (created at assignment, Task 4 `scheduleCycleCount`); `GET /verification-tasks?due_before=<tomorrow>` lists it.
  6. `POST /shelf-boxes/:id/verify-item` for each part → `GET /shelf-boxes/:id` shows all `verified: 1`.
  7. Complete the task (existing `POST /verification-tasks/:id/complete` from Plan 5) → box `status = verified`.
  8. Pick from the boxed lot via the existing pick-scan endpoint (Task 6 hook) → a NEW cycle_count task appears and the box falls back to `closed`, scans unverified.
  Kill the server afterward. Keep the transcript short — status codes + key JSON fields only.

- [ ] **Step 3: Update the docs registry.** In `feature-registry.md` add/update rows for the put-away, receiving-clear, and cycle-count features pointing at the API files (`apps/api/src/db/putAway.ts`, `apps/api/src/routes/putAway.ts`, `apps/api/src/routes/goodsVerify.ts`, `apps/api/src/db/measure.ts` cycle-count branch, `apps/api/src/db/pickScan.ts` hook). In `code-map.md` map the put-away / goods-verify pages to the new endpoints. In the two `ai-scope.md` files, note: API-first implementation, web pages still on PGlite until the frontend migration plan; key files; known limitations (cycle-count due time is next local 09:00; coalesced one task per box per day; `shelf_box_items` table intentionally unused — aggregates derive from `put_away_scans`).

- [ ] **Step 4: Commit docs + any stragglers:**
```bash
git add docs/app-docs/ai/feature-registry.md docs/app-docs/ai/code-map.md docs/app-docs/flows/put-away docs/app-docs/flows/goods-verify
git commit -m "docs: registry + scope for put-away / cycle-count API (Plan 6 task 9)"
```

---

## Self-review checklist (plan author)

- [x] Every state-changing helper runs inside `db.transaction` and every new test ends with `assertInvariantsHold(db)`.
- [x] No writes to generated columns (`inventory_lots.available_qty`, `picking_items.remaining_qty`); `receiving_invoice_items.available_qty` is maintained only via `recomputeReceivingItem`.
- [x] Cycle-count triggers cover ALL shelf-box stock changes per the locked decision: assignment (T4), removal from box (T5), pick from boxed lot + undo (T6).
- [x] `scheduleCycleCount` coalesces via the existing `verification_tasks_cycle_coalesce_uq` index — one task per box per calendar day; due_at = next local 09:00.
- [x] Web-port adaptations are explicit: no `part_id` on `put_away_scans` (join `receiving_invoice_items`), no `bool_and` (use `MIN(verified)`), `rii.available_qty` is a real column (no CTE port).
- [x] `shelf_box_items` stays unused; box contents aggregate live from `put_away_scans`.
- [x] Known fragility flagged to implementers: sequential shared sqlite in route test files — each new route test file re-seeds its own fresh ids.
- [x] Conventions: NodeNext `.js` imports, `crypto.randomUUID()`, helpers throw `HTTPException`, `verified` INTEGER 0/1, `cmd.exe //c` prefix for pnpm, commit explicit paths only, never stage the known strays.

## Risks / watch-items

- `measure.ts`'s `completeVerificationTask` is shared with the Plan 5 pre-shipment flow — the T7 edit must not alter the pre_shipment path. Reviewer: diff that function carefully.
- sqlite `GROUP BY` bare-column behavior is relied on in T8 list queries; keep `GROUP BY` on the primary key so the picked values are deterministic.
- `checked_today` uses the server clock's UTC date prefix; good enough for the demo, documented as a limitation in ai-scope.
