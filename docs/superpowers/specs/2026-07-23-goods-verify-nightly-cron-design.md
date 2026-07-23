# Goods-verify nightly generation cron — design

Date: 2026-07-23
Status: draft

## Problem

Goods-verify day-end tasks are generated only when someone presses the
generate button in the web app (`POST /goods-verify-tasks/generate`). Nobody
presses it → no verification tasks next morning.

## Decision

Nightly server-side scheduler in the long-running entry (`src/server.ts` —
never runs on Vercel, where generation stays manual):

- New module `apps/backend/src/jobs/goodsVerifyDayEnd.ts`:
  - `runGoodsVerifyDayEnd(db)` — calls `generateGoodsVerifyTasks` for
    **two dates**: DB `CURRENT_DATE - 1` and DB `CURRENT_DATE`. Movement rows
    are bucketed by the DB server's date (session UTC) while the fire time is
    local midnight, so the just-ended business day can span two DB dates;
    both runs are idempotent via the `(task_date, inventory_lot_id)` unique
    index, and together they cover the whole business day in any timezone.
  - `startGoodsVerifyDayEndCron(db)` — `setTimeout` to the next local 00:00,
    re-armed after each run (no cron dependency); timer is `unref`'d; errors
    are logged, never thrown. Runs once at boot as catch-up (idempotent) so a
    server that was off at midnight still generates. Disable with
    `GOODS_VERIFY_CRON=off`.
- `src/server.ts` starts it next to `pruneEvents`.

The manual `POST /goods-verify-tasks/generate` endpoint and the web button
stay — the cron just makes the nightly run automatic.

## Out of scope

- Vercel scheduled functions (hosted dev stays manual).
- Configurable fire time / timezone.

## Testing

- `src/db/goodsverify.test.ts`: seed a lot movement with `txn_at` yesterday →
  `runGoodsVerifyDayEnd` creates a task dated yesterday; re-run creates none
  (idempotent).
