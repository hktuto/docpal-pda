# Measuring + Pre-Shipment Verification (Plan 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the PDA measuring + pre-shipment verification slice to the Hono API: verify packages inside a box, set box measurements, close boxes, complete the measuring task (which auto-creates the pre-shipment `verification_tasks` row per spec §10), then box-level pre-shipment verify (`closed → verified`) and verification-task completion — plus the read/polling endpoints the measuring/verify screens need.

**Architecture:** Tx-scoped execution primitives in new `apps/api/src/db/measure.ts` (sibling of `db/pickScan.ts`), all stock math reusing the Plan 1 invariant primitives. Routes split by resource root: new `routes/boxes.ts` (`/shipping-boxes/:id/*`), extended `routes/measuring.ts` (`/measuring-tasks*`), new `routes/verification.ts` (`/verification-tasks*`). Every route opens `db.transaction` per request and does its ownership pre-check inside it, mirroring Plan 4.

**Tech Stack:** Hono 4 (`hono`, `hono/http-exception`), `drizzle-orm/better-sqlite3`, raw `sql` via `db.get/all` and `tx.get/all/run`, `node:test` + `tsx`, `crypto.randomUUID()`. No new dependencies.

**Governing docs:** `docs/superpowers/specs/2026-07-10-db-schema-rethink-design.md` (§10 task triggers, §11 polling, §13 state machines), `docs/superpowers/specs/2026-07-07-api-endpoints-design.md` (§7 measuring endpoint contract), web reference `apps/web/db/measuring.ts` (ported almost 1:1; goods-verify `apps/web/db/goodsVerify.ts` is the cycle-count flow = Plan 6).

---

## Conventions (read first)

- **Shell:** prefix **every** verification command with `cmd.exe //c` (plain `pnpm` is broken here):
  - Build: `cmd.exe //c "pnpm --filter @warehouse/api build"` — Tests: `cmd.exe //c "pnpm --filter @warehouse/api test"`. Do not edit `package.json`.
- **Commits:** commit directly to `master`, never push. Stage explicit paths only (`git add <paths>`, never `-A`); never stage the pre-existing stray files (`apps/web/public/labels-data.json` M, `tmp_screencap_*.png` D, `apps/web/public/box-shelf-labels.pdf`, `apps/web/scripts/generate-box-shelf-labels-pdf.mjs`, `apps/web/utils/scroll.ts`, `ui.xml`–`ui5.xml`).
- **NodeNext:** relative imports end in `.js`. **Timestamps:** `now()` from `db/now.ts`. **IDs:** global `crypto.randomUUID()`. **Transitions:** `logTransition` from `ingest/transition.js` (`{ entityType, entityId, fromStatus?, toStatus?, actorId?, note? }`).
- **Generated columns (never write):** `picking_items.remaining_qty`, `inventory_lots.available_qty`. **Maintained columns** change only via `db/invariants.ts` primitives (test seeds excepted). Plan 5 touches no stock math — only `picking_packages.verified`, `shipping_boxes.*`, `measuring_tasks.status`, `verification_tasks.*`.
- **Test backstop:** every state-changing test ends with `assertInvariantsHold(db)` from `db/invariants.guard.ts`. Isolated DBs via the `makeDb()` pattern from `db/pickScan.test.ts`.
- **Route tests** use the temp-`DATABASE_URL` + dynamic `await import("../index.js")` pattern from `routes/pickingExecution.test.ts` (each test file is its own node process; set the env var BEFORE the import).
- All helpers throw `HTTPException` (400 validation / 404 missing / 409 state conflict).
- **`verified` is INTEGER 0/1** in sqlite; better-sqlite3 returns numbers. Compare with `0`/`1` in tests.

---

## Scope boundaries (decided — do not re-open)

