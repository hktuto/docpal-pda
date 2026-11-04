# Repo audit: docpal-pda (warehouse PDA monorepo)

- **Date:** 2026-11-03
- **Scope:** whole repo — `apps/backend`, `apps/pda`, `apps/admin`, deploy/build config. Read-only report, no code changed.
- **Method:** ponytail-audit (bug → risk → scale → missing test → speed → lean). Subagent passes over `apps/pda` and `apps/admin`; every published finding line-verified against the tree.

---

**What this repo does:** A warehouse management system: `apps/pda` (Nuxt 3 + Capacitor Android, barcode-scan driven receiving/put-away/picking/measuring/verify), `apps/backend` (Hono + Drizzle + PostgreSQL on :3002 — the real logic, allocation engine, SSE events, audit ledger), `apps/admin` (desktop console for master data and the shipping feed). Login is delegated to DocPal; an external service syncs orders/stock straight into the same DB.

**Load assumed:** one instance per warehouse; a few dozen PDA devices (10–50 operators) plus 1–5 admins hitting one backend process, each device holding an SSE connection that polls the DB every 1.5 s; the upstream sync writes the same tables concurrently. No money, but inventory quantities are the precious data — a wrong number ships the wrong box.

---

## Must fix

### 1. Every logged-in operator is an admin

`apps/backend/src/auth/middleware.ts:22-43`, `apps/backend/src/routes/admin/index.ts:59`

- **What this is:** One global middleware checks only "is this a valid JWT". There is no admin-group check anywhere in the backend (grep: zero hits for `requireAdmin`/403 on `/admin`). "Admin" is enforced only in the admin SPA's own router guard (`apps/admin/middleware/auth.global.ts:22`).
- **Problem:** A PDA operator reads their token from localStorage (`warehouse-token`) and calls `PUT /admin/flow-config`, `POST /admin/shelves/batch-import`, `GET /admin/users`, `/admin/task-assignment` — rewire the whole warehouse flow or mass-edit masters.
- **Fix:** ~6 lines in `adminRoute`: `if (!actorFrom(c).groupCodes.includes("admin")) throw 403`.
- **If we skip it:** Any worker with a device and a grudge can destroy master data; all other backend validation is bypassed.

### 2. Two operators can drive a lot's stock negative

`apps/backend/src/db/picking.ts:1591-1622, 234-235`

- **What this is:** `scanPickingItem` reads `lot.totalQty`, checks `totalQty < qty`, then subtracts with an unconditional `UPDATE ... SET total_qty = total_qty - x`. Same pattern for allocations (`qty = qty - x`, no guard). Nothing locks the rows (the helper is even called `loadOrderForWrite` but it has no `FOR UPDATE`).
- **Problem:** The allocation engine splits one lot across several picking orders. Two operators on *different* orders scan from the same 100-unit lot at once: each checks against 100, both subtract 80 → `total_qty = -60`, two `picking_packages` of phantom stock, `available_qty` (generated column) lies forever.
- **Fix:** Make the writes conditional and check the row count: `UPDATE inventory_lots SET total_qty = total_qty - ${qty} WHERE id = ${id} AND total_qty >= ${qty}` → 0 rows means 409 `insufficient_lot_qty`. Same `AND qty >= x` on the allocation UPDATE. 2 lines.
- **If we skip it:** Silent inventory corruption that only shows up as a missing-stock dispute, and the ledger rows written alongside make it look legit.

### 3. The request-path allocation run races the background one

`apps/backend/src/routes/receiving.ts:486`, `apps/backend/src/routes/admin/allocation.ts:45,62`, `apps/backend/src/routes/admin/flowEdits.ts:119` vs `apps/backend/src/db/allocate.ts:1992-2064`

- **What this is:** Background `allocateAll` is serialized through one in-memory runner, but `allocateForReceivingOrder` (confirm-arrival, admin re-allocate) runs its own wipe-and-rebuild transaction directly in the request, bypassing it. There is no DB lock either (grep: no `FOR UPDATE`/advisory lock in `allocate.ts`).
- **Problem:** Operator A confirms arrival while the runner rebuilds the same parts after B's scan. Both read the old allocations, both delete (one deletes 0 rows, Postgres skips already-deleted), both insert → duplicate `allocations` rows and double `RESERVE` ledger entries. The code's own comment (`allocate.ts:2083-2085`) says this exact bug used to happen and was fixed *only* for the admin manual run.
- **Fix:** Run the scoped passes through the existing runner: `awaitAllocationTask(db, "confirm-arrival", () => allocateForReceivingOrder(...))` at those 3–4 call sites. One line each.
- **If we skip it:** Over-reserved stock, picking lists with impossible locations, and the wipe/rebuild can't undo it without a manual re-allocate.

