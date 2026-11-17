# Goods verify count mode — implementation plan

Spec: `docs/superpowers/specs/2026-11-18-goods-verify-count-mode-design.md`

Order: backend (config → db → migration → routes → tests) → PDA → admin →
docs/UAT → verify → commit.

## 1. Backend flow-config knob

- `apps/backend/src/config.ts`
  - `GoodsVerifyMode = "confirm" | "count"` + `GOODS_VERIFY_MODES` const
    (copy `PICKING_SHELF_SCAN_MODES` style, ~line 318).
  - `GoodsVerifyConfig` interface + `FlowConfig.goodsVerify: GoodsVerifyConfig`
    (next to `PutAwayConfig`, ~lines 242/324).
  - `defaultFlowConfig()` → `goodsVerify: { mode: "confirm" }`.
  - `mergeFlowConfigJson` step-merge chain (~lines 879–906): add
    `step === "goods-verify" && stepKey === "mode"` branch → validate enum →
    `cfg.goodsVerify.mode = …`.
  - Accessors: `goodsVerify()` (~line 974 style) +
    `_setGoodsVerifyConfigForTests` (~line 1077 style).
- `apps/backend/src/routes/config.ts` — `GET /config` payload += `goodsVerify`.

## 2. Backend domain — `apps/backend/src/db/goodsverify.ts`

- `saveGoodsVerifyCount(db, {taskId, partNo, qty, actorId})` — tx:
  task 404; `goodsVerify().mode !== "count"` → 409
  `goods_verify_count_mode_disabled`; status ∈ pending/counted else 409;
  part must be in `movements` jsonb else 400 `goods_verify_part_not_found`;
  `Number.isInteger && >= 0` else 400 `invalid_count_qty`; upsert
  `goods_verify_task_counts ON CONFLICT (task_id, part_no) DO UPDATE`;
  `pending → counted`; `emitEvent goods_verify.count_updated` topic
  `/goods-verify-tasks`; return refreshed row via `getGoodsVerifyTaskRow`.
- `confirmGoodsVerifyTask(db, {taskId, actorId})` — tx: mode=count; status
  `counted` else 409 `goods_verify_task_not_counted`; `liveTotalsForShelf()`
  (`SUM(total_qty) FROM inventory_lots WHERE shelf_code AND part_no IN …`);
  every movement line must have a count (else 409
  `goods_verify_task_incomplete`) and `count == liveTotal` (else 409
  `goods_verify_task_mismatch`); → verified + by/at + transition log; emit
  `goods_verify.task_confirmed`.
- `rejectGoodsVerifyTask(db, {taskId, actorId})` — tx: mode=count; status
  `counted` else 409; → pending, `DELETE FROM goods_verify_task_counts`,
  transition log metadata = rejected counts snapshot; emit
  `goods_verify.task_rejected`.
- `verifyGoodsVerifyTask` — 409 `goods_verify_confirm_mode_disabled` when
  `mode !== "confirm"`.
- `listGoodsVerifyTasks` — add `countsCount` subselect.
- `getGoodsVerifyTaskDetail` — add `lines` (movement enriched with liveTotal +
  counted fields) and `progress {countedLines, totalLines}`; extract shared
  `taskLines(tx, task)` helper reused by confirm (single live-totals query).

## 3. Migration `apps/backend/drizzle/0068_<name>.sql`

Header comment citing the spec; `CREATE TABLE goods_verify_task_counts`
(columns per spec; `CHECK (counted_qty >= 0)`; FKs to `goods_verify_tasks(id)`
and `users(id)`), `CREATE UNIQUE INDEX … (task_id, part_no)`, index on
`task_id`. Journal entry via `pnpm --filter @warehouse/backend db:generate`
workflow — hand-write SQL in the same style as 0067 (statement-breakpoints)
and let drizzle-kit pick it up, or write schema in `schema/inventory.ts` and
generate. (Schema-first: add the table to `schema/inventory.ts`, run
`db:generate`.)

## 4. Routes

- `apps/backend/src/routes/goodsverify.ts` — `POST /goods-verify-tasks/:id/counts`.
- New `apps/backend/src/routes/admin/goodsVerify.ts` — confirm + reject
  POSTs (`actorFrom(c).id`); mount in `routes/admin/index.ts`
  (`adminRoute.route("/", adminGoodsVerifyRoute)`).

## 5. Backend tests