- **IN:** measuring execution (`verifyPackage`, `updateShippingBoxMeasurements`, `closeShippingBox`, `completeMeasuringTask`); measuring-complete → auto-create `verification_tasks(kind='pre_shipment')` (spec §10, mirrors Plan 4's auto-finish → measuring task); pre-shipment box verify + verification-task complete; reads: measuring detail, for-measuring box detail, verification list+detail, measuring list totals.
- **OUT (Plan 6):** put-away + receiving-order `clear` (spec §10/§15), cycle-count verification (`kind='cycle_count'` — needs shelf-box data from put-away; `verifyShelfBoxScans`/`markShelfBoxVerified` from the web port then), receiving-side candidate scan endpoints (`findReceivingCandidates`/`findPickingCandidates`), seed port, frontend adapter.
- **DECIDED (pre-shipment semantics — user-confirmed):** pre-shipment verify is **box-level**: worker confirms the box and it goes `closed → verified`. Packages keep their measuring-time `verified=1` flags (no reset). `verifyShippingBox` still asserts every package in the box is verified as a guard. Rationale: schema has one package `verified` flag + a box `verified` status — the box status machine (`open → closed → verified`, spec §13) exists for exactly this step.
- **DECIDED (task ↔ boxes linkage):** the API `shipping_boxes` has **no** `measuring_task_id` (the web had one). A measuring task links to its boxes through `picking_order_id` (`measuring_tasks.picking_order_id` is UNIQUE ⇒ one measuring task per order; a pre_shipment verification task likewise resolves the order's boxes via `picking_order_id`).
- **DECIDED (destination default, spec §10):** at close time, if `shipping_boxes.destination_country` is empty, fall back to `picking_orders.destination_country ?? picking_orders.ship_to`; the resolved value is persisted into the box at close. Still empty → 409.
- **DECIDED (weights):** integer grams (`net_weight_g`/`gross_weight_g`, spec §3/§14). PATCH accepts number | numeric string | null (null = clear). Validation (> 0, gross ≥ net) happens at **close**, mirroring the web.
- **DECIDED (measurement edits):** allowed only while box is `open` (409 after close) — stricter than the web (which has no status guard); measurements are a pre-close concern.
- **DECIDED (request bodies):** snake_case fields per this API's convention (`package_id`, `actor_id`, `box_size`, `net_weight_g`, `gross_weight_g`, `destination_country`) — supersedes the camelCase sketch in the 2026-07-07 spec.
- **DECIDED (scan→package matching):** stays **client-side** per the endpoints spec (`VerifyPackageRequest { packageId }`). The PDA uses the for-measuring/detail payloads to match scans; the server takes a resolved `package_id`. No server-side matcher is built in Plan 5.
- **DECIDED (cycle-count task completion):** `POST /verification-tasks/:id/complete` is pre_shipment-only for now (`kind != 'pre_shipment'` → 409). Cycle-count completion lands with Plan 6.
- **Actor:** endpoints accept optional `actor_id` (body for body-bearing POST/PATCH, `?actor_id=` query for body-less POSTs) — same split as Plan 4.

---

## File structure

**Create**
- `apps/api/src/db/measure.ts` — all execution primitives (surface below).
- `apps/api/src/routes/boxes.ts` — `/shipping-boxes` routes.
- `apps/api/src/routes/verification.ts` — `/verification-tasks` routes.
- Tests: `apps/api/src/db/measure.test.ts` (T1–T3), `apps/api/src/db/verify.test.ts` (T4–T5), `apps/api/src/routes/boxes.test.ts` (T1–T3, T5, T6), `apps/api/src/routes/verification.test.ts` (T5–T6).

**Modify**
- `apps/api/src/routes/measuring.ts` — extend list with totals + `ref_no`; add detail + complete routes (T4, T6).
- `apps/api/src/db/tables.ts` — add the pending-pre_shipment unique backstop index (T4).
- `apps/api/src/index.ts` — mount `boxesRoute`, `verificationRoute`.
- `packages/shared/src/index.ts` — request DTOs (T1, T2).

**Function surface (locked)**
```ts
// db/measure.ts — all throw HTTPException; all run inside the caller's tx
export function updateShippingBoxMeasurements(tx: DbOrTx, a: {
  shippingBoxId: string;
  fields: { boxSize?: string | null; netWeightG?: number | string | null; grossWeightG?: number | string | null; destinationCountry?: string | null };
}): void;
export function verifyPackage(tx: DbOrTx, a: { packageId: string; actorId?: string | null }): void;
export function closeShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): void;
export function completeMeasuringTask(tx: DbOrTx, a: { measuringTaskId: string; actorId?: string | null }): void;
export function verifyShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): void;
export function completeVerificationTask(tx: DbOrTx, a: { verificationTaskId: string; actorId?: string | null }): void;
```

**Route surface (locked)**
```
GET    /shipping-boxes/:id/for-measuring        (T6)
PATCH  /shipping-boxes/:id                      (T1)
POST   /shipping-boxes/:id/verify-package       (T2)
POST   /shipping-boxes/:id/close                (T3)
POST   /shipping-boxes/:id/verify               (T5)
GET    /measuring-tasks                         (exists; extend with totals T6)
GET    /measuring-tasks/:id                     (T6)
POST   /measuring-tasks/:id/complete            (T4)
GET    /verification-tasks?kind=&status=&since= (T6)
GET    /verification-tasks/:id                  (T6)
POST   /verification-tasks/:id/complete         (T5)
```

---

### Task 1: Box measurements (`updateShippingBoxMeasurements` + `PATCH /shipping-boxes/:id`)

**Files:**
- Create: `apps/api/src/db/measure.ts`
- Create: `apps/api/src/routes/boxes.ts`
- Modify: `apps/api/src/index.ts` (mount `boxesRoute`)
- Modify: `packages/shared/src/index.ts` (add `UpdateShippingBoxRequest`)
- Test: `apps/api/src/db/measure.test.ts` + `apps/api/src/routes/boxes.test.ts`

- [ ] **Step 1: Write the failing test** `apps/api/src/db/measure.test.ts`

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
import { updateShippingBoxMeasurements } from "./measure.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at)
      VALUES ('po','e','R','finished','HK','HK','0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0');
  `);
  return { sqlite, db };
}

function box(sqlite: any) {
  return sqlite.prepare("SELECT box_size, net_weight_g, gross_weight_g, destination_country FROM shipping_boxes WHERE id='box'").get() as any;
}

test("updateShippingBoxMeasurements sets, parses and clears fields", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { boxSize: " 40x30x20 ", netWeightG: "500", grossWeightG: 800 } }));
  assert.deepEqual(box(sqlite), { box_size: "40x30x20", net_weight_g: 500, gross_weight_g: 800, destination_country: null });
  // explicit null clears; omitted fields stay
  db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { netWeightG: null, destinationCountry: " US " } }));
  assert.deepEqual(box(sqlite), { box_size: "40x30x20", net_weight_g: null, gross_weight_g: 800, destination_country: "US" });
  assertInvariantsHold(db);
  sqlite.close();
});

test("measurement guards: 404 missing, 400 bad weight, 409 closed box", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "nope", fields: { netWeightG: 1 } })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { netWeightG: "abc" } })), (e: any) => e.status === 400);
  assert.throws(() => db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { grossWeightG: 1.5 } })), (e: any) => e.status === 400);
  assert.throws(() => db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { grossWeightG: -1 } })), (e: any) => e.status === 400);
  sqlite.prepare("UPDATE shipping_boxes SET status='closed'").run();
  assert.throws(() => db.transaction((tx) => updateShippingBoxMeasurements(tx, { shippingBoxId: "box", fields: { boxSize: "x" } })), (e: any) => e.status === 409);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails** — `Cannot find module './measure.js'`.

- [ ] **Step 3: Implement `apps/api/src/db/measure.ts`**

```ts
import { sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbOrTx } from "./invariants.js";
import { now } from "./now.js";
import { logTransition } from "../ingest/transition.js";

interface BoxRow { id: string; pickingOrderId: string; status: string; boxSize: string | null; netWeightG: number | null; grossWeightG: number | null; destinationCountry: string | null }

function loadBox(tx: DbOrTx, boxId: string): BoxRow {
  const box = tx.get<BoxRow>(
    sql`SELECT id, picking_order_id AS pickingOrderId, status, box_size AS boxSize,
               net_weight_g AS netWeightG, gross_weight_g AS grossWeightG, destination_country AS destinationCountry
        FROM shipping_boxes WHERE id = ${boxId}`
  );
  if (!box) throw new HTTPException(404, { message: "shipping box not found" });
  return box;
}

/** undefined = leave unchanged; null = clear; otherwise parsed/trimmed value. */
function parseGrams(v: number | string | null | undefined, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HTTPException(400, { message: `${field} must be a non-negative integer (grams)` });
  return n;
}

function cleanText(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function updateShippingBoxMeasurements(
  tx: DbOrTx,
  a: { shippingBoxId: string; fields: { boxSize?: string | null; netWeightG?: number | string | null; grossWeightG?: number | string | null; destinationCountry?: string | null } }
): void {
  const box = loadBox(tx, a.shippingBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const size = cleanText(a.fields.boxSize);
  const net = parseGrams(a.fields.netWeightG, "net_weight_g");
  const gross = parseGrams(a.fields.grossWeightG, "gross_weight_g");
  const dest = cleanText(a.fields.destinationCountry);
  tx.run(
    sql`UPDATE shipping_boxes SET
          box_size = ${size === undefined ? box.boxSize : size},
          net_weight_g = ${net === undefined ? box.netWeightG : net},
          gross_weight_g = ${gross === undefined ? box.grossWeightG : gross},
          destination_country = ${dest === undefined ? box.destinationCountry : dest},
          updated_at = ${now()}
        WHERE id = ${box.id}`
  );
}
```

- [ ] **Step 4: Add `UpdateShippingBoxRequest` to `packages/shared/src/index.ts`** (match the file's existing one-line interface style)
```ts
export interface UpdateShippingBoxRequest { box_size?: string | null; net_weight_g?: number | string | null; gross_weight_g?: number | string | null; destination_country?: string | null; }
```

- [ ] **Step 5: Create `apps/api/src/routes/boxes.ts`** (PATCH route only for now; later tasks append), and mount it in `apps/api/src/index.ts`

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { UpdateShippingBoxRequest } from "@warehouse/shared";
import { db } from "../db.js";
import { updateShippingBoxMeasurements } from "../db/measure.js";

export const boxesRoute = new Hono();

async function readJson<T>(c: any): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
}

boxesRoute.patch("/shipping-boxes/:id", async (c) => {
  const boxId = c.req.param("id");
  const body = await readJson<UpdateShippingBoxRequest>(c);
  db.transaction((tx) => updateShippingBoxMeasurements(tx, {
    shippingBoxId: boxId,
    fields: { boxSize: body.box_size, netWeightG: body.net_weight_g, grossWeightG: body.gross_weight_g, destinationCountry: body.destination_country },
  }));
  return c.json({ ok: true }, 200);
});
```

```ts
// apps/api/src/index.ts additions
import { boxesRoute } from "./routes/boxes.js";
app.route("/", boxesRoute);
```

Check how `routes/pickingExecution.ts` types its `readJson` (it uses Hono `Context`) and match that — if `c: any` fails tsc, type it the same way.

- [ ] **Step 6: Write the failing route test** `apps/api/src/routes/boxes.test.ts`, run, watch fail, then re-run after steps 3–5

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
  INSERT INTO picking_orders (id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at)
    VALUES ('po','e','R','finished','HK','HK','0','0');
  INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','open','0','0');
`);

test("PATCH /shipping-boxes/:id sets measurements; 404 missing; 400 bad json", async () => {
  const res = await app.request("/shipping-boxes/box", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ box_size: "S", net_weight_g: "500", gross_weight_g: 900 }),
  });
  assert.equal(res.status, 200);
  const row = sqlite.prepare("SELECT box_size, net_weight_g, gross_weight_g FROM shipping_boxes WHERE id='box'").get() as any;
  assert.deepEqual(row, { box_size: "S", net_weight_g: 500, gross_weight_g: 900 });

  const missing = await app.request("/shipping-boxes/nope", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ box_size: "S" }),
  });
  assert.equal(missing.status, 404);
  const bad = await app.request("/shipping-boxes/box", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400);
});

test("cleanup", () => { sqlite.close(); });
```

NOTE: TDD order for this task is test-primitive → fail → primitive → pass, then route → route test → pass. Running the whole new suite must end green.

- [ ] **Step 7: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/measure.ts apps/api/src/db/measure.test.ts apps/api/src/routes/boxes.ts apps/api/src/routes/boxes.test.ts apps/api/src/index.ts packages/shared/src/index.ts
git commit -m "feat(api): shipping box measurement update (Plan 5 task 1)"
```

---

### Task 2: Verify a package in a box (`verifyPackage` + `POST /shipping-boxes/:id/verify-package`)

**Files:**
- Modify: `apps/api/src/db/measure.ts` (add `verifyPackage`)
- Modify: `apps/api/src/routes/boxes.ts` (add route)
- Modify: `packages/shared/src/index.ts` (add `VerifyPackageRequest`)
- Test: append to `apps/api/src/db/measure.test.ts` + `apps/api/src/routes/boxes.test.ts`

- [ ] **Step 1: Append failing tests** to `apps/api/src/db/measure.test.ts`

```ts
// extra seed helper for package-verify tests (call inside each test after makeDb)
function seedPackableBox(sqlite: any) {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('pi','po','p',4,4,'0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
      VALUES ('pp','pi','inventory_lot','lot',4,'box','0','0');
    INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES ('mt','po','pending','0','0');
  `);
}

test("verifyPackage marks the package verified + logs transition", () => {
  const { sqlite, db } = makeDb();
  seedPackableBox(sqlite);
  db.transaction((tx) => verifyPackage(tx, { packageId: "pp", actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT verified FROM picking_packages WHERE id='pp'").get() as any).verified, 1);
  const logs = sqlite.prepare("SELECT entity_type, from_status, to_status, actor_id FROM transition_logs WHERE entity_type='picking_package'").all() as any[];
  assert.deepEqual(logs, [{ entity_type: "picking_package", from_status: "unverified", to_status: "verified", actor_id: "u1" }]);
  assertInvariantsHold(db);
  sqlite.close();
});

test("verifyPackage guards: 404 missing, 409 not in box, 409 box closed, 409 task not pending, 409 already verified", () => {
  const { sqlite, db } = makeDb();
  seedPackableBox(sqlite);
  assert.throws(() => db.transaction((tx) => verifyPackage(tx, { packageId: "nope" })), (e: any) => e.status === 404);
  sqlite.prepare("UPDATE picking_packages SET shipping_box_id=NULL").run();
  assert.throws(() => db.transaction((tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_packages SET shipping_box_id='box'").run();
  sqlite.prepare("UPDATE shipping_boxes SET status='closed'").run();
  assert.throws(() => db.transaction((tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE shipping_boxes SET status='open'").run();
  sqlite.prepare("UPDATE measuring_tasks SET status='completed'").run();
  assert.throws(() => db.transaction((tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE measuring_tasks SET status='pending'").run();
  sqlite.prepare("UPDATE picking_packages SET verified=1").run();
  assert.throws(() => db.transaction((tx) => verifyPackage(tx, { packageId: "pp" })), (e: any) => e.status === 409);
  sqlite.close();
});
```

(`verifyPackage` must be added to the `./measure.js` import at the top of the file.)

- [ ] **Step 2: Run tests to verify they fail** (not exported).

- [ ] **Step 3: Implement** in `apps/api/src/db/measure.ts` (append)

```ts
export function verifyPackage(tx: DbOrTx, a: { packageId: string; actorId?: string | null }): void {
  const pkg = tx.get<{ id: string; shippingBoxId: string | null; verified: number; qty: number; pickingOrderId: string }>(
    sql`SELECT pp.id, pp.shipping_box_id AS shippingBoxId, pp.verified, pp.qty, pi.picking_order_id AS pickingOrderId
        FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id WHERE pp.id = ${a.packageId}`
  );
  if (!pkg) throw new HTTPException(404, { message: "package not found" });
  if (pkg.shippingBoxId === null) throw new HTTPException(409, { message: "package is not in a box" });
  const box = loadBox(tx, pkg.shippingBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const task = tx.get<{ status: string }>(sql`SELECT status FROM measuring_tasks WHERE picking_order_id = ${pkg.pickingOrderId}`);
  if (!task || task.status !== "pending") throw new HTTPException(409, { message: "measuring task is not pending" });
  if (pkg.verified) throw new HTTPException(409, { message: "package already verified" });

  tx.run(sql`UPDATE picking_packages SET verified = 1, updated_at = ${now()} WHERE id = ${pkg.id}`);
  logTransition(tx, { entityType: "picking_package", entityId: pkg.id, fromStatus: "unverified", toStatus: "verified",
    actorId: a.actorId ?? null, note: `qty=${pkg.qty} box=${box.id}` });
}
```

- [ ] **Step 4: Add `VerifyPackageRequest` to `packages/shared/src/index.ts`**
```ts
export interface VerifyPackageRequest { package_id: string; actor_id?: string | null; }
```

- [ ] **Step 5: Add the route** to `apps/api/src/routes/boxes.ts` (append; import `verifyPackage`)

```ts
boxesRoute.post("/shipping-boxes/:id/verify-package", async (c) => {
  const boxId = c.req.param("id");
  const body = await readJson<VerifyPackageRequest>(c);
  if (!body.package_id) throw new HTTPException(400, { message: "package_id is required" });
  db.transaction((tx) => {
    const pkg = tx.get<{ shippingBoxId: string | null }>(sql`SELECT shipping_box_id AS shippingBoxId FROM picking_packages WHERE id = ${body.package_id}`);
    if (!pkg || pkg.shippingBoxId !== boxId) throw new HTTPException(404, { message: "package not found in this box" });
    verifyPackage(tx, { packageId: body.package_id!, actorId: body.actor_id ?? null });
  });
  return c.json({ ok: true }, 200);
});
```

(`sql` must be imported in boxes.ts — add `import { sql } from "drizzle-orm";`.)

- [ ] **Step 6: Append route test** to `apps/api/src/routes/boxes.test.ts` (before the `cleanup` test)

```ts
test("POST /shipping-boxes/:id/verify-package verifies; wrong box 404; missing package_id 400", async () => {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('pi','po','p',4,4,'0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, created_at, updated_at)
      VALUES ('pp','pi','inventory_lot','lot',4,'box','0','0');
    INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES ('mt','po','pending','0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box2','po','open','0','0');
  `);
  const ok = await app.request("/shipping-boxes/box/verify-package", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ package_id: "pp" }),
  });
  assert.equal(ok.status, 200);
  assert.equal((sqlite.prepare("SELECT verified FROM picking_packages WHERE id='pp'").get() as any).verified, 1);

  const wrong = await app.request("/shipping-boxes/box2/verify-package", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ package_id: "pp" }),
  });
  assert.equal(wrong.status, 404);
  const bad = await app.request("/shipping-boxes/box/verify-package", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400);
});
```

- [ ] **Step 7: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/measure.ts apps/api/src/db/measure.test.ts apps/api/src/routes/boxes.ts apps/api/src/routes/boxes.test.ts packages/shared/src/index.ts
git commit -m "feat(api): verify package in shipping box (Plan 5 task 2)"
```

