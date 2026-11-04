# Repo-audit fixes — implementation plan & validity re-check

Audit: `docs/superpowers/audits/2026-11-03-repo-audit.md`
Date: 2026-11-04 (every finding re-verified line-by-line against HEAD `4758c668`)

**Status: Batches A–D implemented & committed** (`50965af5..c2913ac7`; 9 commits).
Batch E (SSE ticket #15, flow-config retry #19, lean #18/#20) not executed.
Extra fix landed while implementing A1: the `receiving-cn` step gate was
mounted `use("*")` at adminRoute's "/" and 404-ed every admin route
registered after it whenever the CN step was off (`GET /admin/users`,
`/admin/docpal-url`, `/admin/task-assignment`) — now scoped to
`/receiving-cn*`. Verified: backend suite 664/676 (the 12 remaining fails
are all pre-existing on HEAD — A/B-checked), pda 446/446, admin 25/25,
`nuxt prepare` clean. `pnpm --filter @warehouse/backend build` currently
fails only on concurrent in-flight edits outside this plan
(`db/adhocPutaway.ts` PgColumn-vs-SQL typing).

Legend: 🔴 still valid · 🟠 valid but restated (audit claim partly wrong) · 🟢 superseded by commits after the audit · ⚪ accepted risk / deliberately skipped

## Validity verdict

| # | Finding | Verdict | Evidence / correction |
|---|---|---|---|
| 1 | Any operator can hit `/admin/*` | 🔴 | No group check anywhere in backend (`middleware.ts` only validates the JWT); `adminRoute` (`routes/admin/index.ts:59`) is unguarded. **New wrinkle the audit missed:** the PDA legitimately calls `GET /admin/shelves`, `/admin/suppliers`, `/admin/countries` (`services/adapters/backendWarehouse.ts:492,808,812`) — a blanket gate breaks operators. Whitelist those three GETs. |
| 2 | Lot/allocation can go negative | 🔴 | `picking.ts:1628–1629` still check-then-unconditional-UPDATE; `reduceAllocation` (`:242`) same. `loadOrderForWrite` still has no `FOR UPDATE` (only `shelfExchange.ts:248` uses one). |
| 3 | Request-path allocation races background | 🟠 | The original trigger (auto `allocateAll` after every scan) is gone since `32e42504` (allocation manual-only). What remains: the 5 request-path scoped runs (`receiving.ts:486`, `admin/allocation.ts:35,52`, `flowEdits.ts:119`, `admin/testPickingOrder.ts:136`) open their own tx outside the in-memory runner, while snapshot restore serializes *inside* it (`allocationSnapshot.ts:658`) — scoped-vs-scoped and scoped-vs-restore races still exist. Priority lowered, fix idea unchanged. |
| 4 | Network blip → dead error page (PDA) | 🔴 | `middleware/auth.global.ts:12` `await restore()` still unguarded; `apiAuth.ts:106–112` rethrows non-401; no `error.vue` anywhere in `apps/pda`. |
| 5 | Shelf Excel import wipes text fields | 🟠 | The text-field wipe claim is **wrong**: `shelfBatchImport.ts:88–90` skips null `displayName`/`zone`/`warning` on update (file unchanged since `5914d5bf` 2026-10-15, so it was already wrong at audit time). What is real: a blank cell in a sheet that has the sub-inventory column sends explicit `null` → backend *does* clear `subInventoryScopes` (`:55–58,91`); and still no confirm and no transaction around inserts+updates. |
| 6 | `dateToDateCode` reads wrong week | 🔴 | Still UTC getters (`utils/dateCode.ts:19`) fed local values: `stock-search/index.vue:260–261` (`new Date("…T00:00:00")`) and `ad-hoc-put-away/index.vue:332` (`new Date()`). Tests (`tests/dateCode.test.ts`) only feed `Date.UTC`. |
| 7 | Queued scan re-points wrong line | 🔴 | `usePickingScanQueue.ts:487` still `findTarget({ partNo: row.partNo }, …)` — drops `scannedWclItemNo`. |
| 8 | Box-id collision | 🔴 | `boxes.ts:31–47` unchanged — max-scan, no lock, no retry. |
| 9 | Work-lock grab race | 🔴 | `picking.ts:896–921` unchanged — read/check/UPDATE, no conditional. |
| 10 | Admin SPA logs out on any fetch error | 🔴 | `middleware/auth.global.ts:24–27` — `catch → valid=false → clearSession()`. |
| 11 | Stale responses overwrite fresh lists | 🔴 | `CrudTable.vue:135–165` no sequencing; hand-rolled loads `picking-orders/index.vue:137`, `receiving-cn/index.vue:84` same. |
| 12 | Picking page error card sticks | 🔴 | `picking/unified/[id].vue:634` `load()` never clears `error.value`. |
| 13 | Double beeps / success-on-failure | 🔴 | `useHardwareScanner.ts:138,147–148` unchanged; beeps+returns still coexist in `picking/unified` `deliverScan` (:342–376) and `receiving-cn-scan` `handleRawScan`/`applyScan` (:72–139); `ad-hoc-put-away` `handleHardwareScan` still beeps and returns `undefined` (:252–270) → composable adds a success chime even after the error buzz. Wider than the audit said: `shelf-exchange/index.vue` and `put-away/[id].vue` also call `playScan*` — verify per-site whether they sit on the hardware-handler path before deleting. |
| 14 | Scanner whitelist stuck after unmount | 🔴 | Both `useBrandSymbologyScope` (`useScannerConfig.ts:131–157`) and `useSupplierSymbologyScope` (:167–196) still set `applied` only after the async templates fetch; no `disposed` guard. |
| 15 | JWT in SSE URL | 🔴 | `useWarehouseEvents.ts:118–120` and `apps/admin/composables/useAdminEvents.ts:53` both pass `?token=`; middleware still accepts it for `GET /events` only (`auth/middleware.ts:32–34`). Fix must cover **both** apps. |
| 16 | Per-scan fleet allocation rewrite | 🟢 | Fixed by `32e42504` (manual-only spec). `scheduleAllocateAll` has zero callers in `src/routes/` today. No work. |
| 17 | Partial multi-credit scan stale UI | 🔴 | `useScanMatchers.ts:304–331` loop still throws mid-way; `MeasureBox.vue:476–496` refetches (`load()`/`onScanApplied()`) only on success; catch at :491 doesn't reload. |
| 18 | Triple `checkBatchAttr`, twin label composables, dateCode mirror | 🔴 | Confirmed: `usePickingScanQueue.ts:16`, `useScanMatchers.ts:135`, `put-away/[id].vue:325`; `useLabelingOrders.ts` + `useLabelPrintingOrders.ts` both exist. |
| 19 | Flow-config truthiness | 🔴 | `useFlowSteps.ts:85` still `if (config.cnReceiving)`; `/config` failure swallowed (:96–97). |
| 20 | Lean: deps/dead code/logs | 🔴 | Backend `xlsx` still in `dependencies` (package.json:27) but only *tests* import it; admin ships `exceljs`+`xlsx` (but see skip note); `scan-log.txt` still at repo root; `boxTotalQty`/`normalizeString` still exported; `/dev/*` still auth-open (`auth/middleware.ts:18`). |
| — | "Smaller ones" list (audit §207) | ⚪ | Out of scope for this plan unless asked. |

## Batch A — backend: security + data integrity (audit 1, 2, 3′, 8, 9)

### A1 — Admin-group gate 🎯1
- `routes/admin/index.ts`: near the top of `adminRoute`, add
  `adminRoute.use("*", (c, next) => { … groupCodes.includes("admin") or exempt PDA reads … })`
  — exempt exactly `GET /shelves`, `GET /suppliers`, `GET /countries` (the PDA
  reference reads; everything else incl. all writes, `/admin/users`,
  `/admin/task-assignment`, `/admin/flow-config` → 403 `forbidden`).
- `groupCodes` already rides in the JWT (`auth/jwt.ts:11,32`); no new plumbing.
- Tests (extend `src/auth/auth.test.ts` or a new `routes/admin/guard.test.ts`):
  operator token → 200 on the three exempt reads, 403 on `GET /admin/users` and
  `PUT /admin/flow-config`; admin token → 200.
- Check before commit: `grep -r '"/admin/' apps/pda/services` (currently only the
  three) — if the PDA grows a new admin call later it must be explicitly whitelisted.

### A2 — Guarded decrements 🎯2
- `picking.ts:1629` → `UPDATE inventory_lots SET total_qty = total_qty - ${input.qty}
  WHERE id = ${lot.id} AND total_qty >= ${input.qty}`; `queryRun(...).changes === 0`
  → 409 `insufficient_lot_qty` (same code as the pre-check, so clients are unchanged).
- `reduceAllocation` (`picking.ts:241`) → add `AND qty >= ${qty}` + `changes` check →
  409 `scanned_qty_exceeds_allocation` (mirrors the pre-check at :1598; sole caller
  `:1706` stays as-is).
- Keep `loadOrderForWrite` un-locked (deliberate: two operators on *different*
  orders never share the order row, the per-row guard is what closes the hole).
- Test: new case in `src/db/picking.test.ts` — one 100-unit lot, two orders each
  allocated 80, `Promise.all` both `scanPickingItem` → exactly one succeeds,
  `total_qty` never negative, the loser gets 409.

### A3 — Serialize scoped allocation runs 🎯3′
- Wrap the 5 request-path call sites in `awaitAllocationTask(db, "<trigger>", () =>
  allocateForReceivingOrder/allocateForPickingOrder(db, id))` (same import pattern
  as `allocationSnapshot.ts:658`): `routes/receiving.ts:486`, `routes/admin/allocation.ts:35,52`,
  `routes/admin/flowEdits.ts:119`, `routes/admin/testPickingOrder.ts:136`.
- `awaitAllocationTask` already rejects with the thrown error, so 404/409 responses
  pass through unchanged.
- Test: existing suites (`allocate.test.ts`, `pickingStatusOverride.test.ts`,
  `receivingStatusOverride.test.ts`) must stay green — they cover the runner + both
  scoped entry points; no new concurrency test (flaky, low value).

### A4 — Box-id advisory lock 🎯8
- `db/boxes.ts:31` `nextBoxId`: first statement
  `SELECT pg_advisory_xact_lock(hashtext(${prefix}))` (one line; caller already
  runs in a tx).
- Test: `src/db/boxes.test.ts` — `Promise.all` of two `createShippingBox` on
  different orders → two distinct sequential ids, no error.

### A5 — Atomic work-lock acquire 🎯9
- `picking.ts:896–921`: replace check-then-UPDATE with a conditional
  `UPDATE … SET working_by, working_at WHERE id = … AND (working_by IS NULL OR
  working_by = ${actorId} OR working_at < ${workLockExpiry()})`; `changes === 0` →
  re-read holder and throw the existing `lockHeldResponse`.
- Test: `picking.test.ts` — two actors `Promise.all` `acquireWorkLock` same order →
  one wins, the other gets 409 `lock_held`; re-acquire by holder still OK.

## Batch B — PDA: resilience (audit 4, 12, 14, 17, 13, 7)

### B1 — Survive network blips in the route guard 🎯4
- `apps/pda/middleware/auth.global.ts:12`: `try { await restore() } catch { /* keep stored session; ServerDownOverlay handles the rest */ }`.
- No `error.vue` (skipped — the catch is the designed behavior; overlay already exists).

### B2 — Clear the picking error card on reload 🎯12
- `pages/picking/unified/[id].vue:634`: first line of `load()` `error.value = null;`
  (matches `ad-hoc-put-away/index.vue:204`).

### B3 — Scanner whitelist disposed-guard 🎯14
- `composables/useScannerConfig.ts`: in both scope composables add
  `let disposed = false`, set it in `onUnmounted`, and `if (disposed) return;` in
  `applyFor` right after the templates await **and** before `setSymbologies`/
  `restoreAll` land post-await.
- Test: extend `apps/pda/tests/useScannerConfig.test.ts` (mock `ScannerConfig`
  plugin) — unmount while `getCachedSupplierQrTemplates` is pending → no
  `setSymbologies` call lands.

### B4 — Reload after partial multi-credit 🎯17
- `components/MeasureBox.vue` scan handler: `await load()` inside the `catch` at
  :491 (credits that committed server-side re-sync the screen).

### B5 — One beep owner 🎯13
- Rule: the composable beeps for hardware scans (return value drives it); pages
  only beep paths *not* routed through `useHardwareScanner` (OCR, manual chooser).
- `picking/unified/[id].vue deliverScan` (:342–376): delete its `playScan*` calls,
  keep returns.
- `receiving-cn-scan/[id].vue`: move `applyScan`'s beeps to the manual chooser
  caller `chooseItem` (result-driven), strip `handleRawScan`'s own beeps.
- `ad-hoc-put-away/index.vue handleHardwareScan` (:252–270): delete its beeps,
  `return false` on no-match / `return true` after add; shelf-select `return true`
  (composable beeps success once).
- Audit `shelf-exchange/index.vue` + `put-away/[id].vue` beep sites: delete only
  those inside the `onScan` handler; keep OCR/manual ones.
- Test: `apps/pda/tests/useHardwareScanner.test.ts` — mock `utils/scanBeep`; assert
  handler→`false` produces exactly one `playScanError`, `true` one
  `playScanSuccess`, `undefined` treated as success (documents why handlers must
  return booleans).

### B6 — Keep `wclItemNo` in re-point 🎯7
- `composables/usePickingScanQueue.ts:487`:
  `findTarget({ partNo: row.partNo, wclItemNo: row.scannedWclItemNo ?? undefined }, row.qty, row.key)`.
- Test: existing queue tests + one new case: two items same `partNo`, different
  `wcl_item_no` → queued row re-points to its own brand.

## Batch C — PDA: date-code local week 🎯6

- `utils/dateCode.ts:18–27`: take the *local* calendar Y/M/D
  (`getFullYear/getMonth/getDate`) and run the ISO arithmetic in UTC from those
  parts (function becomes "week of this calendar date", timezone-independent).
- `tests/dateCode.test.ts`: re-express existing cases as local constructions
  (`new Date(2026, 0, 1)` etc. — they were written as `Date.UTC` which breaks under
  UTC+8 once getters switch to local) and add the audit's regression:
  `dateToDateCode(new Date(2026, 10, 2))` === week-of-Monday (not the prior week).
- Backend `db/dateCode.ts` mirror: add the reciprocal pointer comment
  (`// Mirrors apps/pda/utils/dateCode.ts — keep in sync`) (also closes 18's dateCode item).

## Batch D — admin: session + tables + import (audit 10, 11, 5′)

### D1 — Keep session on transport errors 🎯10
- `apps/admin/middleware/auth.global.ts`: split outcomes — `res` 401/403 →
  `clearSession()`; `res.ok` but no admin group → `clearSession()` (unchanged);
  other non-ok (5xx) or thrown fetch → keep token, navigate (the request itself
  surfaces the outage).

### D2 — Sequence the list loads 🎯11
- `components/CrudTable.vue load()`: `let loadSeq = 0; const seq = ++loadSeq; …`
  drop stale assignments before `rows.value =` (both server and client mode).
- Same 3-line guard in `pages/picking-orders/index.vue` (~:137) and
  `pages/receiving-cn/index.vue` (~:84). Pattern copied from
  `apps/pda/pages/stock-search` (`loadSeq`).

### D3 — Shelf import: no blank-cell wipe, confirm, tx 🎯5′
- `apps/admin/pages/shelves.vue:198–205`: only set a key when the cell has content
  (skip blank cells entirely — incl. `subInventoryScopes`, so a blank sub-inventory
  cell no longer means "clear"; clearing stays a deliberate single-shelf edit).
- Before the POST: `if (!confirm(\`Import ${payload.length} rows?\`)) return;`
  (admin console is internal; a custom dialog would be 40 lines for one click).
- `apps/backend/src/routes/admin/shelfBatchImport.ts`: wrap select+insert+update
  loop in one `db.transaction` (validate → throw → nothing half-written).

## Batch E — security polish + lean (audit 15, 19, 20, 18)

### E1 — SSE ticket instead of raw JWT 🎯15
- Backend: `POST /events-ticket` (auth required) → signs a short-lived (60 s)
  HS256 token `{ sub, purpose: "events", exp }`; `auth/middleware.ts` accepts
  `?ticket=` on `GET /events` in addition to `?token=` (keep `?token=` so old
  clients keep working during rollout), verify purpose on the SSE route.
- `useWarehouseEvents.ts` + `apps/admin/composables/useAdminEvents.ts`: fetch
  ticket, connect `?ticket=`; refresh ticket on reconnect.
- Alternative accepted if effort is declined: keep `?token=` and suppress query
  logging for `/events` at the proxy (deploy note only). ~40 lines code otherwise.

### E2 — Flow-config explicit false + retry 🎯19
- `composables/useFlowSteps.ts:85`: `if (config.cnReceiving !== undefined)`;
  `:82` `dateCodeFormat` likewise `!== undefined` (cheap, same shape).
- Retry once on next `visibilitychange` when the last `/config` failed.

### E3 — Lean 🎯20 (each independently revertable)
- `apps/backend/package.json`: move `xlsx` to `devDependencies` (tests-only import) → `pnpm install`.
- Delete dead exports `boxTotalQty` (`utils/box.ts`), `normalizeString`
  (`utils/text.ts`) after a zero-importer grep; delete `scan-log.txt`.
- Strip full-payload `console.log`s: `utils/parseOcrScan.ts` (~:976),
  `pages/put-away/[id].vue` (~:370), `apps/admin/components/InventoryLabelForm.vue`
  (~:77), `apps/admin/utils/print.ts` (~:454). (Keep `[SCAN-TIME]` logs.)
- `apps/admin/utils/entities.ts` `inventory-labels` entry + `CrudForm.vue`
  `subInventorySelect` dead branch: re-verify nothing references them, then delete.
- `auth/middleware.ts:18`: only open `/dev/*` when dev routes are mounted
  (gate on the same `DEV_ROUTES` config the mount uses).
- ⚪ **Skipped:** admin single-Excel-lib consolidation — both libs are actually
  used (`receiving-cn/[batchNo].vue:77` documents that the community xlsx build
  *cannot* produce that export); converting shelves/stock-search to exceljs is a
  rewrite, not a deletion. Finding 18's `checkBatchAttr` merge + labeling-composable
  merge also deferred — real drift risk but zero current bug, and the 3 copies
  already have intentionally different return shapes; do as its own change if wanted.

## Sequencing & verification

- Commit order: A1 → A2 → A5 → A4 → A3 → B1–B6 → C → D1–D3 → E. Each batch:
  - backend: `pnpm --filter @warehouse/backend test` (Postgres up, `TEST_DATABASE_URL`) + `build` (tsc).
  - pda: `pnpm --filter @warehouse/pda test` + `nuxt prepare`.
  - admin: `pnpm --filter @warehouse/admin test` (vitest).
- After A1, device smoke: operator login on PDA → shelf list + ad-hoc put-away
  brand dropdowns still populate (they hit the three whitelisted reads).
- Not covered by this plan: the audit's "Not checked" list stands (putaway/
  receivingCn/measuring/verify domain files, native Java, seeds) — none of it was
  re-audited, and no finding depends on it.