- `config.test.ts` — `goodsVerify.mode` merge/validation/default.
- `goodsverify.test.ts` — extend existing file:
  - count save: happy path (pending→counted), upsert overwrite, 404,
    part-not-in-movements 400, qty 400s, verified 409, confirm-mode 409
    (via `_setGoodsVerifyConfigForTests`).
  - detail: `lines` + liveTotal + progress.
  - confirm: all-match → verified; incomplete → 409; mismatch → 409;
    from pending → 409.
  - reject: counted → pending + counts cleared; from pending → 409.
  - `/verify` blocked in count mode.
  - Reuse `putAwayFixture` (parts on `A0103`) so live totals are real.

## 6. PDA

- `services/types.ts` — `FlowConfig.goodsVerify?: { mode?: … }`;
  `GoodsVerifyCountLine`, `GoodsVerifyTaskLine`, extend detail DTO with
  `lines`/`progress`; list row `countsCount`.
- `services/warehouse.ts` + `services/adapters/backendWarehouse.ts` —
  `saveGoodsVerifyCount(id, partNo, qty)` POST (fix the stale
  countedQty comment while there).
- `composables/useFlowSteps.ts` — `goodsVerifyMode` ref (default `"confirm"`)
  + merge in `loadFlowSteps`.
- `composables/useWarehouseEvents.ts` — `KNOWN_EVENT_TYPES` += the three new
  `goods_verify.*` types.
- `pages/goods-verify/[id].vue` — mode branch: `count` = blind per-line
  input + save (packaging `num()` pattern; integer ≥ 0; toast on error);
  saved ✓ + counted-at; no system figures; no confirm button; SSE topics
  `["/goods-verify-tasks"]`.
- `pages/goods-verify/index.vue` — per-mode status chips (count mode:
  pending/counted/verified); BUG-048: search filters `shelfCode` only.
- i18n (3 locales in `layers/i18n`) — `status.goodsVerify.counted`,
  `goodsVerify.count.*` labels + snake_case error keys.

## 7. Admin

- `utils/flowApi.ts` — `listGoodsVerifyTasks`, `confirmGoodsVerifyTask`,
  `rejectGoodsVerifyTask` + DTOs.
- `pages/goods-verify/index.vue` + `[id].vue` — Gen-A after
  `internal-transfer-orders`: date + status `SearchableSelect`, progress
  column, detail lines table (liveTotal vs countedQty + diff badge),
  confirm/reject buttons with `window.confirm`, `useChangeNotice` on
  `goods_verify.count_updated|task_confirmed|task_rejected`.
- `utils/entities.ts` `navSections` + `admin.navLinks.goodsVerify` in 3
  locales; flow-step gate not needed (page is mode-agnostic; in confirm mode
  it is a read-only audit view — confirm/reject buttons only render in count
  mode).
- `pages/flow-config.vue` — `goodsVerify.mode` SearchableSelect editor;
  include in save body.
- `composables/useFlowSteps.ts` (admin) — expose `goodsVerifyMode` if not
  already shared.

## 8. Docs + UAT

- Update: `docs/backend/flow-config.md` (new knob paragraph),
  `docs/backend/api-design.md` §Goods verify, `docs/backend/event-catalog.md`
  (3 new types), `docs/app-docs/flows/goods-verify/{overview,steps,ai-scope}.md`,
  `docs/app-docs/ai/{feature-registry,code-map}.md`,
  `docs/dev-guide-zh/flows/goods-verify.md`.
- `docs/uat/functions.json` — new admin function (next `ADM-` id);
  `node scripts/gen-uat-xlsx.mjs`.
- `docs/uat/bugs/BUG-048.json` — mark fixed with commit once known.

## 9. Verify

- `pnpm --filter @warehouse/backend test` && `pnpm --filter @warehouse/backend build`
- `pnpm --filter @warehouse/pda nuxt prepare` && `pnpm --filter @warehouse/pda test`
- Manual: `pnpm dev:backend` + `dev:pda` + admin; flip mode in
  `/admin/flow-config`; `POST /goods-verify-tasks/generate`; PDA blind-count;
  admin confirm + reject paths; flip back to confirm — HK behavior unchanged.

## 10. Commit

Single commit `feat(goods-verify): count mode — PDA blind count + admin compare/confirm/reject`
(or split backend/pda/admin if the diff gets unwieldy).