---

### Task 3: Close a box (`closeShippingBox` + `POST /shipping-boxes/:id/close`)

**Files:**
- Modify: `apps/api/src/db/measure.ts` (add `closeShippingBox`)
- Modify: `apps/api/src/routes/boxes.ts` (add route)
- Test: append to `apps/api/src/db/measure.test.ts` + `apps/api/src/routes/boxes.test.ts`

- [ ] **Step 1: Append failing tests** to `apps/api/src/db/measure.test.ts`

```ts
function seedClosableBox(sqlite: any) {
  seedPackableBox(sqlite); // part, item (qty4/picked4), package pp (verified 0) in 'box', measuring task pending
  sqlite.exec(`UPDATE picking_packages SET verified=1;
               UPDATE shipping_boxes SET box_size='S', net_weight_g=500, gross_weight_g=800, destination_country=NULL;`);
}

test("closeShippingBox closes a fully-verified measured box and persists the destination fallback", () => {
  const { sqlite, db } = makeDb();
  seedClosableBox(sqlite);
  db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box", actorId: "u1" }));
  const b = sqlite.prepare("SELECT status, destination_country FROM shipping_boxes WHERE id='box'").get() as any;
  assert.deepEqual(b, { status: "closed", destination_country: "HK" }); // fell back to picking_orders.destination_country
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shipping_box' AND to_status='closed'").get() as any).c, 1);
  assertInvariantsHold(db);
  sqlite.close();
});

test("close guards: 404 missing, 409 not open, 409 empty, 409 unverified package, 409 missing measurements, 409 bad weights, 409 no destination", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "nope" })), (e: any) => e.status === 404);

  seedClosableBox(sqlite);
  sqlite.prepare("UPDATE picking_orders SET destination_country=NULL, ship_to=NULL").run();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // no destination anywhere
  sqlite.prepare("UPDATE picking_orders SET destination_country='HK'").run();

  sqlite.prepare("UPDATE shipping_boxes SET net_weight_g=NULL").run();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // weights required
  sqlite.prepare("UPDATE shipping_boxes SET net_weight_g=900").run(); // net 900 > gross 800
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE shipping_boxes SET net_weight_g=0").run();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // must be > 0
  sqlite.prepare("UPDATE shipping_boxes SET net_weight_g=500").run();

  sqlite.prepare("UPDATE picking_packages SET verified=0").run();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409); // unverified package
  sqlite.prepare("UPDATE picking_packages SET verified=1").run();

  // empty box
  sqlite.exec(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('boxE','po','open','0','0')`);
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "boxE" })), (e: any) => e.status === 409);

  // not open
  sqlite.prepare("UPDATE shipping_boxes SET status='closed' WHERE id='box'").run();
  assert.throws(() => db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  sqlite.close();
});
```

(`closeShippingBox` must be added to the `./measure.js` import.)

- [ ] **Step 2: Run tests to verify they fail** (not exported).

- [ ] **Step 3: Implement** in `apps/api/src/db/measure.ts` (append)

```ts
export function closeShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): void {
  const box = loadBox(tx, a.shippingBoxId);
  if (box.status !== "open") throw new HTTPException(409, { message: "box is not open" });
  const pkgs = tx.all<{ id: string; verified: number }>(
    sql`SELECT id, verified FROM picking_packages WHERE shipping_box_id = ${box.id}`
  );
  if (pkgs.length === 0) throw new HTTPException(409, { message: "cannot close an empty box" });
  if (pkgs.some((p) => !p.verified)) throw new HTTPException(409, { message: "all packages must be verified" });

  let dest = box.destinationCountry;
  if (dest === null || dest.trim() === "") {
    const order = tx.get<{ dc: string | null; st: string | null }>(
      sql`SELECT destination_country AS dc, ship_to AS st FROM picking_orders WHERE id = ${box.pickingOrderId}`
    );
    dest = order?.dc && order.dc.trim() !== "" ? order.dc : order?.st ?? null;
  }
  if (dest === null || dest.trim() === "") throw new HTTPException(409, { message: "destination is required" });
  if (box.boxSize === null || box.boxSize.trim() === "") throw new HTTPException(409, { message: "box_size is required" });
  if (box.netWeightG === null || box.grossWeightG === null) throw new HTTPException(409, { message: "weights are required" });
  if (box.netWeightG <= 0 || box.grossWeightG <= 0) throw new HTTPException(409, { message: "weights must be greater than zero" });
  if (box.grossWeightG < box.netWeightG) throw new HTTPException(409, { message: "gross weight must be >= net weight" });

  tx.run(sql`UPDATE shipping_boxes SET status = 'closed', destination_country = ${dest}, updated_at = ${now()} WHERE id = ${box.id}`);
  logTransition(tx, { entityType: "shipping_box", entityId: box.id, fromStatus: "open", toStatus: "closed", actorId: a.actorId ?? null });
}
```

- [ ] **Step 4: Add the route** to `apps/api/src/routes/boxes.ts` (append; import `closeShippingBox`)

```ts
boxesRoute.post("/shipping-boxes/:id/close", (c) => {
  const boxId = c.req.param("id");
  db.transaction((tx) => closeShippingBox(tx, { shippingBoxId: boxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});
```

- [ ] **Step 5: Append route test** to `apps/api/src/routes/boxes.test.ts` (before `cleanup`)

```ts
test("POST /shipping-boxes/:id/close closes a ready box; 409 when unverified", async () => {
  // 'box' already has verified package + measurements from earlier tests? NO — do not rely on cross-test state:
  // seed a second self-contained box for this test.
  sqlite.exec(`
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('piC','po','p',2,2,'0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, box_size, net_weight_g, gross_weight_g, destination_country, created_at, updated_at)
      VALUES ('boxC','po','open','M',100,200,'HK','0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, verified, created_at, updated_at)
      VALUES ('ppC','piC','inventory_lot','lot',2,'boxC',1,'0','0');
  `);
  const ok = await app.request("/shipping-boxes/boxC/close", { method: "POST" });
  assert.equal(ok.status, 200);
  assert.equal((sqlite.prepare("SELECT status FROM shipping_boxes WHERE id='boxC'").get() as any).status, "closed");

  sqlite.exec(`INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('boxU','po','open','0','0');
               INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, verified, created_at, updated_at)
                 VALUES ('ppU','piC','inventory_lot','lot',1,'boxU',0,'0','0');`);
  const bad = await app.request("/shipping-boxes/boxU/close", { method: "POST" });
  assert.equal(bad.status, 409);
});
```

- [ ] **Step 6: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/measure.ts apps/api/src/db/measure.test.ts apps/api/src/routes/boxes.ts apps/api/src/routes/boxes.test.ts
git commit -m "feat(api): close shipping box (Plan 5 task 3)"
```

---

### Task 4: Complete measuring task → auto-create pre-shipment verification task

**Files:**
- Modify: `apps/api/src/db/measure.ts` (add `completeMeasuringTask`)
- Modify: `apps/api/src/routes/measuring.ts` (add `POST /measuring-tasks/:id/complete`)
- Modify: `apps/api/src/db/tables.ts` (add unique backstop index)
- Test: `apps/api/src/db/verify.test.ts` (new) + extend `apps/api/src/routes/measuring.test.ts`

- [ ] **Step 1: Write the failing test** `apps/api/src/db/verify.test.ts`

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
import { completeMeasuringTask } from "./measure.js";
import { assertInvariantsHold } from "./invariants.guard.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-api-"));
  const { sqlite } = createDb(path.join(dir, "t.sqlite"));
  createTables(sqlite);
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','finished','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('pi','po','p',4,4,'0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','closed','0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, verified, created_at, updated_at)
      VALUES ('pp','pi','inventory_lot','lot',4,'box',1,'0','0');
    INSERT INTO measuring_tasks (id, picking_order_id, status, created_at, updated_at) VALUES ('mt','po','pending','0','0');
  `);
  return { sqlite, db };
}

test("completeMeasuringTask completes the task and creates a pre_shipment verification task", () => {
  const { sqlite, db } = makeDb();
  db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: "mt", actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT status FROM measuring_tasks WHERE id='mt'").get() as any).status, "completed");
  const vts = sqlite.prepare("SELECT kind, status, picking_order_id FROM verification_tasks").all() as any[];
  assert.deepEqual(vts, [{ kind: "pre_shipment", status: "pending", picking_order_id: "po" }]);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='measuring_task' AND to_status='completed'").get() as any).c, 1);
  assertInvariantsHold(db);

  // a second completion attempt is 409 (no longer pending) and still only one verification task
  assert.throws(() => db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: "mt" })), (e: any) => e.status === 409);
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM verification_tasks").get() as any).c, 1);
  sqlite.close();
});

test("completeMeasuringTask guards: 404 missing, 409 open box, 409 under-packed item", () => {
  const { sqlite, db } = makeDb();
  assert.throws(() => db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: "nope" })), (e: any) => e.status === 404);
  sqlite.prepare("UPDATE shipping_boxes SET status='open'").run();
  assert.throws(() => db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: "mt" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE shipping_boxes SET status='closed'").run();
  sqlite.prepare("UPDATE picking_packages SET qty=3").run(); // packed 3 != picked 4
  assert.throws(() => db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: "mt" })), (e: any) => e.status === 409);
  sqlite.close();
});
```

- [ ] **Step 2: Run test to verify it fails** (not exported).

- [ ] **Step 3: Implement** in `apps/api/src/db/measure.ts` (append)

```ts
export function completeMeasuringTask(tx: DbOrTx, a: { measuringTaskId: string; actorId?: string | null }): void {
  const task = tx.get<{ id: string; pickingOrderId: string; status: string }>(
    sql`SELECT id, picking_order_id AS pickingOrderId, status FROM measuring_tasks WHERE id = ${a.measuringTaskId}`
  );
  if (!task) throw new HTTPException(404, { message: "measuring task not found" });
  if (task.status !== "pending") throw new HTTPException(409, { message: "measuring task is not pending" });

  const openBox = tx.get<{ id: string }>(
    sql`SELECT id FROM shipping_boxes WHERE picking_order_id = ${task.pickingOrderId} AND status != 'closed' LIMIT 1`
  );
  if (openBox) throw new HTTPException(409, { message: "all shipping boxes must be closed" });

  const perItem = tx.all<{ picked: number; packed: number }>(
    sql`SELECT pi.picked_qty AS picked,
               COALESCE((SELECT SUM(pp.qty) FROM picking_packages pp
                         WHERE pp.picking_item_id = pi.id AND pp.shipping_box_id IS NOT NULL), 0) AS packed
        FROM picking_items pi WHERE pi.picking_order_id = ${task.pickingOrderId}`
  );
  if (perItem.some((r) => r.packed !== r.picked)) throw new HTTPException(409, { message: "picking item not fully packed" });

  tx.run(sql`UPDATE measuring_tasks SET status = 'completed', updated_at = ${now()} WHERE id = ${task.id}`);
  logTransition(tx, { entityType: "measuring_task", entityId: task.id, fromStatus: "pending", toStatus: "completed", actorId: a.actorId ?? null });

  // spec §10: measuring completed -> pre_shipment verification task (idempotent; unique index in tables.ts is the backstop)
  const existing = tx.get<{ id: string }>(
    sql`SELECT id FROM verification_tasks WHERE kind = 'pre_shipment' AND picking_order_id = ${task.pickingOrderId} AND status = 'pending'`
  );
  if (!existing) {
    tx.run(
      sql`INSERT INTO verification_tasks (id, kind, status, picking_order_id, created_at, updated_at)
          VALUES (${crypto.randomUUID()}, 'pre_shipment', 'pending', ${task.pickingOrderId}, ${now()}, ${now()})`
    );
  }
}
```

- [ ] **Step 4: Add the backstop index** to `apps/api/src/db/tables.ts`, right after the existing `verification_tasks` indexes:

```ts
CREATE UNIQUE INDEX IF NOT EXISTS verification_tasks_preship_pending_uq ON verification_tasks(picking_order_id) WHERE kind='pre_shipment' AND status='pending';
```

(Confirm the surrounding lines use `sqlite.exec(`...`)`-style strings and match that style. This index is safe on existing dev DBs — `CREATE INDEX IF NOT EXISTS` runs on every boot.)

- [ ] **Step 5: Add the route** to `apps/api/src/routes/measuring.ts` (append; keep the existing list route)

```ts
measuringRoute.post("/measuring-tasks/:id/complete", (c) => {
  const taskId = c.req.param("id");
  db.transaction((tx) => completeMeasuringTask(tx, { measuringTaskId: taskId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});
```

(`completeMeasuringTask` imported from `../db/measure.js`; `HTTPException` import only if needed elsewhere in the file.)

- [ ] **Step 6: Append route test** to `apps/api/src/routes/measuring.test.ts` (before `cleanup`)

```ts
test("POST /measuring-tasks/:id/complete completes and creates pre_shipment task; 404 missing", async () => {
  sqlite.exec(`
    INSERT INTO parts (id, part_no, part_no_norm, created_at, updated_at) VALUES ('p','X','X','0','0');
    INSERT INTO picking_items (id, picking_order_id, part_id, qty, picked_qty, created_at, updated_at) VALUES ('pi','po','p',4,4,'0','0');
    INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','closed','0','0');
    INSERT INTO picking_packages (id, picking_item_id, source_type, source_id, qty, shipping_box_id, verified, created_at, updated_at)
      VALUES ('pp','pi','inventory_lot','lot',4,'box',1,'0','0');
  `);
  // the existing measuring.test.ts seed already created order 'po' + task 'mt' (status pending) in its first test
  const ok = await app.request("/measuring-tasks/mt/complete", { method: "POST" });
  assert.equal(ok.status, 200);
  assert.equal((sqlite.prepare("SELECT status FROM measuring_tasks WHERE id='mt'").get() as any).status, "completed");
  const vts = sqlite.prepare("SELECT kind, status FROM verification_tasks WHERE picking_order_id='po'").all() as any[];
  assert.deepEqual(vts, [{ kind: "pre_shipment", status: "pending" }]);
  const missing = await app.request("/measuring-tasks/nope/complete", { method: "POST" });
  assert.equal(missing.status, 404);
});
```

IMPORTANT: read the existing `measuring.test.ts` first — its first test seeds order `po` (status `finished`) + task `mt` (pending). If that seed differs, adapt this test's seeds to the real state (the test needs: order po finished, item pi picked 4, one CLOSED box with a verified 4-qty package on pi, task mt pending). If relying on the other test's seed is fragile, seed everything this test needs with fresh ids and complete THAT task instead. Report what you chose.

- [ ] **Step 7: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/measure.ts apps/api/src/db/verify.test.ts apps/api/src/routes/measuring.ts apps/api/src/routes/measuring.test.ts apps/api/src/db/tables.ts
git commit -m "feat(api): complete measuring task -> pre_shipment verification task (Plan 5 task 4)"
```

---

### Task 5: Pre-shipment verify (box-level) + complete verification task

**Files:**
- Modify: `apps/api/src/db/measure.ts` (add `verifyShippingBox`, `completeVerificationTask`)
- Modify: `apps/api/src/routes/boxes.ts` (add `POST /shipping-boxes/:id/verify`)
- Create: `apps/api/src/routes/verification.ts` (`POST /verification-tasks/:id/complete` for now; T6 adds reads)
- Modify: `apps/api/src/index.ts` (mount `verificationRoute`)
- Test: append to `apps/api/src/db/verify.test.ts` + create `apps/api/src/routes/verification.test.ts`

- [ ] **Step 1: Append failing tests** to `apps/api/src/db/verify.test.ts`

```ts
function seedPreShipment(sqlite: any) {
  // measuring already completed; one closed box with a verified package; pending pre_shipment task
  sqlite.exec(`
    UPDATE measuring_tasks SET status='completed';
    INSERT INTO verification_tasks (id, kind, status, picking_order_id, created_at, updated_at) VALUES ('vt','pre_shipment','pending','po','0','0');
  `);
}

test("verifyShippingBox marks a closed box verified; completeVerificationTask completes when all boxes verified", () => {
  const { sqlite, db } = makeDb();
  seedPreShipment(sqlite);
  db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: "box", actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT status FROM shipping_boxes WHERE id='box'").get() as any).status, "verified");
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='shipping_box' AND to_status='verified'").get() as any).c, 1);

  db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: "vt", actorId: "u1" }));
  assert.equal((sqlite.prepare("SELECT status FROM verification_tasks WHERE id='vt'").get() as any).status, "completed");
  assert.equal((sqlite.prepare("SELECT COUNT(*) c FROM transition_logs WHERE entity_type='verification_task' AND to_status='completed'").get() as any).c, 1);
  assertInvariantsHold(db);
  sqlite.close();
});