### 4. One network blip turns the PDA into a dead error page

`apps/pda/middleware/auth.global.ts:12`, `apps/pda/services/adapters/apiAuth.ts:106-112`, `apps/pda/services/apiClient.ts:150-155`

- **What this is:** The route guard calls `await restore()` with no try/catch; `getCurrentUser` rethrows everything except 401; `apiClient` throws on network failure. The app has no `error.vue`.
- **Problem:** Backend restarts (deploys happen) while a worker is mid-shift; the next tap navigates, the middleware throws, Nuxt replaces `app.vue` with its built-in error screen — which also removes the designed `<ServerDownOverlay>` with the retry/"change server" escape. The scanner shows a gray page until the app is force-killed.
- **Fix:** `try { await restore() } catch { /* keep the stored session */ }` — one line; the overlay then does its job.
- **If we skip it:** Every deploy takes every handheld into a dead screen the operator can't recover from.

### 5. The shelf Excel import silently wipes text fields

`apps/admin/pages/shelves.vue:198-211`, `apps/backend/src/routes/admin/shelfBatchImport.ts:44-57`

- **What this is:** Import posts immediately. If the file has a "warning"/"name"/"zone" column, every row sends that key, and a blank cell becomes `null`, which the backend explicitly treats as "clear this field" (its comment says so). No preview, no confirm, no undo.
- **Problem:** An admin re-saves the sheet from a template where the Warning column is empty for most shelves → one click erases safety warnings and display names on hundreds of shelves while showing "import ok".
- **Fix:** Treat a blank cell as "unchanged" (skip the key), and show a one-line "N rows will update" confirm before the POST. Also: the import's inserts/updates are not in one transaction — wrap them.
- **If we skip it:** Physical warehouse signage/warnings drift from the DB with nobody noticing until a wrong pick.

---

## Should fix

### 6. Date-code defaults read the wrong week

`apps/pda/utils/dateCode.ts:18-27` (callers `apps/pda/pages/stock-search/index.vue:260-261`, `apps/pda/pages/ad-hoc-put-away/index.vue:339`)

- **What this is:** `dateToDateCode` computes the ISO week from UTC parts, but callers hand it *local* midnight (`new Date("2026-11-03T00:00:00")`) or "now".
- **Problem:** In HK (UTC+8) local midnight = previous UTC day. Pick Monday as the search "To" date → you get the week before, and the selected Monday's rows vanish; scan ad-hoc put-away at 07:00 on a Monday → the item defaults to *last* week's date code. The test only feeds `Date.UTC`, so it passes either way.
- **Fix:** Use local getters (`getFullYear/getMonth/getDate`) and add one test with `new Date(2026, 10, 2)`.
- **If we skip it:** Stock searches hide valid rows; put-away lots get a wrong-week code the backend stores verbatim.

### 7. A queued scan can re-point at the wrong order line

`apps/pda/composables/usePickingScanQueue.ts:487`

- **What this is:** After every applied scan the backend rebuilds allocations with new ids, so queued rows re-resolve their target with `findTarget({ partNo: row.partNo }, ...)` — dropping the `scannedWclItemNo` the row saved, even though `findTarget` accepts it (`:168-187`, whose comment says the bare MPN "cannot disambiguate same-part lines of different brands").
- **Problem:** Order has the same supplier MPN under two WCL item numbers (the documented ABLIC case). Scan brand A's label while brand A's line is mid-rebuild → the queued row re-points to brand B's line → `confirm()` posts it against the wrong item.
- **Fix:** `findTarget({ partNo: row.partNo, wclItemNo: row.scannedWclItemNo ?? undefined }, ...)` — one line; add a test where only the WCL no disambiguates.
- **If we skip it:** Stock credited to the wrong line; the physical pick never matches the paper.

### 8. Two people creating a box at the same moment collide

`apps/backend/src/db/boxes.ts:31-47`

