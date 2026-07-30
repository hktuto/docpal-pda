# Picking order allocation_status + shipped state — implementation plan

Spec: `docs/superpowers/specs/2026-07-29-picking-allocation-status-design.md`

1. **Schema** `apps/backend/src/db/schema/picking.ts`: add to `pickingOrders`
   - `allocationStatus: text("allocation_status").notNull().default("unallocated")`
   - `shippedAt: timestamp("shipped_at", { mode: "date" })` (nullable)
   - `shippedBy: text("shipped_by").references(() => users.id)` (nullable)
2. **Migration** `pnpm --filter @warehouse/backend db:generate`; edit the
   generated `0006_*.sql` to backfill:
   `UPDATE picking_orders SET allocation_status = ...` for `pending`/`picking`
   rows from per-item Σ `allocated_qty` vs Σ open (`qty − Σ picking_packages.qty`),
   matching the engine formula (`allocated` incl. the Σ open = 0 edge).
3. **Engine** `apps/backend/src/db/allocate.ts`: at the end of the
   `allocateAll` tx, recompute `allocation_status` for all `pending`/`picking`
   orders (work-locked orders keep their allocation rows, so the same sums
   apply); single set-based UPDATE guarded by `allocation_status IS DISTINCT
   FROM …` so `last_update_date` bumps only on real change.
4. **Ship endpoint** `apps/backend/src/db/shipping.ts` +
   `src/routes/shipping.ts`: `POST /shipping-orders/:pickingOrderId/ship`
   `{actorId}` — reuse the config-aware feed predicate (verify on → completed
   verify task; measuring on → completed measuring task; neither → `finished`
   with no task rows), else 409 `order_not_ready_to_ship` (also when already
   `shipped`); in one tx set `status`/`shipped_at`/`shipped_by`, write the
   `transaction_logs` row, `emitEvent` (topics `/picking-orders` +
   `/shipping-orders`). Exclude `shipped` orders from all three
   `GET /shipping-orders` source queries.
5. **Reads** `apps/backend/src/db/picking.ts`: list rows gain
   `allocationStatus` + `allocatedQty` (Σ per order); detail order gains
   `allocationStatus`; `?status=` accepts `shipped`.
6. **Web** (`apps/web`): `useStatusBadge` + picking list/detail render the
   `allocationStatus` badge (and `shipped` status badge);
   `services/adapters/backendWarehouse.ts` types updated.
7. **Admin** (`apps/admin`): picking-orders list gains an allocation column
   (`allocationStatus` / `allocatedQty`); shipping page gains a mark-shipped
   bulk action (multi-select → `POST /shipping-orders/:id/ship` per order,
   refresh feed) via `utils/flowApi.ts`; i18n keys in `layers/i18n`.
8. **Tests**:
   - `src/db/allocate.test.ts`: status recompute — unallocated/partial/
     allocated transitions, fully-picked (Σ open = 0) → `allocated`,
     work-locked order keeps correct status, `issue` order untouched,
     `last_update_date` unchanged when the value is unchanged.
   - `src/db/shipping.test.ts`: ship happy path per flow-step config
     (verify/measuring/neither), 409 for pending order / unfinished task /
     already-shipped, shipped order leaves the feed, audit row + SSE event.
9. **Verify**: backend suite (`pnpm --filter @warehouse/backend test`),
   `build`, boot dev (migration auto-applies); manual smoke — pick part of an
   order → badge `partial`; ship from admin → order leaves feed, visible
   under `GET /picking-orders?status=shipped`.
10. **Docs**: `docs/backend/schema-tables.md` (`picking_orders` rows),
    `docs/backend/api-design.md` (picking list fields + shipping section),
    `AGENTS.md` (allocation engine + shipping feed paragraphs),
    `docs/app-docs/flows/verify/ai-scope.md` (shipped state no longer out of
    scope) + feature-registry/code-map if files changed.
