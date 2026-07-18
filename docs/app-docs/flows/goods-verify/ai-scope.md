# Goods Verify — AI Scope and Remarks

## In scope

- Daily goods-verify **task queue**: one pending task per inventory lot that
  moved (received, put away, picked, adjusted) on a given date.
- Generate the day's tasks on demand from the queue page (idempotent per
  task date + lot — re-generating creates no duplicates).
- Filter the queue by date (defaults to today, UTC) and status
  (`pending` / `verified` / `skipped`), plus a client-side text search over
  shelf / box / part number.
- Task detail: the lot's batch fields (date code, lot code, COO/COW), its
  three-level location (warehouse → section → sub-inventory, plus shelf/box),
  quantities (expected / current total / allocated / available), and the
  shelf box with its item rows when the lot is boxed.
- Verify a task with an optional counted quantity:
  - Empty / matching count → task flips to `verified`, lot untouched.
  - Different count → the lot's `total_qty` is corrected and an `ADJUST`
    row is written to the inventory ledger server-side.

## Out of scope

- The old shelf-browse UX (shelf list → box list → box detail with
  scan-to-verify per part) — removed in the 2026-07 backend migration;
  verification is now task-based, one call per task.
- Pre-shipment box verification as a separate flow (the new backend has no
  `verification_tasks` table; box close/verify happens in measuring).
- Automated quality inspection, photo capture, QA-system integration.

## Key files

- `pages/goods-verify/index.vue` — task queue: date picker, status filter
  chips, search, "Generate today's tasks" button.
- `pages/goods-verify/[id].vue` — task detail: lot batch/location/qty rows,
  box contents, verify form with countedQty + ADJUST consequence hint.
- `services/adapters/backendWarehouse.ts` — `generateGoodsVerifyTasks`,
  `getGoodsVerifyTasks`, `getGoodsVerifyTask`, `verifyGoodsVerifyTask`.
- `services/types.ts` — `GoodsVerifyTaskListRow`, `GoodsVerifyTaskFilters`,
  `GoodsVerifyTaskDetail` DTOs.
- `apps/backend/src/routes/goodsverify.ts` + `apps/backend/src/db/goodsverify.ts` —
  `POST /goods-verify-tasks/generate` (day-end task creation from
  `inventory_transactions`), `GET /goods-verify-tasks` (filters `date`,
  `status`, `shelfCode`), `GET /goods-verify-tasks/:id`,
  `POST /goods-verify-tasks/:id/verify` (optional `countedQty`; writes the
  ADJUST ledger row and corrects the lot when the count differs).

## Known limitations

- Task dates are UTC ("today" = the backend DB's `CURRENT_DATE`); the date
  picker matches that, not the operator's local day.
- Only lots with ledger movements on the task date get tasks — a lot that
  did not move that day never appears in the queue.
- Demo-only: verification is a simplified count confirm/adjust; no image or
  signature capture.

## Related specs/plans

- `docs/backend/api-design.md` §Goods verify (task-based, concept 7)
- `docs/backend/concepts.md` — goods-verify task concept