- **What this is:** `nextBoxId` = SELECT all ids of today, take max, +1. No lock (the caller's `loadOrderForWrite` doesn't lock either, so not even the same order is safe).
- **Problem:** Two operators finish boxing different orders at 09:00 → both compute `BOX-S-20261103-0042` → PK conflict → one request dies with a raw 500 mid-flow. Also the max-scan UNIONs the ever-growing `transaction_logs` on every box.
- **Fix:** One line at the top of `nextBoxId`: `SELECT pg_advisory_xact_lock(hashtext(${prefix}))` — or catch the conflict and retry the insert.
- **If we skip it:** Random "create box" failures during peak hours, confusing the operator who already stuck the label on.

### 9. The picking work-lock is grab-able by two devices

`apps/backend/src/db/picking.ts:891-911`

- **What this is:** `acquireWorkLock` reads `working_by`/`working_at`, checks expiry, then UPDATEs — without any row lock.
- **Problem:** Two devices open the same order within the same second → both see it free → both think they own it → both scan concurrently, which is also the entry ticket for finding 2's race.
- **Fix:** `UPDATE picking_orders SET working_by=${me} WHERE id=${id} AND (working_by IS NULL OR working_by=${me} OR working_at < ${expiry})`, then check `changes === 1`. ~4 lines.
- **If we skip it:** The one mechanism that keeps single-writer discipline off is the one with a hole.

### 10. Any network blip logs out every admin

`apps/admin/middleware/auth.global.ts:13-28`

- **What this is:** On every navigation the guard re-validates via `/auth/me`; a *thrown* fetch error sets `valid=false` → `clearSession()` → bounced to login.
- **Problem:** Backend container restarts while an admin is typing a flow-config edit → click anything → token deleted, work gone, full re-login (DocPal round-trip) — exactly when the server looks broken.
- **Fix:** Only clear on a real 401/403; on a thrown error keep the session and let the next API call decide. 2 lines.
- **If we skip it:** Admins lose work and blame the tool every deploy.

### 11. Stale responses overwrite fresh tables in every admin list

`apps/admin/components/CrudTable.vue:135-165`, plus the hand-rolled loads in `apps/admin/pages/picking-orders/index.vue`, `apps/admin/pages/receiving-cn/index.vue`

- **What this is:** `load()` fires a request and assigns `rows.value` whenever it lands — no sequencing.
- **Problem:** Type a filter, hit "next page" before the first response arrives → the slow first response lands last → the table shows unfiltered rows under the filtered label; admin then bulk-edits the wrong set. The correct guard already exists in the PDA's `stock-search` (`loadSeq`).
- **Fix:** `const seq = ++loadSeq; ... if (seq !== loadSeq) return;` — 3 lines per load.
- **If we skip it:** Wrong data on screen looks like wrong data in the DB.

### 12. PDA picking page locks on the error card and keeps consuming scans

`apps/pda/pages/picking/unified/[id].vue:634-660`

- **What this is:** `load()` never resets `error.value`; nine catch sites set it, only one unrelated path (`:769`) clears it. Scan enabling (`:381`) checks `!!order.value`, not `error`.
- **Problem:** One failed "Create box" → full-page error forever, no retry button — while hardware scans keep hitting the API behind the invisible page.
- **Fix:** First line of `load()`: `error.value = null;` (exactly what `apps/pda/pages/ad-hoc-put-away/index.vue:204` already does).
- **If we skip it:** A transient hiccup ends the operator's session on that order.

### 13. Scan beeps fire twice — and one page beeps success on failure

`apps/pda/composables/useHardwareScanner.ts:138,147-148` vs `apps/pda/pages/picking/unified/[id].vue:352-372`, `apps/pda/pages/receiving-cn-scan/[id].vue:76-133`, `apps/pda/pages/ad-hoc-put-away/index.vue:223-259`

- **What this is:** The composable owns the beep via the handler's return value; three pages beep *and* return booleans, and `ad-hoc-put-away`'s handler returns nothing, so `undefined !== false` reads as success.
- **Problem:** Accepted scan → two beeps; rejected label → error buzz then a *success chime*. On a loud shop floor the beep is the operator's only confirmation — the loudest signal fires on the wrong event.
- **Fix:** Delete the page-side beeps and return true/false; copy the shape already used by `apps/pda/pages/put-away/[id].vue:340-441`. Tests: `apps/pda/tests/useHardwareScanner.test.ts` never mocks the beep module, so add one assertion who beeps.
- **If we skip it:** Operators box rejected labels because the device said "ok".

### 14. The scanner can stay whitelist-locked after the page that set it is gone

`apps/pda/composables/useScannerConfig.ts:135-156`

