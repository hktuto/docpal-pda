# Plan — UAT open items (2026-11-06)

Covers BUG-040, BUG-042, CR-046, CR-047, CR-048 from `docs/uat/`. Grounded in code investigation (file:line refs below are current as of this commit). Execution: parallel sub-agent dev passes over disjoint file sets; no full test-suite runs — `tsc` build + targeted node:test where a file already exists; manual UAT by Sean. No git commits by agents (working tree carries unrelated WIP).

**Not planned:** BUG-041 (NCC 10-digit drawing numbers) — upstream data gap: records missing from Oracle/`wcl_part_drawno`; needs BVS sync, no code fix.

## BUG-040 — COPAL/NIDEC labels with `(...)` in the model never decode

Root cause (reproduced offline): the COPAL template regex's `itemId` character class is `[A-Z0-9][A-Z0-9 ./-]*?` (`apps/backend/src/db/seed-supplier-profiles.ts:69`) — no parentheses. A raw like `... CHS-04TB(34) 1000 ...` fails the whole template → `matched:false` → `no_matching_item`/`noPartNo`. Parts master already has `CHS-04TB(34)` (`seed-parts-data.json`), and 22 COPAL/NIDEC names carry parens (`CAS120B(24)`, `DP1120Z(COLORCAP)`…).

Fix:
1. Widen the COPAL `itemId` class to allow `(` `)` — edit `seed-supplier-profiles.ts` (supplier_code `19915`, profile at `:143-150`).
2. Keep `scripts/sql/restore-supplier-profiles-whhk.sql:107-128` byte-identical to the seed regex (enforced by `new_seed/check-seed-templates.mjs`).
3. Add migration that UPDATEs the live `supplier_profiles` row `19915` to the new regex (dev/production DBs already seeded).
4. Re-validate against the 54 real COPAL raws: `node new_seed/test-qr-templates.mjs` + `check-seed-templates.mjs` must pass. Watch: the `itemId` class feeds into the optional `\s{2,}\d{1,2}` spec token and `ohm(resCode)` groups — confirm no regression on existing samples.
5. Add one test case to `apps/backend/src/decode/template.test.ts` with a parens-bearing raw (the repro string) expecting `itemId = "CHS-04TB(34)"`.

Files: `apps/backend/src/db/seed-supplier-profiles.ts`, `scripts/sql/restore-supplier-profiles-whhk.sql`, new migration, `apps/backend/src/decode/template.test.ts`. Nothing else.

## BUG-042 — assignee filter leaks into the admin console

The admin console reuses PDA queue routes and those routes inject the JWT username unconditionally (`apps/backend/src/routes/picking.ts:82,111,123` → `assigneeFilter` at `db/picking.ts:742,1211`). An admin token ≠ assignee → assigned picking orders vanish from lists (`/admin` pages `picking-orders/index.vue`, `issues/picking.vue`, `picking/reorder.vue`) or detail 404s (`picking_order_not_found`). Spec intent (`user-scope.ts:98-99`, `db/taskAssignments.ts:13-14`): admin/shared callers stay unfiltered. Same latent class in every queue route (14 call sites; CN-receiving/put-away/verify/measuring/labeling — admins call none of them today, but all derive username from `actorFrom(c)` with no group bypass).

