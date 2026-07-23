# Picking order priority + page-locked re-allocation — implementation plan

Spec: `docs/superpowers/specs/2026-07-23-picking-priority-allocation-design.md`

1. **Schema** `apps/backend/src/db/schema/picking.ts`: add to `pickingOrders`
   - `prioritySeq: integer("priority_seq").notNull().default(0)`
   - `workingBy: text("working_by").references(() => users.id)` (nullable)
   - `workingAt: timestamp("working_at", { mode: "date" })` (nullable)

   Run `pnpm --filter @warehouse/backend db:generate`; edit the generated
   migration to backfill
   `UPDATE picking_orders SET priority_seq = r.seq FROM (SELECT id, row_number() OVER (ORDER BY created_at) AS seq FROM picking_orders) r WHERE picking_orders.id = r.id`.
2. **Engine** `apps/backend/src/db/allocate.ts`:
   - `loadDemands`: join orders not protected by a live lock
     (`working_at IS NULL OR working_at < now() - interval '10 minutes'` AND
     `working_by IS NULL` handling); select per-item
     `openQty = pi.qty − COALESCE(Σ picking_packages.qty, 0)` (subquery on
     `picking_packages`), keep `openQty > 0`; ORDER BY
     `po.priority_seq, pi.id`. Drop the `picked_qty = 0` guard.
   - Wipe/rebuild path unchanged otherwise (delete allocations of
     participating items, RESERVE reversals, rebuild lot-first then receiving,
     net-change compare, `allocation.computed`).
3. **Work lock** `apps/backend/src/db/picking.ts` +
   `apps/backend/src/routes/picking.ts`:
   - `acquireWorkLock(db, { orderId, actorId })` → `POST /picking-orders/:id/work-lock`:
     order must be pending/picking (404/409 otherwise); live lock by another
     user → 409 `lock_held` (+ holder id/name in the error payload via a
     JSON body, not plain message); else upsert `working_by`/`working_at`.
   - `releaseWorkLock(db, { orderId, actorId })` → `DELETE /picking-orders/:id/work-lock`:
     clears only if caller is the holder (silently ok otherwise — sendBeacon
     has no response handling).
   - `maybeAutoFinishPickingOrder`: clear `working_by`/`working_at` on finish.
   - Expiry constant `WORK_LOCK_TTL_MINUTES = 10` shared between allocate and
     lock acquire (put it in `allocate.ts` or a small `worklock.ts`).
4. **Ingest** `apps/backend/src/db/ingest.ts`: picking-order insert sets
   `priority_seq = (SELECT COALESCE(MAX(priority_seq),0)+1 FROM picking_orders)`;
   updates untouched.
5. **Reorder** `apps/backend/src/db/picking.ts` `reorderPickingOrders(db,
   { actorId, orderIds })` + `POST /picking-orders/reorder`: validate ids
   (400 `invalid_order_ids`), rewrite seq 1..n in one tx, `emitEvent`
   `picking.reordered` (topics `["/picking-orders"]`); after commit
   `reallocateBestEffort("reorder")`.
6. **List order** `listPickingOrders`: ORDER BY `po.priority_seq ASC,
   po.created_at`; include `workingBy`/holder name in the row for the list badge.
7. **Web** (`apps/web`):
   - `composables/usePickingWorkLock.ts`: `acquire(orderId)` on mount, 3-min
     interval refresh, `sendBeacon` DELETE on unmount (skip release when
     navigating to the same order's scan-session route), exposes
     `heldByOther` state from a 409 response.
   - `pages/picking/[id].vue` + `pages/picking/scan/[id].vue`: use the
     composable; when `heldByOther`, show a "held by <name>" banner and
     disable scan/edit actions (read-only).
   - `services/adapters/backendWarehouse.ts` + `services/warehouse.ts`:
     `acquirePickingWorkLock` / `releasePickingWorkLock` /
     `reorderPickingOrders` (sendBeacon needs a raw `fetch` with the JWT
     header — check `apiClient` keepalive support, else small raw fetch).
   - List page: show lock badge from `workingBy` (optional, cheap).
8. **Tests**:
   - `src/db/allocate.test.ts`: priority order; live-locked order untouched;
     expired-locked order rebuilt; unboxed-package remainder not
     double-reserved; partially picked remainder re-allocated.
   - `src/db/picking.test.ts`: work-lock acquire/refresh/409/release/
     finish-auto-clear/expired-reacquire; reorder seq rewrite + 400 + event.
   - `src/db/ingest.test.ts`: seq assignment on insert, stable on re-upsert.
   - Web vitest: `usePickingWorkLock` acquire/heartbeat/release logic
     (mock fetch + timers).
9. **Verify**: backend suite (`pnpm --filter @warehouse/backend test`),
   `build`, boot dev (migration auto-applies), manual smoke with two browser
   sessions: A opens order → B sees held banner; A closes → B acquires;
   reorder via curl → list order + allocations follow; kill A's browser →
   after 10 min a recompute reallocates the order.
10. **Docs**: `docs/backend/concepts.md` §6 + `docs/backend/README.md`
    route/event catalog; `AGENTS.md` allocation paragraph;
    `docs/app-docs/flows/picking/ai-scope.md`, `docs/app-docs/ai/code-map.md`,
    `docs/app-docs/ai/feature-registry.md`.