- **What this is:** `applied = true` is set only *after* the `/scan-templates` fetch resolves; `onUnmounted` restores only `if (applied)`.
- **Problem:** Open stock-search, pick a brand, and navigate back before the first templates call returns → the queued `applyFor` still runs and restricts the *device-global* decoder (xcheng broadcasts are device-wide) with no owner left to restore → the scanner silently stops reading most labels until a force-restart, which reads as broken hardware.
- **Fix:** Set a `disposed` flag in `onUnmounted` and skip `setSymbologies` when disposed. 2 lines.
- **If we skip it:** "The scanner died" tickets that are really this race; costs real downtime on the floor.

### 15. The 12-hour JWT rides in the SSE URL

`apps/pda/composables/useWarehouseEvents.ts:114-120`, `apps/backend/src/routes/events.ts` + `apps/backend/src/auth/middleware.ts:32-34`

- **What this is:** `EventSource` can't set headers, so the apps pass `?token=<full JWT>`; the backend accepts it.
- **Problem:** Query strings land in reverse-proxy access logs, browser history and APM tooling — anyone reading the logs of the box in front of the backend gets a full operator session for up to 12 h, including all of finding 1's admin surface.
- **Fix:** A `POST /events-ticket` returning a one-purpose token with 60 s TTL and no group claims, used only for `GET /events?ticket=`; verify in the middleware for that one path. ~20 lines both sides.
- **If we skip it:** Accepting, then stop logging the query for `/events`, and say so in the deploy notes.

### 16. One scan triggers a full-fleet allocation rewrite with 2+ queries per open item

`apps/backend/src/db/allocate.ts:348-614, 481-573`

- **What this is:** `allocateAll` is the "idempotent recompute": it wipes every unlocked open allocation, then loops every open demand doing `loadLotSources` + `loadReceivingSources` + per-allocation inserts + per-item UPDATEs. `scheduleAllocateAll` fires it after *every* scan, put-away, and admin edit.
- **Problem:** At a few hundred open items that is thousands of statements inside one long transaction, every scan; and the same full pass re-does work any scoped pass (`runScopedAllocation` exists) could do for the few parts that changed. It also holds row locks on every touched lot for the run, so scans queue behind it. The comment even says so: it's why they refuse to `await` it in requests.
- **Fix:** Default the post-mutation trigger to a part-key-scoped run (`scheduleAllocateAll(db, after, (d) => runScopedAllocation(...))`), keeping full `allocateAll` for reorder/cancel; add a statement-count assertion to `apps/backend/src/db/allocate.test.ts`.
- **If we skip it:** It "works" until the fleet is real-sized, then scans take seconds and background runs pile up coalesced one deep forever.

### 17. A partially-failed multi-credit scan leaves stale progress

`apps/pda/composables/useScanMatchers.ts:304-331`, `apps/pda/components/MeasureBox.vue:475-493`

- **What this is:** One label can credit several packages; `apply()` loops `verifyPackage` calls and throws on the first rejection — after earlier credits already committed. The refetch runs only on full success.
- **Problem:** 2nd credit 409s (`label_item_mismatch`) → the 1st credit exists on the server but the screen's `rescannedQty` is unchanged → next scan computes credits from stale totals → repeated or rejected scans on a sealed box.
- **Fix:** `await load()` in the catch/finally of that one handler.
- **If we skip it:** Verify operators double-scan or give up; the box's completion state lags reality.

---

## Nice to have

### 18. Duplicated logic that must change together

`checkBatchAttr` in `apps/pda/composables/usePickingScanQueue.ts:16`, `apps/pda/composables/useScanMatchers.ts:135`, `apps/pda/pages/put-away/[id].vue:308`; `apps/pda/composables/useLabelingOrders.ts` ≡ `apps/pda/composables/useLabelPrintingOrders.ts`; the PDA/backend `dateCode.ts` mirror (`apps/pda/utils/dateCode.ts` vs `apps/backend/src/db/dateCode.ts`)

- **What this is:** Three near-copies of the COO/COW batch check — and they already drifted (one returns an i18n key, two return a rejection object). Two byte-identical list composables. A client copy of tested backend logic.
- **Problem:** A COO rule changed in one of three places → picking rejects what put-away accepts. Nobody notices until a dispute.
- **Fix:** Move `checkBatchAttr` to `utils/` (one implementation), merge the two list composables, put a "keep in sync with backend" pointer comment on `dateCode.ts` (already done there, extend to the pair).
- **If we skip it:** Silent rule drift between screens.