Fix (root cause once, keyed on **which client app made the call** — not the user's group, so an admin logged into the PDA still gets the filtered queue):
1. Admin console stamps every request: `apps/admin/utils/api.ts:29-32` adds `headers["X-Client"] = "admin"` (one line; PDA wrapper untouched — its calls keep filtering).
2. Backend helper (next to `actorFrom`, e.g. in `src/auth/jwt.ts`): `visibilityUsername(c)` → `null` when `c.req.header("x-client") === "admin"`, else `actorFrom(c).username`. Read-only task visibility, all routes still require a valid JWT; assignee scoping is a work-routing convenience, not a security boundary (header is spoofable — accepted).
3. Replace the `username: actor.username` arguments at the ~7 assignee-filtered list/detail call sites (`routes/picking.ts:82,111,123`, `receivingCn.ts`, `verify.ts`, `putaway.ts`, `putawayCn.ts`, `measuring.ts`) with the helper.
4. Test: token A (operator) + token B (admin user) with the order assigned to A — `X-Client: admin` sees list + detail, plain call hides/404s. Extend the existing picking routes test if present, else one small test file.

Files: `apps/admin/utils/api.ts`, the helper + 6 route files, one backend test.

## CR-046 — CN receiving scan: expand grouped item, remove a single scan

Today individual scans are NOT rows — `scanCnAgGreGate` only writes aggregate `scan_qty` per invoice line (`db/receivingCnScan.ts:266-374`); per-label raw survives only in `transaction_logs` metadata. Reset is per-line (`:420-450`). So removal needs real scan rows:

1. New table `receiving_cn_scan_events`: `id` (uuid v7), `order_id` → `receiving_orders_cn`, `scan_qty` int, `raw` text, `batch fields` optional, `scanned_by/at`, `takes jsonb` = `[{itemId, qty}]` per line credited (one scan FIFO-credits several lines — `:304-316`), `created_date/last_update_date`. Migration via `db:generate`.
2. In `scanCnTaskAggregate` (inside its tx): insert one event row per scan after crediting. Duplicate-raw rejection can later move server-side (out of scope now).
3. `getCnScanTaskDetail` additionally returns events for the order (or a new `GET /receiving-cn/scan-tasks/:id/scan-events`), each with its line takes so the PDA can attribute events to groups by `cnScanGroupKey`.
4. New endpoint `POST /receiving-cn/scan-tasks/:id/scan-events/:eventId/remove`: tx — for each take, subtract qty from that line's `scan_qty`, re-derive `scan_status` (NULL if back below lineQty/partial, `ok` if equal, per existing rules at `:321-334`), clear over-scan `warning` state accordingly, delete the event row, audit to `transaction_logs`, SSE `item_updated`. Refuse (409 `already_finalized`) unless order status `scanning`.
5. PDA `apps/pda/pages/receiving-cn-scan/[id].vue`: make each group row expandable (chevron) — expanded panel lists its scan events (time, qty, `raw` truncated, scanned_by) with a Remove button + confirm. Replaces the whole-group `resetGroup` flow only where events exist; keep group reset for legacy rows with no events (pre-migration scans have none — `shortcut:` legacy rows can't be listed/removed individually, whole-group reset stays).
6. Service: `warehouse.ts` interface + `backendWarehouse.ts` methods `listCnScanEvents` / `removeCnScanEvent`; types in `types.ts`; i18n keys all 3 locales in `layers/i18n`.

Files: `schema/receivingCn.ts`, migration, `db/receivingCnScan.ts`, `routes/receivingCn.ts`, pda page (+ component under `components/receiving-cn-scan/` if page gets big), `services/{warehouse,types,adapters/backendWarehouse}.ts`, i18n locales, backend route test touch-ups.

## CR-047 — CN flag partial qty + Finish shortfall prompt

Current flag is all-or-nothing (`flagCnItem` `:382-416` sets `scan_status='error'`; finalize zeroes every error line `:501-513`), so flagging a 60/100 line loses the 60. The Finish prompt + `unresolvedAs:'missing'` auto-loop already exist (page `:383-404`, backend `:484-498`) but only for wholly-open lines and they zero partial lines too.

1. Schema: add nullable `flag_qty` integer to `receiving_invoice_items_cn` ("units of this line declared [reason] short"; NULL + error = whole line). Do NOT reuse the dormant `mismatch_qty` mirror (different admin semantics).
2. `flagCnItem` accepts optional `qty` (positive int ≤ remaining = lineQty − scanQty; validate → 400 `invalid_flag_qty`). Sets `scan_status='error'`, `scan_reason`, `flag_qty`. Whole-line flag = no qty (current behavior).
3. Finalize `received_qty` CASE (`:501-513`): error line with `scan_qty > 0` and `flag_qty` set → `received = scan_qty` (capped at lineQty); error without flag_qty → 0 (today). `unresolvedAs:'missing'` loop: for lines with `scan_qty > 0`, set `flag_qty = lineQty − scan_qty` (preserve scanned) instead of blanket error-0; lines with no scans unchanged.
4. PDA flag modal (`openFlag`/`submitFlag` page `:158-189`): add optional qty input per group defaulting to the shortfall (Σ lineQty − Σ scanQty), prefilled empty = whole-line; submit loops open lines with the qty split FIFO-ish (simplest: apply the shortfall to one line's flag at a time — reuse existing per-item endpoint).
5. PDA Finish modal: currently only counts `unresolvedCount` (status NULL). Extend to shortfall lines (partial: scan>0 < lineQty) — list both, single confirm "mark remaining as missing & finish" calling finalize `unresolvedAs:'missing'` (backend now preserves scanned qty per #3).
6. Admin: show `flag_qty` in `/admin/receiving-cn/orders/:batchNo` detail (`db/receivingCn.ts:847-860` — already omits scan_* columns; add flag_qty + scan_qty display only if trivial via existing fields, else record follow-up — `shortcut:`).

Files: schema + migration, `db/receivingCnScan.ts`, `routes/receivingCn.ts`, pda page, `types.ts` (`CnFlagItemInput.qty?`), service adapter, i18n locales, update `routes/receivingCnScan.test.ts` expectations (zeroing of error lines changes).

## CR-048 — Admin task assignment: per-step assignee view

Today `/task-assignments` = one tab per queue (8 flows), each row one assignee picker (`GET /admin/task-assignments?flow=` / `PATCH /admin/task-assignment` — `db/taskAssignments.ts:50-181`, page `:13-22`). Admins want a task's assignee per workflow step visible/editable in one place.

Data reality: a "task" is not one entity across steps — the chain is per order/batch: `receiving_orders_cn(batch_no)` → `put_away_tasks_cn` (batch link) and `picking_orders(order_no)` → labeling → label-printing → measuring(shipping_boxes) → verify_tasks → shipping_boxes (linked by order/box nos; `listTaskAssignments` rows already carry context columns `batchNo/orderNo/boxId/orderNos`).

Design (smallest that answers "see assignee for different steps"):
1. Backend: `GET /admin/task-lifecycle?orderNo=` (also accept `batchNo=`) — reuse the 8-flow table queries from `db/taskAssignments.ts`, matched by the order/batch key, return `{steps: [{flow, id, label, status, assignee}]}` sorted receiving→…→shipping. No schema change; editing stays the existing `PATCH /admin/task-assignment {flow,id,assignee}`.
2. Admin UI `apps/admin/pages/task-assignments.vue`: add an "All steps" tab (or expandable per-row detail) showing the lifecycle view for a searched order: one line per step, per-step status + assignee `SearchableSelect` inline edit (reuse existing picker + optimistic PATCH logic at `:70-85`). Add `getTaskLifecycle` to `utils/flowApi.ts` and i18n keys.
3. Matching keys: picking↔verify↔shipping via order_no; receiving-cn↔put-away-cn via batch_no; document that a row with no match in a step just doesn't appear for that step.

Files: `db/taskAssignments.ts`, `routes/admin/taskAssignments.ts`, `apps/admin/pages/task-assignments.vue`, `apps/admin/utils/flowApi.ts`, i18n locales. Keep PDA untouched.

## Sequencing (sub-agent dispatch)

- Wave 1 (parallel, disjoint files): BUG-040 (decode/seed/sql/migration) · BUG-042 (user-scope + 6 routes + test) · CR-048 (admin task-assignment trio + flowApi + i18n).
- Wave 2 (after wave 1 — shares i18n locales + receives CR-046 before CR-047 UI on the same page): CR-046 + CR-047 in one agent (same backend module + same PDA page; two migrations land in one pass).
- Verify cheaply: `pnpm --filter @warehouse/backend build` (+ `pda nuxt prepare`) after each wave; update UAT json statuses (`Open→Ready for retest` / `New→In progress`) with commit-less remarks pointing at this plan file.