test("verify/complete guards: box must be closed, task must be pending, all boxes verified before completion", () => {
  const { sqlite, db } = makeDb();
  seedPreShipment(sqlite);
  // box still open -> 409
  sqlite.prepare("UPDATE shipping_boxes SET status='open'").run();
  assert.throws(() => db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE shipping_boxes SET status='closed'").run();
  // unverified package -> 409
  sqlite.prepare("UPDATE picking_packages SET verified=0").run();
  assert.throws(() => db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  sqlite.prepare("UPDATE picking_packages SET verified=1").run();
  // complete before box verified -> 409
  assert.throws(() => db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: "vt" })), (e: any) => e.status === 409);
  // missing task -> 404; missing box -> 404
  assert.throws(() => db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: "nope" })), (e: any) => e.status === 404);
  assert.throws(() => db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: "nope" })), (e: any) => e.status === 404);
  // no pending pre_shipment task for the order -> 409
  sqlite.prepare("UPDATE verification_tasks SET status='completed'").run();
  assert.throws(() => db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: "box" })), (e: any) => e.status === 409);
  sqlite.close();
});
```

(`verifyShippingBox`, `completeVerificationTask` must be added to the `./measure.js` import.)

- [ ] **Step 2: Run tests to verify they fail** (not exported).

- [ ] **Step 3: Implement** in `apps/api/src/db/measure.ts` (append)

```ts
export function verifyShippingBox(tx: DbOrTx, a: { shippingBoxId: string; actorId?: string | null }): void {
  const box = loadBox(tx, a.shippingBoxId);
  if (box.status !== "closed") throw new HTTPException(409, { message: "box is not closed" });
  const task = tx.get<{ id: string }>(
    sql`SELECT id FROM verification_tasks
        WHERE kind = 'pre_shipment' AND picking_order_id = ${box.pickingOrderId} AND status = 'pending'`
  );
  if (!task) throw new HTTPException(409, { message: "no pending verification task for this order" });
  const unverified = tx.get<{ c: number }>(
    sql`SELECT COUNT(*) AS c FROM picking_packages WHERE shipping_box_id = ${box.id} AND verified = 0`
  )!;
  if (unverified.c > 0) throw new HTTPException(409, { message: "all packages must be verified" });

  tx.run(sql`UPDATE shipping_boxes SET status = 'verified', updated_at = ${now()} WHERE id = ${box.id}`);
  logTransition(tx, { entityType: "shipping_box", entityId: box.id, fromStatus: "closed", toStatus: "verified", actorId: a.actorId ?? null });
}

