# Frontend API Adapter (Plan 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `api` warehouse adapter (and `apiAuth`) so the Nuxt web app runs entirely on the Hono API, flip the default adapter off PGlite, and delete the remaining direct-database bypasses — with zero changes to page/component code beyond the bypass sites.

**Architecture:** A thin HTTP client (`services/apiClient.ts`) wraps `$fetch` with the configured API base URL, snake_case request bodies, and error mapping (HTTP status + plain-text body → `I18nError`-compatible thrown errors). `services/adapters/apiWarehouse.ts` implements all 51 `WarehouseService` methods as endpoint calls + snake_case→camelCase DTO mapping; `services/adapters/apiAuth.ts` does the same for auth. The three direct-db bypasses (`useScanMatchers`, `useLabelScan`, `AppHeader` reset) move onto new service methods/endpoints. The PGlite plugin becomes conditional so the app boots without a database when the adapter is `api`.

**Tech Stack:** Nuxt 3 (`ssr: false`), Vue 3, `$fetch` (ofetch), pnpm workspace (`@warehouse/web`, `@warehouse/shared`, `@warehouse/api`).

---

## Conventions (read first)

- **Shell:** prefix **every** pnpm command with `cmd.exe //c` (plain `pnpm` is broken here):
  - Web type check: `cmd.exe //c "pnpm --filter @warehouse/web exec nuxi typecheck"` (verify this script name in `apps/web/package.json` first; fall back to `pnpm --filter @warehouse/web exec vue-tsc --noEmit` if absent).
  - Web unit tests: `cmd.exe //c "pnpm --filter @warehouse/web test"` (vitest — check the script).
  - API tests/build (must stay green): `cmd.exe //c "pnpm --filter @warehouse/api test"` / `cmd.exe //c "pnpm --filter @warehouse/api build"`.
