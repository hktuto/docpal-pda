# Verify step (picking → measuring → verify → shipping) + global flow-step config

Date: 2026-07-28
Status: implemented

## Problem

Two gaps at the shipping end of the flow:

1. **No second check between measuring and shipping.** Completing a measuring task makes the order "ready to ship", but nothing lets a second worker re-check box contents and measurements before the boxes leave. Boxes can't even be corrected: every box mutation requires status `open`, and there is no reopen verb for a closed shipping box.
2. **No way to turn flow steps off.** A deployment that doesn't use every PDA step (no measuring station, no cycle counts) cannot remove steps from the menu or the backend chain — `measuring_tasks` rows are created unconditionally at picking finish, and goods-verify tasks generate nightly regardless.

## Decisions

- **Verify = a full re-measure pass** (user decision): the worker may reopen boxes, edit measurements, and re-verify packages — not a read-only checklist. Box work reuses the existing picking verbs (`PATCH /shipping-boxes/:id`, `POST /packages/:id/verify`, `POST /shipping-boxes/:id/close`); the verify step only adds the task table + completion endpoint and the reopen verb.
- **Every menu step is toggleable** (user decision): `receiving`, `put-away`, `picking`, `goods-verify`, `measuring`, `verify`, `stock-search`.
- **Config is env-based** (user decision): one backend env var, no admin UI, no DB table. Changes need a backend restart; the PDA fetches `GET /config` once after login.

## Backend changes (`apps/backend`)

### 1. Flow-step config (`src/config.ts`)