export function completeVerificationTask(tx: DbOrTx, a: { verificationTaskId: string; actorId?: string | null }): void {
  const task = tx.get<{ id: string; kind: string; status: string; pickingOrderId: string | null }>(
    sql`SELECT id, kind, status, picking_order_id AS pickingOrderId FROM verification_tasks WHERE id = ${a.verificationTaskId}`
  );
  if (!task) throw new HTTPException(404, { message: "verification task not found" });
  if (task.kind !== "pre_shipment") throw new HTTPException(409, { message: "only pre_shipment tasks can be completed here" });
  if (task.status !== "pending") throw new HTTPException(409, { message: "verification task is not pending" });
  const notVerified = tx.get<{ c: number }>(
    sql`SELECT COUNT(*) AS c FROM shipping_boxes WHERE picking_order_id = ${task.pickingOrderId} AND status != 'verified'`
  )!;
  if (notVerified.c > 0) throw new HTTPException(409, { message: "all shipping boxes must be verified" });

  tx.run(sql`UPDATE verification_tasks SET status = 'completed', updated_at = ${now()} WHERE id = ${task.id}`);
  logTransition(tx, { entityType: "verification_task", entityId: task.id, fromStatus: "pending", toStatus: "completed", actorId: a.actorId ?? null });
}
```

- [ ] **Step 4: Add the box route** to `apps/api/src/routes/boxes.ts` (append; import `verifyShippingBox`)

```ts
boxesRoute.post("/shipping-boxes/:id/verify", (c) => {
  const boxId = c.req.param("id");
  db.transaction((tx) => verifyShippingBox(tx, { shippingBoxId: boxId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});
```

- [ ] **Step 5: Create `apps/api/src/routes/verification.ts`** (complete route for now; T6 appends reads) and mount in `index.ts`

```ts
import { Hono } from "hono";
import { db } from "../db.js";
import { completeVerificationTask } from "../db/measure.js";

export const verificationRoute = new Hono();

verificationRoute.post("/verification-tasks/:id/complete", (c) => {
  const taskId = c.req.param("id");
  db.transaction((tx) => completeVerificationTask(tx, { verificationTaskId: taskId, actorId: c.req.query("actor_id") ?? null }));
  return c.json({ ok: true }, 200);
});
```

```ts
// apps/api/src/index.ts additions
import { verificationRoute } from "./routes/verification.js";
app.route("/", verificationRoute);
```

- [ ] **Step 6: Write the failing route test** `apps/api/src/routes/verification.test.ts`, run, watch fail, then re-run after steps 3–5

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
  INSERT INTO picking_orders (id, external_id, ref_no, status, created_at, updated_at) VALUES ('po','e','R','finished','0','0');
  INSERT INTO shipping_boxes (id, picking_order_id, status, created_at, updated_at) VALUES ('box','po','closed','0','0');
  INSERT INTO verification_tasks (id, kind, status, picking_order_id, created_at, updated_at) VALUES ('vt','pre_shipment','pending','po','0','0');
`);

test("POST /shipping-boxes/:id/verify then POST /verification-tasks/:id/complete", async () => {
  const v = await app.request("/shipping-boxes/box/verify", { method: "POST" });
  assert.equal(v.status, 200);
  assert.equal((sqlite.prepare("SELECT status FROM shipping_boxes WHERE id='box'").get() as any).status, "verified");
  const c = await app.request("/verification-tasks/vt/complete", { method: "POST" });
  assert.equal(c.status, 200);
  assert.equal((sqlite.prepare("SELECT status FROM verification_tasks WHERE id='vt'").get() as any).status, "completed");
  const again = await app.request("/verification-tasks/vt/complete", { method: "POST" });
  assert.equal(again.status, 409);
});

test("cleanup", () => { sqlite.close(); });
```

(The box has no packages in this seed — `verifyShippingBox`'s all-verified guard passes vacuously on an empty box; that is acceptable for this route-level smoke since `closeShippingBox` already forbids closing empty boxes. The db-level guard tests cover the unverified-package 409.)

- [ ] **Step 7: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/db/measure.ts apps/api/src/db/verify.test.ts apps/api/src/routes/boxes.ts apps/api/src/routes/verification.ts apps/api/src/routes/verification.test.ts apps/api/src/index.ts
git commit -m "feat(api): pre-shipment box verify + complete verification task (Plan 5 task 5)"
```

---

### Task 6: Read + polling endpoints (measuring detail, for-measuring box, verification list/detail, measuring totals)

**Files:**
- Modify: `apps/api/src/routes/measuring.ts` (extend list with totals; add `GET /measuring-tasks/:id`)
- Modify: `apps/api/src/routes/boxes.ts` (add `GET /shipping-boxes/:id/for-measuring`)
- Modify: `apps/api/src/routes/verification.ts` (add `GET /verification-tasks`, `GET /verification-tasks/:id`)
- Test: extend `apps/api/src/routes/measuring.test.ts`, `boxes.test.ts`, `verification.test.ts`

**Response shapes:**
```json
// GET /measuring-tasks  (extended — additive fields ref_no, total_items, packed_items)
[{ "id", "picking_order_id", "status", "created_at", "updated_at", "ref_no", "total_items", "packed_items" }]

// GET /measuring-tasks/:id
{ "task": { "id", "picking_order_id", "status", "created_at", "updated_at" },
  "order": { "id", "external_id", "ref_no", "status", "ship_to", "destination_country", "created_at", "updated_at" },
  "items": [{ "id", "part_id", "part_no", "qty", "picked_qty", "scanned_not_boxed_qty", "remaining_qty", "allocated_qty", "line_id" }],
  "boxes": [{ "id", "status", "box_size", "net_weight_g", "gross_weight_g", "destination_country", "created_at", "updated_at",
    "packages": [{ "id", "picking_item_id", "part_no", "source_type", "source_id", "qty", "date_code", "lot_code", "coo", "cow", "verified" }] }] }

// GET /shipping-boxes/:id/for-measuring
{ "box": { "id", "picking_order_id", "status", "box_size", "net_weight_g", "gross_weight_g", "destination_country", "created_at", "updated_at" },
  "order": { "id", "ref_no", "ship_to", "destination_country", "status" },
  "task": { "id", "status" } | null,
  "packages": [{ "id", "picking_item_id", "part_no", "qty", "date_code", "lot_code", "coo", "cow", "verified" }] }

// GET /verification-tasks?kind=&status=&since=
[{ "id", "kind", "status", "due_at", "picking_order_id", "shelf_box_id", "created_at", "updated_at" }]

// GET /verification-tasks/:id
{ "task": { "id", "kind", "status", "due_at", "picking_order_id", "shelf_box_id", "created_at", "updated_at" },
  "order": { ... } | null,
  "boxes": [{ ...box fields..., "packages": [...] }] }
```

- [ ] **Step 1: Append failing tests.** To `apps/api/src/routes/measuring.test.ts` (before `cleanup`):

```ts
test("GET /measuring-tasks/:id returns task detail with boxes and packages", async () => {
  const res = await app.request("/measuring-tasks/mt");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;
  assert.equal(d.task.picking_order_id, "po");
  assert.equal(d.order.ref_no, "R");
  assert.equal(d.items.length, 1);
  assert.equal(d.boxes.length, 1);
  assert.equal(d.boxes[0].packages[0].part_no, "X");
  assert.equal(d.boxes[0].packages[0].verified, 1);
  const missing = await app.request("/measuring-tasks/nope");
  assert.equal(missing.status, 404);
});

test("GET /measuring-tasks includes totals", async () => {
  const res = await app.request("/measuring-tasks");
  const rows = (await res.json()) as any[];
  const mt = rows.find((r: any) => r.id === "mt");
  assert.equal(mt.ref_no, "R");
  assert.equal(mt.total_items, 4);
  assert.equal(mt.packed_items, 4);
});
```

(These assume the file's earlier tests seeded: order `po` ref `R` with task `mt`, item `pi` qty 4 / picked 4, closed box with verified 4-qty package on part `X` — verify against the file's actual accumulated state, including the Task-4 test which completed `mt`. If `mt` is completed by then, the detail test still works (detail is status-agnostic), but `GET /measuring-tasks` default (no status filter) returns it too — adjust `mt` lookups accordingly. If the state is too tangled, seed a fresh `poD`/`piD`/`boxD`/`mtD` set inside these tests and request those ids. Report the choice.)

To `apps/api/src/routes/boxes.test.ts` (before `cleanup`):

```ts
test("GET /shipping-boxes/:id/for-measuring returns box, order, task, packages", async () => {
  // 'box' (from file seed) belongs to 'po' which has measuring task 'mt' (seeded by the verify-package test); packages on 'box' vary — assert shape, not counts
  const res = await app.request("/shipping-boxes/box/for-measuring");
  assert.equal(res.status, 200);
  const d = (await res.json()) as any;
  assert.equal(d.box.picking_order_id, "po");
  assert.equal(d.order.ref_no, "R");
  assert.ok(Array.isArray(d.packages));
  const missing = await app.request("/shipping-boxes/nope/for-measuring");
  assert.equal(missing.status, 404);
});
```

To `apps/api/src/routes/verification.test.ts` (before `cleanup`):

```ts
test("GET /verification-tasks filters by kind/status/since; GET /:id returns detail", async () => {
  const all = await app.request("/verification-tasks");
  assert.equal(all.status, 200);
  assert.equal(((await all.json()) as any[]).length >= 1, true);
  const pre = await app.request("/verification-tasks?kind=pre_shipment");
  assert.equal(((await pre.json()) as any[]).every((t: any) => t.kind === "pre_shipment"), true);
  const future = await app.request("/verification-tasks?since=2999-01-01T00:00:00.000Z");
  assert.deepEqual(await future.json(), []);

  const d = await app.request("/verification-tasks/vt");
  assert.equal(d.status, 200);
  const detail = (await d.json()) as any;
  assert.equal(detail.task.kind, "pre_shipment");
  assert.equal(detail.order.ref_no, "R");
  assert.equal(detail.boxes.length, 1);
  const missing = await app.request("/verification-tasks/nope");
  assert.equal(missing.status, 404);
});
```

- [ ] **Step 2: Run tests to verify they fail** (routes not found / missing fields).

- [ ] **Step 3: Implement the reads.**

In `apps/api/src/routes/measuring.ts` — replace the existing list route's query with the totals version, and add the detail route:

```ts
measuringRoute.get("/measuring-tasks", (c) => {
  const status = c.req.query("status");
  const since = c.req.query("since");
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT mt.id, mt.picking_order_id, mt.status, mt.created_at, mt.updated_at, po.ref_no,
      (SELECT COALESCE(SUM(qty), 0) FROM picking_items WHERE picking_order_id = mt.picking_order_id) AS total_items,
      (SELECT COALESCE(SUM(pp.qty), 0) FROM picking_packages pp
        WHERE pp.shipping_box_id IS NOT NULL
          AND pp.picking_item_id IN (SELECT id FROM picking_items WHERE picking_order_id = mt.picking_order_id)) AS packed_items
    FROM measuring_tasks mt JOIN picking_orders po ON po.id = mt.picking_order_id
    WHERE (${status ?? null} IS NULL OR mt.status = ${status ?? null})
      AND (${since ?? null} IS NULL OR mt.updated_at > ${since ?? null})
    ORDER BY mt.updated_at ASC, mt.id ASC LIMIT 200`);
  return c.json(rows, 200);
});