- **Commits:** commit directly to `master`, never push. Stage explicit paths only (`git add <paths>`, never `-A`); never stage pre-existing stray files (`apps/web/public/labels-data.json` M, `tmp_screencap_*.png` D, `apps/web/public/box-shelf-labels.pdf`, `apps/web/scripts/generate-box-shelf-labels-pdf.mjs`, `apps/web/utils/scroll.ts`, `ui.xml`–`ui5.xml`, `docs/superpowers/plans/2026-07-12-native-android-phase-1.md` untracked — the user's Android plan) and never stage anything under `apps/android/` (the user's parallel work).
- **Web import aliases:** `~/` = `apps/web/` root (match existing imports).
- **No page rewrites:** pages/components keep calling `useWarehouse()` / service methods with the same DTOs. All mapping lives in the adapter layer.
- **Error contract:** the API returns HTTP status + plain-text body (often the web's i18n error key as the message). The apiClient maps: body matching a known key pattern → thrown `Error` with that key as `message` (pages already i18n-error-key-aware); 401 → auth redirect behavior TBD per task; network failure → `Error('network_error')`.
- **Tests:** web adapter tests use vitest with a mocked `$fetch` (vi.mock or stub global) — assert URL + method + body + response mapping. No live API in unit tests. One integration smoke task runs the real API build against the adapter.

---

## Scope boundaries (decided — do not re-open)

- **IN (Plan 8):** `apiClient.ts` (native `fetch` wrapper + error mapping); `apiWarehouse.ts` (51 methods); `apiAuth.ts`; three new `WarehouseService` methods implemented on BOTH adapters (`getScanCandidates`, `getSupplierQrTemplates`, `resetDemoData`); bypass rewires in `useScanMatchers.ts`, `useLabelScan.ts`, `AppHeader.vue`; conditional PGlite boot; flip `warehouseAdapter` default to `api` + default `apiBaseUrl`; `markShelfBoxVerified` adapter-side mapping (find pending `cycle_count` verification task for the box → `POST /verification-tasks/:id/complete`); verification in browser + Capacitor sync. **Plus the small API additions enumerated below** — research proved they cannot be adapter-only.
- **OUT:** page/component UX changes (pages keep calling the service unchanged); deleting PGlite code (both adapters must keep working — pglite stays the offline/dev fallback); DTO relocation to `packages/shared` (REJECTED — 34 importers; `services/types.ts` stays the DTO home; the shared package header comment gets corrected); renaming the ocr-pick route (path `:id` is the receiving-order id — documented adapter-side).
- **DECIDED (API additions in Plan 8):** flat mutation routes so the adapter doesn't need parent-id discovery (`POST /allocations/:id/scan`, `POST /packages/:id/add-to-box`, `DELETE /packages/:id`, `POST /packages/:id/verify`, `POST /shipping-boxes/:id/cancel`); `confirm-arrival` accepts internal id OR external_id; `GET /picking-orders` gains `total_qty`; `GET /picking-orders/:id` gains issue fields + item date/shelf codes + package `created_at` + allocation remark/lot ids/receiving `ref_no` + measuring-task stub + issue-reporter name; `"other"` picking-issue reason; `recordPutAwayScan`/`createShelfBox` return the created row. All additive; no existing response keys change.
- **DECIDED (error contract):** no app-wide JSON error handler — the adapter maps plain-text bodies: i18n-key-shaped text → `I18nError(key)`; known English sentences → i18n keys via a mapping table; else `Error("<status>: <text>")`; network failure → `I18nError("network_error")` (locale key added if missing).
- **DECIDED (left as-is):** pure helpers stay put — `validateMismatchInputs` in `~/db/mismatch` (ReportIssueModal), `getIsoWeek` in `~/db/date` (utils/ids.ts). They don't touch PGlite. `db/ocrPicking.ts` stays (pglite adapter + its tests use it).
- **DECIDED (scan candidates):** `useScanMatchers` fetches the whole-order snapshot per scan via `warehouse.getScanCandidates(receivingOrderId)` and feeds the EXISTING (currently dead) map-consumption path; no caching (one GET per scan — always fresh); no page changes. The unused direct `findReceivingCandidates`/`findPickingCandidates` imports die with the rewire.
- **DECIDED (auth):** `apiAuth` implements the same 3-method interface; session persistence stays in `useAuth`/localStorage key `warehouse-user-id`; `AuthUser.name → User.displayName`; `User.createdAt` — grep usages, prefer widening the type to `Date | null` mapped as null over fabricating a timestamp. 401 → `I18nError("invalid_username_or_password")`.
- **DECIDED (units/dates):** API measuring weights are integer grams; web DTOs are kg — adapter converts (÷1000 read, ×1000 rounded write) and ports the web's `weight_must_be_number` validation. ISO strings → `new Date()` for `Date`-typed DTO fields; sqlite 0/1 → Boolean.

---

---

## File structure

**Create (web)**
- `apps/web/services/apiClient.ts` — `createApiClient({ baseUrl, getActorId })`: native `fetch` helpers (`get/post/patch/del`), snake_case JSON bodies, error mapping table → `I18nError` (T1).
- `apps/web/services/apiClient.test.ts` — vitest, stubbed `globalThis.fetch` (T1).
- `apps/web/services/adapters/apiWarehouse.test.ts` — adapter mapping tests per area, stubbed fetch (T4–T8).

**Modify (web)**
- `apps/web/services/adapters/apiWarehouse.ts` — full 51-method impl + 3 new methods (T4–T8).
- `apps/web/services/adapters/apiAuth.ts` — login/logout/getCurrentUser (T2).
- `apps/web/services/warehouse.ts` — interface += `getScanCandidates`, `getSupplierQrTemplates`, `resetDemoData` (T8).
- `apps/web/services/adapters/pgliteWarehouse.ts` — the 3 new methods delegating to existing db fns (T8).
- `apps/web/services/types.ts` — `User.createdAt` possibly widened to `Date | null` (T2); `ScanCandidatesSnapshot` type added (T8).
- `apps/web/composables/useScanMatchers.ts` — snapshot rewire, drop `useDb`/`~/db/ocrPicking` imports (T9).
- `apps/web/composables/useLabelScan.ts` — supplier templates via service (T9).
- `apps/web/components/AppHeader.vue` — reset via `resetDemoData()` (T9).
- `apps/web/plugins/pglite.client.ts` — early return when adapter !== 'pglite' (T10).
- `apps/web/nuxt.config.ts` — `warehouseAdapter: "api"`, `apiBaseUrl` default `http://localhost:3001` (T10).
- `packages/shared/src/index.ts` — header comment correction (T11).
- `AGENTS.md`, `docs/app-docs/ai/feature-registry.md`, `docs/app-docs/ai/code-map.md` (T11).

**Modify (api)** — additive only, with route tests:
- `apps/api/src/routes/pickingExecution.ts` — flat routes `POST /allocations/:id/scan`, `POST /packages/:id/add-to-box`, `DELETE /packages/:id`, `POST /packages/:id/verify`, `POST /shipping-boxes/:id/cancel`; extend `GET /picking-orders` (+`total_qty`) and `GET /picking-orders/:id` (issue fields, item date/shelf codes, package `created_at`, allocation remark/lot ids/receiving `ref_no`, measuring-task stub, issue-reporter name) (T3a/T3b).
- `apps/api/src/routes/receiving.ts` — confirm-arrival matches internal id OR external_id (T3a).
- `apps/api/src/routes/picking.ts` + `apps/api/src/db/pickingIssues.ts` — `"other"` reason (T3a).
- `apps/api/src/db/putAway.ts` + `apps/api/src/routes/putAway.ts` — `recordPutAwayScan`/`createShelfBox` return the created row (T3a).

**Tests (api):** extend `apps/api/src/routes/pickingExecution.test.ts`, `apps/api/src/routes/picking.test.ts`, `apps/api/src/routes/putAway.test.ts`, `apps/api/src/routes/receivingRead.test.ts` (T3a/T3b).

---

### Task 1: `apiClient` — fetch wrapper + error mapping

**Files:**
- Create: `apps/web/services/apiClient.ts`
- Test: `apps/web/services/apiClient.test.ts`

**Design:** `createApiClient({ baseUrl, getActorId })` returns `{ get, post, patch, del, actorId }`. Uses **native `fetch`** (no ofetch dep — pnpm-strict; works in vitest/browser/Capacitor). `baseUrl` trimmed of trailing `/`; paths start with `/`. Bodies: JSON snake_case (callers pass snake_case already). Query params via `URLSearchParams` (skip undefined/null). Responses: `res.json()` on 2xx (204 → undefined).

**Error mapping (on `!res.ok`):** read `await res.text()`; then:
1. If text matches `/^[a-z][a-z0-9_]*$/` → `throw new I18nError(text)` (already an i18n key).
2. Else lookup in `ERROR_KEY_MAP` (English sentence → key):
   ```
   "shipping box not found" → shipping_box_not_found
   "shelf box not found" → shelf_box_not_found
   "receiving order not found" → receiving_order_not_found
   "picking order not found" → picking_order_not_found
   "measuring task not found" → measuring_task_not_found
   "verification task not found" → verification_task_not_found
   "box is not open" → box_is_not_open
   "package already verified" → package_already_verified
   "package not found" → package_not_found
   "package is not in a box" → package_not_in_shipping_box
   "measuring task is not pending" → measuring_task_is_not_pending
   "verification task is not pending" → verification_task_is_not_pending
   "no unverified scans for part in box" → shelf_box_item_not_found
   "shelf box is not open" → shelf_box_is_not_open
   "box has unverified items" → not_all_shelf_box_items_verified
   ```
   Verify each target key exists in the web locale files (`apps/web/i18n/` — check `en` locale `errors.*`); if a target key is missing from locales, keep the raw text Error instead (report which).
3. Else → `throw new Error(`${res.status}: ${text}`)`.
4. Network failure (`fetch` throws, no response) → `throw new I18nError("network_error")` — check `composables/errorMessage.ts` fallback for unknown keys and add `network_error` to the locale files (`en` + the other locale present) if missing.

`I18nError`: find its definition (likely `apps/web/utils/error.ts` or similar) and import it.

- [ ] **Step 1: Write the failing tests** `apps/web/services/apiClient.test.ts` (vitest; check `apps/web/package.json` test script + how `tests/scanMatchers.test.ts` is configured — same config). Stub `globalThis.fetch` with `vi.fn()`. Cases: (a) GET builds URL `baseUrl + path + query`, returns parsed JSON; (b) POST sends JSON body + content-type; (c) i18n-key-shaped 400 text → I18nError with that key; (d) mapped English 409 text → I18nError with mapped key; (e) unmapped 500 text → Error containing status; (f) fetch rejects → I18nError("network_error"); (g) trailing-slash baseUrl normalized.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement `apiClient.ts`.**
- [ ] **Step 4: Tests PASS + typecheck** (`cmd.exe //c "pnpm --filter @warehouse/web exec vue-tsc --noEmit"` — verify the right typecheck command from package.json first).
- [ ] **Step 5: Commit:**
```bash
git add apps/web/services/apiClient.ts apps/web/services/apiClient.test.ts <locale files if touched>
git commit -m "feat(web): apiClient fetch wrapper + error mapping (Plan 8 task 1)"
```

---

### Task 2: `apiAuth`

**Files:**
- Modify: `apps/web/services/adapters/apiAuth.ts`
- Modify: `apps/web/services/types.ts` (maybe — `User.createdAt`)
- Test: `apps/web/services/adapters/apiAuth.test.ts` (new)

- [ ] **Step 0: Check `User.createdAt` usage.** Grep apps/web for `createdAt` on user objects (`currentUser.value?.createdAt`, etc.). If unused: widen `User.createdAt` to `Date | null` in `services/types.ts` and map null. If used somewhere: map `new Date(0)` and leave a comment. Report the decision.
- [ ] **Step 1: Write the failing tests** (stub fetch via a shared helper — extract the fetch-stub from apiClient.test.ts into the test or duplicate the ~10 lines; your call): login success → POST /auth/login body `{username, password}` → returns `User { id, username, displayName ← name, role, createdAt }`; 401 → `I18nError("invalid_username_or_password")`; getCurrentUser: no localStorage key → null (no fetch); key present → GET /auth/users/:id → User; 404 → null + key removed; logout → resolves (no fetch). localStorage: vitest environment — check if jsdom/happy-dom is configured; if not, stub `globalThis.localStorage` with a tiny Map-backed fake in the test.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `createApiAuthService({ apiBaseUrl })`: build an apiClient internally (no getActorId needed); `login` maps `AuthUser { id, username, name, role }` (from `@warehouse/shared`) → `User`; `getCurrentUser` reads localStorage `warehouse-user-id` (same key `useAuth`/`pgliteAuth` use), fetches, maps, on 404 clears the key and returns null; `logout` no-op (useAuth clears storage). Throw `I18nError("invalid_username_or_password")` on 401 from login.
- [ ] **Step 4: Tests PASS + typecheck.**
- [ ] **Step 5: Commit:**
```bash
git add apps/web/services/adapters/apiAuth.ts apps/web/services/adapters/apiAuth.test.ts apps/web/services/types.ts
git commit -m "feat(web): apiAuth adapter (Plan 8 task 2)"
```

---

### Task 3a: API flat mutation routes + small additive fixes

**Files (all in apps/api):**
- Modify: `src/routes/pickingExecution.ts` (+ tests in `src/routes/pickingExecution.test.ts`)
- Modify: `src/routes/receiving.ts` (+ test in `src/routes/receivingRead.test.ts`)
- Modify: `src/routes/picking.ts`, `src/db/pickingIssues.ts` (+ tests)
- Modify: `src/db/putAway.ts`, `src/routes/putAway.ts` (+ tests)

API conventions from Plan 7 apply unchanged: `cmd.exe //c` pnpm prefix; route tests = temp `DATABASE_URL` + `process.env.WAREHOUSE_SEED = "off";` before `await import("../index.js")` + second better-sqlite3 seed connection + fresh unique ids; HTTPException; never write generated columns; state-changing db tests end `assertInvariantsHold`; commit to master with explicit paths, never stage strays or `apps/android`.

- [ ] **Step 1: Flat routes** (read `src/db/pickScan.ts` for the existing db fns — the nested routes are thin wrappers; the flat routes resolve parents inside):
  - `POST /allocations/:id/scan` — body `{ qty, actor_id? }` → same as `POST /picking-orders/:id/scan` minus the order lookup (verify `scanAllocation` loads allocation→item→order and validates order status itself; if it doesn't, do the lookup inside the route). → `{ package_ids }`.
  - `POST /packages/:id/add-to-box` — body `{ box_id, actor_id? }` → load package (404), then the same db fn the nested route uses. → box/packages summary (match the nested route's response shape).
  - `DELETE /packages/:id?actor_id=` — load package (404); if `shipping_box_id` set → the remove-from-box db fn, else the remove-scanned-package db fn. Response shape: match whichever nested route applies (keep it simple: `{ ok: true }` if the nested shapes differ — report choice).
  - `POST /packages/:id/verify` — body `{ actor_id? }` → load package, derive `shipping_box_id` (409 "package is not in a box" if null), call the verify db fn. → match nested response.
  - `POST /shipping-boxes/:id/cancel` — body `{ actor_id? }` → the cancel db fn (derive order from box). → match nested response.
- [ ] **Step 2: confirm-arrival** — `POST /receiving-orders/:external_id/confirm-arrival` currently matches `WHERE external_id = ?`; change to match `WHERE id = ? OR external_id = ?` (param name stays; update the route comment).
- [ ] **Step 3: `"other"` issue reason** — add to the route whitelist in `routes/picking.ts` and the db validation in `db/pickingIssues.ts`. Check `apps/web/db/picking.ts:473-550` for how the web treats `"other"` (which issue fields it sets — mirror: likely reason + remark/note only, no qty/pack_size).
- [ ] **Step 4: fuller create responses** — `recordPutAwayScan` returns the created scan row (all columns); `createShelfBox` returns the created box row. Update `db/putAway.ts` to return rows, adjust the two routes, and update any existing tests that asserted `{ id }`.
- [ ] **Step 5: Tests first per route (TDD), then FULL suite + build:**
```bash
cmd.exe //c "pnpm --filter @warehouse/api test"
cmd.exe //c "pnpm --filter @warehouse/api build"
```
Commit:
```bash
git add apps/api/src/routes/pickingExecution.ts apps/api/src/routes/pickingExecution.test.ts apps/api/src/routes/receiving.ts apps/api/src/routes/receivingRead.test.ts apps/api/src/routes/picking.ts apps/api/src/routes/picking.test.ts apps/api/src/db/pickingIssues.ts apps/api/src/db/pickingIssues.test.ts apps/api/src/db/putAway.ts apps/api/src/routes/putAway.ts apps/api/src/routes/putAway.test.ts
git commit -m "feat(api): flat mutation routes + additive adapter fixes (Plan 8 task 3a)"
```
(stage only files actually changed)

---

### Task 3b: API picking read extensions

**Files (all in apps/api):**
- Modify: `src/routes/pickingExecution.ts` (+ tests)

- [ ] **Step 1: `GET /picking-orders`** — add `total_qty` per order: `LEFT JOIN picking_items pi ... GROUP BY po.id` or a correlated `SELECT COALESCE(SUM(qty),0)` subquery. Existing keys unchanged.
- [ ] **Step 2: `GET /picking-orders/:id`** — extend the composed response (read the current handler at `pickingExecution.ts:144-188`):
  - order: add `issue_reason, issue_note, issue_qty, issue_pack_size, issue_remark, issue_reported_at, issue_reported_by` to the select; add `issue_reported_by_name` via `LEFT JOIN users u ON u.id = po.issue_reported_by`.
  - add `measuring_task`: `{ id, status } | null` — `SELECT id, status FROM measuring_tasks WHERE picking_order_id = ? ORDER BY created_at DESC LIMIT 1`.
  - items: add `required_date_code, source_shelf_code` to the select.
  - packages: add `created_at`.
  - allocations: add `remark` (if the column exists on allocations — check `tables.ts`), lot `id` + `part_id` (join inventory_lots fully), and receiving-order `ref_no` (`LEFT JOIN receiving_orders ro ON ro.id = a.receiving_order_id` → `receiving_order_ref_no`).
- [ ] **Step 3: Tests** — extend `pickingExecution.test.ts` fixtures (fresh ids): order with issue fields set + reporter user + measuring task; assert all new keys with values and the null cases on a second plain order. Assert `total_qty` sums multiple items.
- [ ] **Step 4: FULL suite + build.** Commit:
```bash
git add apps/api/src/routes/pickingExecution.ts apps/api/src/routes/pickingExecution.test.ts
git commit -m "feat(api): picking read extensions for adapter (Plan 8 task 3b)"
```

---

### Task 4: Adapter — receiving, mismatches, picking-by-receiving, logs

**Goal:** Implement all receiving-side `WarehouseService` methods in `apiWarehouse.ts`: order list/detail, arrival confirmation, mismatch workflow, picking-by-receiving view, and transition logs.

**Methods (endpoint + mapping per method):**

1. `getReceivingOrders(filters?)` → `GET /receiving-orders?status=&q=`. Map rows: `ref_no→refNo`, `supplier_id→supplierId`, `supplier_name→supplierName`, `status` passthrough, `delivery_date→deliveryDate: new Date(v)` (v may be null → null), `created_at→createdAt: new Date`, `expected_lines→expectedLines`, `received_lines→receivedLines`. (Implementer: open `services/types.ts` for exact target field names; every method in this plan means "map to that interface's shape".)
2. `getReceivingOrder(id)` — composite, three calls in parallel:
   - `GET /receiving-orders/:id` (order + invoices + items + packages + boxes + supplier),
   - `GET /receiving-orders/:id/picking` (picking summary; **ignore its `transition_logs` field** — it is keyed by picking ORDER id, but the web page indexes `transitionLogs` by picking ITEM id),
   - `POST /picking-items/transition-logs` body `{ids: [<every picking_item id in the picking summary>]}`; group returned rows by `entity_id` into `Record<itemId, TransitionLog[]>`.
   Mappings: supplier `qr_template→qrcodeTemplate`, `qrcode_qty_encoding→qrcodeQtyEncoding`; item rows `receiving_invoice_item_id→id`, `part_no→partNo`, `ordered_qty→orderedQty`, `received_qty→receivedQty`, date/lot/coo/cow passthrough (API serves normalized values), `po_no/po_line` → `poNo/poLine` (default null if absent), nested part `internal_code→internalCode` (default null), `default_coo→defaultCoo` (default null); package rows `package_id→id`, `shipping_box_id→shippingBoxId`, `verified` 0/1 → boolean; mismatch rows remap `kind→reason`, `created_at→reportedAt: new Date`, `effective_received_qty→effectiveReceivedQty ?? 0`, `previous_received_qty→previousReceivedQty ?? 0`; delivery_date → `new Date` (null-safe); every transition log (any source): `entity_id→entityId`, `from_status→fromState`, `to_status→toState`, `note→metadata`, `actor_name→actorName`, `created_at→createdAt: new Date`.
3. `confirmReceivingArrival(id, items)` → `POST /receiving-orders/:id/confirm-arrival`. Body: `{items: items.map(i => ({receiving_invoice_item_id: i.receivingInvoiceItemId, received_qty: i.receivedQty, date_code, lot_code, coo, cow})), actor_id: getActorId()}`. (The API route keys items by external `external_id` after task 3a fix — implementer: verify task 3a made the route accept internal ids; if the web passes internal ids, 3a must have keyed by `id`.) Response ignored except errors (web returns void).
4. `getReceivingInvoiceItemMismatch(itemId)` → `GET /receiving-invoice-items/:id/mismatch`. Null → null; else remap as in (2) mismatch mapping.
5. `reportReceivingMismatch(itemId, input)` → `POST /receiving-invoice-items/:id/mismatches`. Body snake_case: `kind` from `input.reason`, `reported_qty→reportedQty`... (implementer: check `ReportMismatchInput` in `services/types.ts` and map every field to the API's snake_case body) plus `actor_id: getActorId()`. Return void.
6. `updateReceivingMismatch(mismatchId, input)` → `PATCH /mismatches/:id`, same mapping. Return void.
7. `confirmReceivingMismatch(mismatchId)` → `POST /mismatches/:id/confirm` body `{actor_id}`. Return void.
8. `cancelReceivingMismatch(mismatchId)` → `POST /mismatches/:id/cancel` body `{actor_id}`. Return void.
9. `getPickingByReceiving(receivingOrderId)` → `GET /receiving-orders/:id/picking`. Return the picking rows as the web's `PickingByReceivingRow[]` — verified exact 19-key pass-through (post-commit 48df665): implementer confirms each key against `services/types.ts` and maps `snake→camel` (`picking_order_id→pickingOrderId`, `ref_no→refNo`, `picking_item_id→pickingItemId`, `part_no→partNo`, `required_qty→requiredQty`, `allocated_qty→allocatedQty`, `picked_qty→pickedQty`, `remaining_qty→remainingQty`, `ship_to→shipTo`, dates → `new Date` where the type says Date).
10. `getPickingItemTransitionLogs(ids)` → `POST /picking-items/transition-logs` `{ids}`, group by `entity_id`, log remap as above.
11. `getPickingOrderTransitionLogs(ids)` → same endpoint with order ids (API accepts both entity kinds — implementer: verify the route handles `entity_type='picking_order'` too; if it only serves items, it was extended in task 3b — check before assuming).

**Tests first:** `apps/web/services/apiWarehouse.test.ts` — stub `globalThis.fetch` with `vi.fn()` returning canned API JSON; assert request URL/method/body and the mapped result shape per method group (list mapping; composite detail with 3 calls incl. the item-logs POST and grouping by `entity_id`; arrival body shape; mismatch bodies; by-receiving pass-through). Red → implement → green.

**Verify:** web typecheck + `cmd.exe //c "pnpm --filter web test"`.

```bash
git add apps/web/services/apiWarehouse.ts apps/web/services/apiWarehouse.test.ts
git commit -m "feat(web): apiWarehouse receiving + mismatches (Plan 8 task 4)"
```

---

### Task 5: Adapter — picking

**Goal:** Implement all picking-side methods: order list/detail, scan, OCR pick, box/package mutations, finish, issue reporting.

**Methods:**

1. `getPickingOrders(filters?)` → `GET /picking-orders?status=`. Map: `ref_no→refNo`, `total_qty→totalQty` (from 3b), `supplierName→null`, `deliveryDate→null` (documented gaps), status/dates as usual.
2. `getPickingOrder(id)` → `GET /picking-orders/:id` (bundle from 3b). Map: order header incl. `issue_count→issueCount`, `issue_reported_at→issueReportedAt ? new Date : null`; items `picking_item_id→id`, `part_no→partNo`, `required_qty→requiredQty`, `allocated_qty→allocatedQty`, `picked_qty→pickedQty`, `remaining_qty→remainingQty`, `required_date_code→requiredDateCode`, `source_shelf_code→sourceShelfCode`, ship_to→shipTo; allocations `allocation_id→id`, `picking_item_id→pickingItemId`, `qty`, `scanned_qty→scannedQty`, `remark` (from 3b), nested lot `lot_id→lotId`, `part_id→partId`, `receiving_ref_no→receivingRefNo`; packages `package_id→id`, `shipping_box_id→shippingBoxId`, `created_at→createdAt: new Date` (from 3b), `verified`→boolean; boxes incl. `cancelled_at→cancelledAt`; measuring task stub (from 3b) → `measuringTask`; issues → `issues` with `reporter_name→reporterName` (from 3b).
3. `scanAllocation(allocationId)` → `POST /allocations/:id/scan` (3a flat route) body `{actor_id}`. Response `{package_ids}` → return `package_ids[0] ?? ""`.
4. `applyOcrPick(receivingOrderId, input)` → `POST /receiving-orders/:id/ocr-pick` (`:id` is the receiving-order id — web passes it already). Body: `picking_item_id→input.pickingItemId`, `qty`, `date_code`, `lot_code`, `coo`, `cow`, `actor_id`. Return void.
5. `addPackageToBox(packageId, boxId)` → `POST /packages/:id/add-to-box` (3a) body `{shipping_box_id: boxId, actor_id}`. Return void.
6. `removePackageFromBox(packageId)` → `DELETE /packages/:id` (3a dispatches on null shipping_box_id → remove-from-box path). Return void.
7. `removeScannedPackage(packageId)` → same `DELETE /packages/:id` (3a dispatches to the scanned-removal path). Return void.
8. `addAllUnboxedToBox(pickingOrderId, boxId)` → existing nested route `POST /picking-orders/:id/add-all-unboxed?actor_id=`. Return void.
9. `cancelShippingBox(boxId)` → `POST /shipping-boxes/:id/cancel` (3a flat) with `?actor_id=`. Return void.
10. `finishPickingOrder(id)` → `POST /picking-orders/:id/finish?actor_id=`. Return void.
11. `reportPickingOrderIssues(orderId, input)` → `POST /picking-orders/:id/report-issues` body incl. `actor_id` and reason strings (API now accepts `"other"` post-3a). Response `{reported, skipped}` id arrays → map to web `ReportPickingIssuesResult` — **implementer: check the exact type in `services/types.ts`; if it wants counts, use `.length`; if arrays, pass through.**

**Tests first:** extend `apiWarehouse.test.ts` — canned bundle JSON → mapped detail shape (spot-check one item, one allocation w/ lot, one package, issue reporter name); scan returns first package id; each mutation's URL/method/body; issue-result mapping. Red → implement → green.

**Verify:** typecheck + web tests.

```bash
git add apps/web/services/apiWarehouse.ts apps/web/services/apiWarehouse.test.ts
git commit -m "feat(web): apiWarehouse picking (Plan 8 task 5)"
```

---

### Task 6: Adapter — put-away + shelves

**Goal:** Implement put-away and shelf methods.

**Methods:**

1. `getPutAwayTasks()` → `GET /put-away-tasks`. Map rows per `services/types.ts` (`receiving_order_id→receivingOrderId`, `ref_no→refNo`, counts, status, dates → Date).
2. `getPutAwayTask(id)` → `GET /put-away-tasks/:id`. Full detail mapping: items with `package_id→packageId`, `part_no→partNo`, `qty`, `put_away_qty→putAwayQty`, `shelf_code→shelfCode`; receiving header.
3. `recordPutAwayScan(taskId, packageId)` → `POST /put-away-tasks/:id/scan` body `{package_id: packageId, actor_id}`. API returns full row (post-3a) → map to the web's scan-result type (implementer: check `services/types.ts` for the exact return shape).
4. `createShelfBox(input)` → `POST /shelf-boxes` body snake_case (`receiving_order_id→receivingOrderId`, `shelf_id→shelfId`, `actor_id`). API returns full row (post-3a) → map (`shelf_id→shelfId`, `receiving_order_id→receivingOrderId`, `created_at→createdAt`).
5. `getShelves()` → `GET /shelves`. Map `code`, `zone→null` (documented gap), `box_count→boxCount` if the type has it.
6. `getShelfBoxes(shelfId)` → `GET /shelves/:id/boxes`. Map `shelf_id→shelfId`, `item_count→itemCount`, etc.

**Tests first:** stub fetch; assert URLs/bodies and mapping. Red → green.

```bash
git add apps/web/services/apiWarehouse.ts apps/web/services/apiWarehouse.test.ts
git commit -m "feat(web): apiWarehouse put-away + shelves (Plan 8 task 6)"
```

---

### Task 7: Adapter — measuring, verification, goods-verify, stock search

**Goal:** Implement measuring tasks, box measuring, verification (picking + cycle count), and stock search. This task carries the trickiest logic — port the pure match helpers from `db/measuring.ts`.

**Weight unit convention:** API stores integer **grams**; web types use **kg**. Read: ÷1000. Write: `Math.round(kg * 1000)`, and port the `weight_must_be_number` validation from `apps/web/db/measuring.ts:300-309` into the adapter (throw `I18nError("weight_must_be_number")` on non-finite input).

**Methods:**

1. `getMeasuringTasks()` → `GET /measuring-tasks`. Map (`picking_order_id→pickingOrderId`, `ref_no→refNo`, `supplierName→null` gap, status, dates).
2. `getMeasuringTask(id)` → `GET /measuring-tasks/:id`. Full detail: boxes with weights (g→kg), `size_l/w/h→sizeL/sizeW/sizeH`, `destination`, packages with `verified`→boolean, per-package part info.
3. `getShippingBoxForMeasuring(boxId)` → two calls: `GET /shipping-boxes/:id/for-measuring` then `GET /measuring-tasks/:taskId` using the task id from the first response, to assemble the web shape incl. `pickingItem.partId`. Map fields per type.
4. `updateShippingBoxMeasurements(boxId, input)` → `PATCH /shipping-boxes/:id/measurements` body snake_case, weights kg→g rounded (with validation above), `actor_id`. Return void.
5. `verifyShippingBox(boxId)` → `POST /shipping-boxes/:id/verify?actor_id=`... (implementer: check whether verify is actor in query or body — match the API route written in Plan 6; use whichever the route reads). Return void.
6. `findMatchingUnverifiedPackage(boxId, scan)` → **pure port** of the match loop from `apps/web/db/measuring.ts:230-261`: fetch `GET /shipping-boxes/:id/for-measuring`, run the same matching over its packages (all match fields — part_no/date/lot/coo/cow — are present in the response), return the matched package mapped, or null. No new endpoint.
7. `verifyPickingPackage(packageId)` → `POST /packages/:id/verify` (3a flat route) body `{actor_id}`. Return void.
8. `getVerificationTasks()` → `GET /verification-tasks`. Map `kind`, `status`, refs, dates.
9. `verifyShelfBoxItem(boxId, partId)` → `POST /shelf-boxes/:id/verify-item` body `{part_id: partId, actor_id}`. Error text `"no unverified scans for part in box"` must map to `shelf_box_item_not_found` (in the Task 1 error table).
10. `markShelfBoxVerified(boxId)` → `GET /verification-tasks?kind=cycle_count&status=pending` → find the row whose `shelf_box_id === boxId` → `POST /verification-tasks/:id/complete?actor_id=`. If no pending task matches, throw `I18nError("shelf_box_not_found")` (synthesized — the old pglite path behaved this way). Map 409 texts to `shelf_box_already_verified` / `not_all_shelf_box_items_verified` via the error table. Accepted divergence: the API requires box status `closed`.
11. `getGoodsVerifyBox(boxId)` / related goods-verify reads (implementer: enumerate the remaining goods-verify methods in `services/warehouse.ts` and wire each to its endpoint) — item ids are synthesized as `${boxId}-${part_id}` exactly as `apps/web/db/goodsVerify.ts:131-144` does; `verified` 0/1 → boolean; ISO strings → Date.
12. `searchStock(query)` → `GET /stock-search?q=`. Map `total_parts→totalParts`, `parts_with_inventory→partsWithInventory`, `location_label→locationLabel`, nested part `internalCode→null`, `defaultCoo→null`.

**Tests first:** stub fetch; key cases — weight conversion both directions + `weight_must_be_number` thrown; the ported match loop finds/doesn't-find a package; `markShelfBoxVerified` happy path (list→complete) and synthesized `shelf_box_not_found`; stock-search mapping. Red → green.

```bash
git add apps/web/services/apiWarehouse.ts apps/web/services/apiWarehouse.test.ts
git commit -m "feat(web): apiWarehouse measuring + verification + stock (Plan 8 task 7)"
```

---

### Task 8: Interface additions — `getScanCandidates`, `getSupplierQrTemplates`, `resetDemoData` (both adapters)

**Goal:** Add three methods to `WarehouseService` (`apps/web/services/warehouse.ts`) and implement them in both `apiWarehouse.ts` and `pgliteWarehouse.ts`, so Task 9's rewires are adapter-agnostic.

1. `getScanCandidates(receivingOrderId)` → returns `{receivingCandidatesByPartNo: Record<string, ReceivingScanCandidate[]>, pickingCandidatesByPartId: Record<string, PickingScanCandidate[]>}`.
   - API adapter: `GET /receiving-orders/:id/scan-candidates` (built in Plan 7 task 9). Map receiving candidate fields: `receiving_invoice_item_id→receivingInvoiceItemId`, `part_id→partId`, `part_no→partNo`, date/lot/coo/cow passthrough (API serves normalized values), `available_qty→availableQty`. Picking: `picking_order_id→pickingOrderId`, `picking_order_ref_no→pickingOrderRefNo`, `picking_item_id→pickingItemId`, `part_id→partId`, `ship_to→shipTo`, `required_qty`, `picked_qty`, `remaining_qty`. Group receiving by `collapseUpper(part_no)` — reuse the same normalization the web's `useScanMatchers` uses (implementer: import the shared normalize util rather than re-implementing); group picking by `part_id`.
   - pglite adapter: call the existing `findReceivingCandidatesForOrder(db, id)` and `findPickingCandidatesForOrder(db, id)` from `db/ocrPicking.ts` and group the same way.
2. `getSupplierQrTemplates()` → API: `GET /supplier-qr-templates`, map `supplier_id→supplierId`, `qr_template→qrcodeTemplate`, `qrcode_qty_encoding→qrcodeQtyEncoding`. pglite: wrap existing `getSuppliersWithQrTemplates(db)`.
3. `resetDemoData()` → API adapter: `POST /demo/reset` (exists — the dev reset endpoint). pglite adapter: `pg.close()` + `indexedDB.deleteDatabase("/pglite/warehouse-demo-pglite")` (vestigial but harmless — keep parity with current `AppHeader` behavior). In BOTH cases `AppHeader` retains responsibility for `localStorage.clear()` + reload (Task 9).

**Tests first:** both adapters get test coverage — API adapter: stubbed fetch asserts URL + grouping + field mapping. pglite adapter: extend the existing PGlite-backed test pattern (see `tests/scanMatchers.test.ts`) asserting grouping keys match what `useScanMatchers` expects.

```bash
git add apps/web/services/warehouse.ts apps/web/services/apiWarehouse.ts apps/web/services/pgliteWarehouse.ts apps/web/services/apiWarehouse.test.ts
git commit -m "feat(web): scan candidates + qr templates + reset on both adapters (Plan 8 task 8)"
```

---

### Task 9: Kill direct-db bypasses — rewire `useScanMatchers`, `useLabelScan`, `AppHeader`

**Goal:** Remove the three remaining `useDb()` consumers outside `db/` so the PGlite plugin can be gated off in Task 10.

1. `apps/web/composables/useScanMatchers.ts` — currently calls `findReceivingCandidates`/`findPickingCandidates` from `~/db/ocrPicking` per scan (:136/:149), and has a Map-cache consumption path (`ctx.receivingCandidatesByPartNo` / `pickingCandidatesByPartId`, :132-146) that no page populates. Rewire: in `matchReceiving`, call `useWarehouse().getScanCandidates(receivingOrderId)` once per scan (snapshot — no cache; measured acceptable for demo scale), then feed the returned maps into the **existing map-lookup path**. No page changes. Remove the `~/db/ocrPicking` import. **Semantics (decided during execution):** receiving-side must pick the first *sufficient* candidate (`availableQty >= qty`) — exact old SQL behavior. Picking-side deliberately filters `remainingQty >= qty` at match time (old code matched on `remaining_qty > 0` and failed at apply with `quantity_exceeds_picking_need`; new code returns match-time `none` — accepted improvement).
2. `apps/web/composables/useLabelScan.ts` — the module-level QR-template cache (:16-30) currently loads via `useDb()`. Swap the source to `warehouse.getSupplierQrTemplates()` (field mapping already done adapter-side). Keep the cache.
3. `apps/web/components/AppHeader.vue` (:78, :117-134) — reset handler currently does `pg.close()` + IndexedDB delete + `localStorage.clear()` + reload. Rewire to `await warehouse.resetDemoData()` then `localStorage.clear()` + reload (same for both adapters).

**Leave alone (pure-function imports, not db access):** `ReportIssueModal.vue:64` (`validateMismatchInputs` from `~/db/mismatch`), `utils/ids.ts:1` (`getIsoWeek` from `~/db/date`).

**Tests:** update `tests/scanMatchers.test.ts` if it exercises the rewired path (it may construct candidates directly — if so it stays valid; implementer checks). Manual verification deferred to Task 11.

```bash
git add apps/web/composables/useScanMatchers.ts apps/web/composables/useLabelScan.ts apps/web/components/AppHeader.vue
git commit -m "refactor(web): route scan/label/reset through WarehouseService (Plan 8 task 9)"
```

---

### Task 10: Boot gate + config flip

**Goal:** Make the API adapter the default and stop PGlite from booting.

1. `apps/web/plugins/pglite.client.ts` — early-return when `useRuntimeConfig().public.warehouseAdapter !== "pglite"` (static import of PGlite stays; the WASM chunk is accepted dead weight for now).
2. `apps/web/nuxt.config.ts` (:154-160) — flip `warehouseAdapter: "pglite"` → `"api"`, set `apiBaseUrl` default to `"http://localhost:3001"` (env-overridable via `NUXT_PUBLIC_API_BASE_URL`).
3. Run `cmd.exe //c "pnpm --filter web nuxt prepare"` — types must generate clean.
4. Smoke: start API (`cmd.exe //c "pnpm --filter api dev"`) and web (`cmd.exe //c "pnpm --filter web dev"`), confirm the login page loads and login works against the API (implementer does a curl-level smoke of `POST /auth/login`; full browser verification is Task 11/controller).

```bash
git add apps/web/plugins/pglite.client.ts apps/web/nuxt.config.ts
git commit -m "feat(web): default to API adapter, gate PGlite boot (Plan 8 task 10)"
```

---

### Task 11: Final gate + docs

**Goal:** Full verification and documentation update.

1. Full suites: `cmd.exe //c "pnpm --filter api test"` (expect 184+ green), `cmd.exe //c "pnpm --filter web test"`, web typecheck, `cmd.exe //c "pnpm --filter web nuxt prepare"`.
2. Docs:
   - `AGENTS.md` — rewrite the web-app section for the API-backed architecture: pnpm workspace layout (`apps/web`, `apps/api`, `packages/shared`), dev workflow (two servers: web :3000, API :3001), `NUXT_PUBLIC_API_BASE_URL` for device builds (Capacitor device needs a LAN-reachable host — CORS already allows `capacitor://localhost` and `http://localhost:3000`), the adapter switch (`warehouseAdapter: "api" | "pglite"`), and the demo-reset endpoint.
   - `docs/app-docs/ai/feature-registry.md` + `code-map.md` — note that pages now go through `services/apiWarehouse.ts` → HTTP API instead of direct PGlite queries.
   - `packages/shared` header comment fix — the package's header comment still implies DTOs live there; they don't (relocation rejected — 34 importers; `services/types.ts` remains the web's source of truth). Fix the comment only.
3. Commit docs.

```bash
git add AGENTS.md docs/app-docs/ai/feature-registry.md docs/app-docs/ai/code-map.md packages/shared
git commit -m "docs: API-backed architecture (Plan 8 task 11)"
```

**Controller step (not delegated):** after T11 lands, I run live browser verification via the chrome-devtools MCP against `pnpm dev` (web :3000) + API (:3001): login as `operator`/`DocPal2026!`, walk receiving → confirm arrival → picking (scan/OCR) → measuring → verification → put-away, plus stock search and demo reset.

---

## Self-review checklist (controller)

- [x] Scope: adapter + bypass removal + config flip + the API gaps found in research (3a/3b). No DTO relocation (rejected), no page rewrites.
- [x] Every web task is TDD-shaped: stubbed-fetch tests first, then implementation, then typecheck.
- [x] Every API gap found by the three explore agents is assigned: confirm-arrival keying, 6 flat routes, `"other"` reason, full-row returns (3a); list totals, bundle fields, order-level logs (3b).
- [x] Unit conventions pinned: grams↔kg with validation port; 0/1→boolean; ISO→Date; snake→camel per method; documented null gaps (supplierName, deliveryDate, zone, poNo/poLine, internalCode/defaultCoo).
- [x] `actor_id` placement flagged per method (body vs `?actor_id=`) with instruction to match the actual route.
- [x] Error mapping centralized in Task 1; task-specific texts (`no unverified scans…` → `shelf_box_item_not_found`) listed.
- [x] Dead-code finding honored: T9 feeds the existing map path in `useScanMatchers`, no page changes.
- [x] Pure-import files explicitly left alone.
- [x] Unknowns flagged for implementers to verify rather than assumed: `I18nError` path, vitest env/localStorage stub, typecheck command, `ReportPickingIssuesResult` shape, `scanAllocation` self-validation, allocations `remark` column.
- [x] Live browser verification owned by controller (chrome-devtools MCP) after T11.