### 19. Flow-config failures that read as "no data"

`apps/pda/composables/useFlowSteps.ts:84-86, 95-96`

- **What this is:** `if (config.cnReceiving)` never propagates an explicit `false`; a failed `/config` is swallowed with no retry.
- **Problem:** Admin disables the CN step → it stays on the operator's home until app restart. Or `/config` fails at login in a `yyww` warehouse → the client stays on `"wwyy"` and rejects *every* date-coded label for the whole session with a nonsense error.
- **Fix:** `!== undefined` check + one retry on the next visibility change (the retry hook already exists).
- **If we skip it:** Rare but head-scratching session-long scan failures.

### 20. Lean: shipped weight and leftovers

`apps/backend/package.json:26`, `apps/admin/package.json:15-19`, plus dead code

- **What this is:** Backend lists `xlsx` as a production dependency but only *tests* import it; admin ships *both* `exceljs` and `xlsx`; dead exports `boxTotalQty` (`apps/pda/utils/box.ts`), `normalizeString` (`apps/pda/utils/text.ts`); unused `entities["inventory-labels"]` config + the unreachable `subInventorySelect` branch in `CrudForm.vue` (`apps/admin/utils/entities.ts:299-315`); `console.log` of full parsed labels (`apps/pda/utils/parseOcrScan.ts:976`, `apps/pda/pages/put-away/[id].vue:370`, `apps/admin/components/InventoryLabelForm.vue:77`, `apps/admin/utils/print.ts:454`); `scan-log.txt` (raw scans) committed; `/dev/*` stays auth-open (`apps/backend/src/auth/middleware.ts:18`) even when the routes are unmounted — move the open-path check behind `DEV_ROUTES`.
- **Problem:** Two Excel libs = two bundles and two CVE surfaces (the npm `xlsx` 0.18 line is unmaintained); logs leak label payloads to the WebView console; dead branches mislead every future reader.
- **Fix:** `xlsx` → backend devDependency; admin export through `exceljs` only; delete the listed dead code and logs.
- **If we skip it:** Nothing breaks; every reader pays the tax.

---

**Smaller ones left out (~8):** legacy `/picking/:id` can't pass shelf context so `pickingShelfScan=require-*` dead-ends two live links into it (`apps/pda/pages/picking/[id].vue:218`); `Pager` doesn't clamp page after deletes (`apps/admin/components/Pager.vue:10,43-46`); `CrudTable` keeps selection across reloads (`apps/admin/components/CrudTable.vue:128-133`); bulk shelf edit fires N parallel PATCHes and hides partial failure (`apps/admin/components/ShelfBulkEditDialog.vue:71`); admin grouped stock-search silently truncates groups >1000 rows and never clears its table cache (`apps/admin/pages/stock-search.vue:226-246`); `AllocationBreakdown` module cache goes stale on other users' changes (`apps/admin/components/AllocationBreakdown.vue:7`); no request body size limit on the CN upload (`apps/backend/src/routes/admin/receivingCn.ts:228`); login QR auto-submits any scan containing `:` (`apps/pda/pages/login.vue:101-114`).

---

## Verdict

Fix 1–5 first — the admin gate (1) and the two inventory-corruption races (2, 3) are the ones that page someone at 2 a.m.; 4 and 5 are one-line/short fixes each. The backend domain code is otherwise well-tested and the transactional-outbox/ledger design is solid; most of what I found is check-then-write without locks and error-state handling in the two Nuxt apps.

**Lean:** ≈ -220 lines, -2 dependencies possible (backend `xlsx` → devDep; admin `exceljs`/`xlsx` → one lib), plus the dead exports/branches in finding 20.

**Not checked:** `db/putaway.ts`, `receiving.ts`, `receivingCn.ts`, `measuring.ts`, `verify.ts`, `allocationSnapshot.ts`, `export/`, the middle of `allocate.ts` (perfect-match pre-pass, manual-pins), `config.ts` validation rules, the native Android Java (scanner plugins), `layers/i18n`, and the 60+ seed-data files were not fully read. No test suite, server, or device was run. Client-side parity of `shelf_scan_required` / date-code canonicalization vs the backend was read from code, not exercised. Findings sourced from the `apps/pda` / `apps/admin` exploration passes were spot-verified by direct reads (beep paths, stuck error card, whitelist race), not re-audited in full.
