# Goods Verify — AI Scope and Remarks

## In scope

- Daily goods-verify **task queue**: one pending task per **shelf** with a
  non-zero net `on_hand` movement (`qty_type='on_hand'`, `HAVING SUM(qty_delta) != 0`,
  `shelf_code IS NOT NULL`) on a given date. The per-part movements are stored
  as a `movements` jsonb snapshot on the task row
  (`[{partNo, wclItemNo, description, qtyChange, currentTotal}]`).
- Generate the day's tasks automatically: the backend runs day-end
  generation every night at local 00:00 (`src/jobs/goodsVerifyDayEnd.ts`,
  generating DB `CURRENT_DATE-1` + `CURRENT_DATE` with a boot catch-up;
  `GOODS_VERIFY_CRON=off` disables). There is no
  generate button in the app — `POST /goods-verify-tasks/generate` remains
  for manual/server-side runs (idempotent per task date + shelf via
  `ON CONFLICT (task_date, shelf_code) DO NOTHING`, unique index
  `goods_verify_tasks_shelf_day_unique`). Generation emits SSE
  `goods_verify.tasks_created` (topic `/goods-verify-tasks`); the whole step
  is a no-op when the `goods-verify` flow step is disabled.
- Filter the queue by date (defaults to today, UTC) and status; the list
  subscribes to the `/goods-verify-tasks` topic for reloads.
- Task detail: shelf header (task date, movements count) + one card per moved
  part (`qtyChange`, `currentTotal` — the shelf's total stock for that part
  across all lots, not just the moved one). The read returns `{task}` only.
- Verify a task as a **pure confirmation**: `pending → verified` +
  `verified_by/at` + a `transaction_logs` transition row. **No counted-qty
  entry, no ADJUST, no lot correction** — discrepancies are fixed outside
  this flow.

## Out of scope

- Stock correction of any kind (stock adjust, re-scan credits, put-away
  fixes) — this flow confirms the system's recorded movements.
- The pre-2026-10-17 per-lot count model (countedQty input + ADJUST ledger
  write + `shelf_box closed→verified` browse) — **redesigned away** in
  `docs/superpowers/specs/2026-10-17-goods-verify-shelf-summary-redesign.md`
  (commit `f62a1de6`). Legacy columns `inventory_lot_id`, `box_id`,
  `part_no`, `expected_qty` remain on the table but are nullable and unused.
- Assignee scoping — `goods_verify_tasks` deliberately has no `assignee`
  column (see `docs/app-docs/ai/feature-registry.md`).
- Automated quality inspection, photo capture, QA-system integration.

## Key files

- `pages/goods-verify/index.vue` — task queue: date picker, status filter
  chips, search (⚠ the search body still filters on `boxId`/`partNo`/
  `wclItemNo` fields that the 2026-10 redesign removed from the list-row DTO
  — typed input throws; tracked as BUG-048).
- `pages/goods-verify/[id].vue` — movement-summary detail + single Confirm
  button; header/title/status via `composables/usePageHeader.ts`.
- `services/adapters/backendWarehouse.ts` — `getGoodsVerifyTasks`,
  `getGoodsVerifyTask`, `verifyGoodsVerifyTask`.
- `services/types.ts` — `GoodsVerifyTaskListRow`, `GoodsVerifyTaskDetail`
  DTOs (task + movements only).
- `apps/backend/src/routes/goodsverify.ts` + `apps/backend/src/db/goodsverify.ts` —
  `POST /goods-verify-tasks/generate` (day-end task creation from
  `inventory_transactions`), `GET /goods-verify-tasks` (filters `date`,
  `status`, `shelfCode`), `GET /goods-verify-tasks/:id`,
  `POST /goods-verify-tasks/:id/verify` (empty body; actor from JWT; 409
  `goods_verify_task_not_pending`).
- `apps/backend/src/jobs/goodsVerifyDayEnd.ts` — nightly 00:00 scheduler
  (started by `src/server.ts`).

## Known limitations

- Task dates are UTC ("today" = the backend DB's `CURRENT_DATE`); the date
  picker matches that, not the operator's local day.
- Only shelves with ledger movements **on the task date** get tasks; a shelf
  that did not move never appears, and zero-delta parts are dropped.
- `movements` is a generation-time snapshot — `currentTotal` goes stale after
  later stock moves, and verify never refreshes it.
- The status vocabulary declares `skipped`, but no code path writes it (the
  list's `skipped` chip can never match).
- `allowedOrgIds` does **not** filter this queue (unlike other reads).

## Related specs/plans

- `docs/superpowers/specs/2026-10-17-goods-verify-shelf-summary-redesign.md` — current model
- `docs/superpowers/specs/2026-07-23-goods-verify-nightly-cron-design.md` — the cron
- `docs/backend/api-design.md` §Goods verify, `docs/backend/concepts.md`