measuringRoute.get("/measuring-tasks/:id", (c) => {
  const taskId = c.req.param("id");
  const task = db.get<Record<string, unknown>>(sql`
    SELECT id, picking_order_id, status, created_at, updated_at FROM measuring_tasks WHERE id = ${taskId}`);
  if (!task) throw new HTTPException(404, { message: "measuring task not found" });
  const orderId = task.picking_order_id as string;
  const order = db.get<Record<string, unknown>>(sql`
    SELECT id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at
    FROM picking_orders WHERE id = ${orderId}`);
  const items = db.all<Record<string, unknown>>(sql`
    SELECT pi.id, pi.part_id, p.part_no, pi.qty, pi.picked_qty, pi.scanned_not_boxed_qty,
           pi.remaining_qty, pi.allocated_qty, pi.line_id
    FROM picking_items pi JOIN parts p ON p.id = pi.part_id
    WHERE pi.picking_order_id = ${orderId} ORDER BY pi.created_at ASC, pi.id ASC`);
  const boxes = db.all<Record<string, unknown>>(sql`
    SELECT id, status, box_size, net_weight_g, gross_weight_g, destination_country, created_at, updated_at
    FROM shipping_boxes WHERE picking_order_id = ${orderId} ORDER BY created_at ASC, id ASC`);
  for (const b of boxes) {
    b.packages = db.all<Record<string, unknown>>(sql`
      SELECT pp.id, pp.picking_item_id, p.part_no, pp.source_type, pp.source_id, pp.qty,
             pp.date_code, pp.lot_code, pp.coo, pp.cow, pp.verified
      FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id JOIN parts p ON p.id = pi.part_id
      WHERE pp.shipping_box_id = ${b.id} ORDER BY pp.created_at ASC, pp.id ASC`);
  }
  return c.json({ task, order, items, boxes }, 200);
});
```

(`HTTPException` and `sql` imports as needed; the detail route needs order to exist — FK guarantees it, `db.get` may still return undefined in a corrupt DB, which would 500; acceptable, boxes query tolerates it.)

In `apps/api/src/routes/boxes.ts` — append the for-measuring route:

```ts
boxesRoute.get("/shipping-boxes/:id/for-measuring", (c) => {
  const boxId = c.req.param("id");
  const box = db.get<Record<string, unknown>>(sql`
    SELECT id, picking_order_id, status, box_size, net_weight_g, gross_weight_g, destination_country, created_at, updated_at
    FROM shipping_boxes WHERE id = ${boxId}`);
  if (!box) throw new HTTPException(404, { message: "shipping box not found" });
  const order = db.get<Record<string, unknown>>(sql`
    SELECT id, ref_no, ship_to, destination_country, status FROM picking_orders WHERE id = ${box.picking_order_id}`);
  const task = db.get<Record<string, unknown>>(sql`
    SELECT id, status FROM measuring_tasks WHERE picking_order_id = ${box.picking_order_id}`) ?? null;
  const packages = db.all<Record<string, unknown>>(sql`
    SELECT pp.id, pp.picking_item_id, p.part_no, pp.qty, pp.date_code, pp.lot_code, pp.coo, pp.cow, pp.verified
    FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id JOIN parts p ON p.id = pi.part_id
    WHERE pp.shipping_box_id = ${boxId} ORDER BY pp.created_at ASC, pp.id ASC`);
  return c.json({ box, order, task, packages }, 200);
});
```

In `apps/api/src/routes/verification.ts` — append the two reads:

```ts
verificationRoute.get("/verification-tasks", (c) => {
  const kind = c.req.query("kind");
  const status = c.req.query("status");
  const since = c.req.query("since");
  const rows = db.all<Record<string, unknown>>(sql`
    SELECT id, kind, status, due_at, picking_order_id, shelf_box_id, created_at, updated_at
    FROM verification_tasks
    WHERE (${kind ?? null} IS NULL OR kind = ${kind ?? null})
      AND (${status ?? null} IS NULL OR status = ${status ?? null})
      AND (${since ?? null} IS NULL OR updated_at > ${since ?? null})
    ORDER BY updated_at ASC, id ASC LIMIT 200`);
  return c.json(rows, 200);
});