- Env var `FLOW_STEPS_DISABLED` — comma-separated step keys, e.g. `FLOW_STEPS_DISABLED=measuring,verify`. Unset/empty = all steps enabled; unknown keys are ignored.
- Parsed once at import time into a module-level `Set`; `isStepEnabled(step: FlowStep)` plus a test-only `_setFlowStepsDisabledForTests()` override (the env is read at import time, so tests can't rely on `process.env`).
- `GET /config` (`src/routes/config.ts`) → `{ flowSteps: Record<FlowStep, boolean> }`; it goes through the standard auth middleware (the PDA calls it after login).

Only three toggles change backend behavior:

- `measuring` / `verify` — rewire the picking-finish chain (below).
- `goods-verify` — `generateGoodsVerifyTasks` becomes a no-op, which gates both `POST /goods-verify-tasks/generate` and the nightly `src/jobs/goodsVerifyDayEnd.ts` job.

The other steps' endpoints stay functional; their toggles only hide PDA home tiles.

### 2. `verify_tasks` table (migration `0003_tidy_red_skull.sql`)

Clone of `measuring_tasks`: `id` PK, `picking_order_id` NOT NULL FK → `picking_orders(id)` ON DELETE CASCADE, `status` (`pending` | `completed`) default `pending`, `created_at`; unique index `idx_verify_tasks_picking_order` (one verify task per order — makes the chain inserts `ON CONFLICT (picking_order_id) DO NOTHING`-idempotent).

### 3. Chain logic

- `maybeAutoFinishPickingOrder` (`src/db/picking.ts`): after flipping the order to `finished` — measuring enabled → insert a measuring task; else verify enabled → insert a verify task directly; else → nothing (finished = ready to ship).
- `finishPickingOrder`: the `measuring_task_exists` guard now fires when either task row exists; returns the created task, or null when both steps are off.
- `completeMeasuringTask` (`src/db/measuring.ts`): after completion, when verify is enabled → `INSERT INTO verify_tasks ... ON CONFLICT (picking_order_id) DO NOTHING`.
- New `src/db/verify.ts` + `src/routes/verify.ts`, mirroring measuring: `GET /verify-tasks?status=` (list with server-side `boxCount`/`closedBoxCount`), `GET /verify-tasks/:id` (consolidated `{task, order, boxes[packages]}` with part identity embedded), `POST /verify-tasks/:id/complete` — same guards and semantics as measuring completion (status flip + `transaction_logs` row, no stock movement, picking order stays `finished`).

### 4. Reopen for re-measure during verify

- `verifyPackage` task guard relaxed: a pending measuring **or** verify task allows verification; the 409 code is the neutral `no_pending_measure_or_verify_task`.
- `reopenShippingBox` (`src/db/picking.ts`) + `POST /shipping-boxes/:id/reopen`: 409 `shipping_box_not_closed` unless the box is closed; 409 `verify_task_not_pending` unless the order has a pending verify task (reopen is a verify-step action only). Effect: box → `open`, its packages lose `verified`, transition log with `metadata {reopen: true}`. `closeShippingBox`'s auto-finish re-check is a no-op for the already-`finished` order (`maybeAutoFinishPickingOrder` returns early unless the order is `pending`/`picking`), so re-closing never creates duplicate tasks.

### 5. Config-aware shipping feed for admin

- New `src/db/shipping.ts` + `src/routes/shipping.ts`:
  - `GET /shipping-orders` → rows `{source: 'verify'|'measuring'|'picking', taskId, pickingOrderId, orderNo, shipTo, boxCount, closedBoxCount, completedAt}` — completed verify tasks when the verify step is on, else completed measuring tasks (the old shipping list), else finished picking orders with no task rows (`updated_at` approximates the finish time; there is no `finished_at` column).
  - `GET /shipping-orders/:pickingOrderId` → task-agnostic `{order, boxes[packages]}` detail (same shape as the measuring/verify detail). 404 `picking_order_not_found`.

## Web changes (`apps/web`)

- Services (`services/warehouse.ts` + `services/adapters/backendWarehouse.ts`): `getVerifyTasks(status?)`, `getVerifyTask(id)`, `completeVerifyTask(id)`, `reopenShippingBox(boxId)`, `getFlowConfig()`; `VerifyTaskListRow`/`VerifyTaskDetail` mirror the measuring DTOs. `MUTATION_INVALIDATIONS` (`services/apiClient.ts`) extended so measuring/box/package mutations also invalidate `/verify-tasks`.
- `composables/useFlowSteps.ts`: shared ref defaulting all-enabled; `loadFlowSteps()` fetches `GET /config` once per login from `layouts/default.vue`'s session watch (safe no-op while logged out; no polling — the env only changes on a backend restart).
- `pages/index.vue`: new **Verify** tile between measuring and stock-search; every tile wrapped in `v-if="flowSteps['<step>']"`.
- Verify pages mirror measuring: `pages/verify/index.vue` (pending list), `pages/verify/[id].vue` (detail; scan a box QR/id to jump straight in; **Reopen** action on closed boxes while the task is pending), `pages/verify/[taskId]/box/[boxId].vue`. The measuring box-page body was extracted into `components/MeasureBox.vue` (props `taskId`, `boxId`, `loadDetail`) shared by both flows.
- i18n (`layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`): `verify.*` block mirroring `measuring.*`, `home.menu.verify.*`, `meta.verify/verifyDetail`, `status.verify.*`, `common.noPendingVerifyTasks`, `actions.reopenBox`, and the new error-code keys.

## Admin changes (`apps/admin`)

- `utils/flowApi.ts`: `ShippingOrderRow`/`ShippingOrderDetail` types + `listShippingOrders()` / `getShippingOrder(pickingOrderId)`.
- `pages/shipping/index.vue` and `pages/shipping/[id].vue` read the config-aware feed (the detail route param is now the picking order id). Multi-select/search/paging unchanged.
- No step-config UI (env-based per decision).

## Error codes

New: 404 `verify_task_not_found`, 409 `verify_task_not_pending`, 409 `shipping_box_not_closed`, 409 `no_pending_measure_or_verify_task` (replaces the measuring-only `measuring_task_not_pending` guard on `POST /packages/:id/verify`). Reused unchanged: 400 `actor_not_found`, 409 `shipping_boxes_not_all_closed`, 409 `picking_items_not_fully_packed`, 409 `measuring_task_exists` (now also fires when a verify task exists), 404 `picking_order_not_found` (shipping detail).

## Tests

- `src/db/verify.test.ts` mirrors the measuring suite (list/detail/complete guards + happy path) and covers the chain per config combination (measuring off → verify task at finish; both off → no tasks and the order appears in the shipping feed with `source='picking'`; measuring on + verify on → completing measuring spawns the verify task) and the reopen lifecycle (reopen → re-verify → re-close → complete; reopen rejected without a pending verify task).

## Out of scope

- Admin UI for toggling steps (env-only per decision).
- A real `shipped` state / shipper Excel download (existing placeholder — the shipping feed is still a read-only list).
- SSE events for measuring/verify (pages poll on visibility — unchanged).