verificationRoute.get("/verification-tasks/:id", (c) => {
  const taskId = c.req.param("id");
  const task = db.get<Record<string, unknown>>(sql`
    SELECT id, kind, status, due_at, picking_order_id, shelf_box_id, created_at, updated_at
    FROM verification_tasks WHERE id = ${taskId}`);
  if (!task) throw new HTTPException(404, { message: "verification task not found" });
  const order = task.picking_order_id
    ? db.get<Record<string, unknown>>(sql`
        SELECT id, external_id, ref_no, status, ship_to, destination_country, created_at, updated_at
        FROM picking_orders WHERE id = ${task.picking_order_id}`) ?? null
    : null;
  const boxes = task.picking_order_id
    ? db.all<Record<string, unknown>>(sql`
        SELECT id, status, box_size, net_weight_g, gross_weight_g, destination_country, created_at, updated_at
        FROM shipping_boxes WHERE picking_order_id = ${task.picking_order_id} ORDER BY created_at ASC, id ASC`)
    : [];
  for (const b of boxes) {
    b.packages = db.all<Record<string, unknown>>(sql`
      SELECT pp.id, pp.picking_item_id, p.part_no, pp.qty, pp.date_code, pp.lot_code, pp.coo, pp.cow, pp.verified
      FROM picking_packages pp JOIN picking_items pi ON pi.id = pp.picking_item_id JOIN parts p ON p.id = pi.part_id
      WHERE pp.shipping_box_id = ${b.id} ORDER BY pp.created_at ASC, pp.id ASC`);
  }
  return c.json({ task, order, boxes }, 200);
});
```

(`sql` + `HTTPException` imports must be added to verification.ts.)

- [ ] **Step 4: Run the FULL suite — expect PASS, then build.** Commit:
```bash
git add apps/api/src/routes/measuring.ts apps/api/src/routes/boxes.ts apps/api/src/routes/verification.ts apps/api/src/routes/measuring.test.ts apps/api/src/routes/boxes.test.ts apps/api/src/routes/verification.test.ts
git commit -m "feat(api): measuring/verification read + polling endpoints (Plan 5 task 6)"
```

---

### Task 7: Final verification gate

- [ ] **Step 1: Type build clean** — `cmd.exe //c "pnpm --filter @warehouse/api build"` → exit 0.
- [ ] **Step 2: Full suite green** — `cmd.exe //c "pnpm --filter @warehouse/api test"` → record the pass count for the docs commit.

- [ ] **Step 3: Live curl smoke of the full outbound flow** (isolated temp DB + dedicated port, kill the server + delete the temp DB after; do NOT touch `apps/api/dev.sqlite`):
```bash
# [Plan 3] PUT receiving (qty 100) -> confirm-arrival -> PUT picking (qty 40)
# [Plan 4] GET /picking-orders/<po> -> allocation; scan 40; create box; pack -> finished
# [Plan 5] GET /measuring-tasks?status=pending                       -> exactly one task, total_items 40, packed_items 40
#          GET /shipping-boxes/<box>/for-measuring                    -> capture package id
#          POST /shipping-boxes/<box>/verify-package {package_id}     -> 200
#          PATCH /shipping-boxes/<box> {box_size, net 500, gross 800} -> 200 (destination falls back from order)
#          POST /shipping-boxes/<box>/close                           -> 200, box closed
#          POST /measuring-tasks/<mt>/complete                        -> 200
#          GET /verification-tasks?kind=pre_shipment&status=pending   -> exactly one task
#          POST /shipping-boxes/<box>/verify                          -> 200, box verified
#          POST /verification-tasks/<vt>/complete                     -> 200
```
Expected in the temp sqlite: `measuring_tasks.status='completed'`, `verification_tasks.status='completed'`, `shipping_boxes.status='verified'` with `destination_country` populated, `picking_packages.verified=1`, and transition_logs containing `shipping_box open->closed`, `shipping_box closed->verified`, `measuring_task ...->completed`, `verification_task ...->completed`.

- [ ] **Step 4: Update docs registry** — `docs/app-docs/ai/feature-registry.md` + `docs/app-docs/ai/code-map.md`: add the Plan 5 endpoints (PATCH/close/verify/verify-package/for-measuring on `/shipping-boxes`, measuring detail + complete, verification list/detail/complete) and files (`apps/api/src/db/measure.ts`, `routes/boxes.ts`, `routes/verification.ts`). Update `docs/app-docs/flows/measuring/ai-scope.md` (measuring execution now lives in the API; box `closed` semantics; auto-created pre_shipment task). Check `docs/app-docs/flows/` for a verification/goods-verify flow dir — update or create its `ai-scope.md` per `docs/app-docs/ai/scope-remark-template.md` if a flow doc exists for it; note that pre_shipment verify is box-level (`closed → verified`) and cycle-count is still pending (Plan 6). Follow each file's existing format; do not duplicate README/AGENTS content — link.

- [ ] **Step 5: Commit docs**
```bash
git add docs/app-docs/ai/feature-registry.md docs/app-docs/ai/code-map.md docs/app-docs/flows
git commit -m "docs(api): register measuring + verification endpoints (Plan 5 task 7, NN/NN tests)"
```

---

## Self-review (run after drafting — already applied)

- **Spec coverage:** verify package in box w/ guards (T2, web `verifyPickingPackageForMeasuring` ported) ✓; measurements update w/ normalization (T1, web `updateShippingBox`) ✓; close box w/ full measurement validation (T3, web `closeShippingBox`) ✓; complete measuring → pre_shipment task (T4, spec §10) ✓; box-level pre_shipment verify `closed→verified` (T5, user-confirmed semantics, spec §13) ✓; verification complete (T5) ✓; polling list endpoints with `since` watermark + totals (T6, spec §11) ✓; measuring/for-measuring/verification detail reads (T6, endpoints spec §7) ✓; transition logs on every state change ✓; cycle-count + put-away + receiving `clear` explicitly deferred to Plan 6 ✓.
- **Placeholder scan:** none — every step carries full code.
- **Type consistency:** snake_case request bodies (superseding the 2026-07-07 camelCase sketch); `{ ok: true }` action responses; 201 only where a resource is created (none here — all actions are state transitions, so 200 everywhere); `verified` INTEGER 0/1 handled as numbers.
- **Invariants:** Plan 5 performs no stock-qty mutations — `assertInvariantsHold` still closes every state-changing test as the regression backstop; the only new index (`verification_tasks_preship_pending_uq`) is additive and idempotent on boot.
- **Guard parity:** every route that takes a `:id` scoped to a parent verifies ownership inside its tx (verify-package checks package∈box; the rest resolve through the box/task's own order — no cross-order mutation possible).
- **Open flags for the user:** (1) measurement edits blocked after close (stricter than web); (2) destination fallback persists `order.destination_country ?? order.ship_to` into the box at close; (3) `POST /verification-tasks/:id/complete` rejects cycle-count tasks until Plan 6.
