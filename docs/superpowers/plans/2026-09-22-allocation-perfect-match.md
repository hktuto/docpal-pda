# Allocation perfect-match pinning — implementation plan

Spec: `docs/superpowers/specs/2026-09-22-allocation-perfect-match-design.md`

## 1. `apps/backend/src/db/allocate.ts`

1. Add `perfectMatched: number` to `AllocateSummary`; initialize to 0 in both
   `allocateAll` and `runScopedAllocation` summaries.
2. In `runScopedAllocation`, after the wipe's lot-delta application
   (`lotDelta.clear()`) and before the main demand loop, add the pre-pass:
   - Build a per-demand working list from `demands` (already priority-ordered
     by `loadDemands`): `{ d: resolveDemandLocation(raw), remaining }` where
     `remaining = openQty − manualQtyByItem`; skip remaining ≤ 0.
   - Helper `pinPerfectMatch(tx, item, allocs)` — insert one
     `allocations` row per piece with `manual: true`, push the RESERVE ledger
     row (`txn_reason: "recompute: perfect match"`), count
     `summary.allocationsCreated` / `perfectMatched`, and for lot pieces run
     the shelf-FK-guarded `allocated_qty` UPDATE immediately.
   - Pass A (only when `allowDockStock()`): for each working demand, load
     `loadReceivingSources`; drop NULL-pair rows (count
     `skippedReceivingSources`); group box-level (`ctnNo`) rows by
     `receivingOrderId` preserving FIFO order; first group whose Σ available
     == remaining → pin every row in it (receivingInvoiceItemId set), mark
     the demand satisfied.
   - Pass B: for each still-unsatisfied working demand, load
     `loadLotSources` then (when allowed) `loadReceivingSources`; first row
     whose available == remaining → pin it (lot id, or receivingInvoiceItemId
     for box rows / receivingOrderId for order-level rows).
   - Record pinned qty into `manualQtyByItem` so the main loop pre-subtracts
     it (`remaining` becomes 0 → the item passes through only for its
     `allocated_qty` cache refresh).
3. Change detection: `changed = keyChange || perfectMatchPinsCreated > 0`.
4. Update the file-header comment and the "mirrors allocateAll" notes to
   document the deliberate divergence.

## 2. `apps/backend/src/routes/admin/flowEdits.ts`

In `PATCH /receiving-orders/:id/status`: on `result.changed`, replace
`scheduleAllocateAll` with `try { await allocateForReceivingOrder(db, id) }
catch { scheduleAllocateAll(db, "admin_status_override") }` (mirrors the
confirm-arrival fallback). Update the route comment.

## 3. Tests — `apps/backend/src/db/allocate.test.ts`

New tests (hermetic setups built on the demo seed, following the existing
`TEST-PRIO` pattern):

1. `runScopedAllocation: whole-order group match pins all boxes to the exact-fit demand`
2. `runScopedAllocation: single-row lot match beats higher-priority partial demand`
3. `perfect-match pins survive allocateAll`
4. `runScopedAllocation: no exact match → unchanged priority+FIFO split`
5. `perfect-match scoped run is idempotent (changed=false on re-run)`

## 4. Docs

- `AGENTS.md` allocation bullet: note the scoped-core perfect-match pre-pass
  + pinned rows + the flowEdits change.
- `docs/backend/concepts.md` §6: same rule addition.
- `docs/app-docs/` — check `ai/feature-registry.md` for an allocation entry;
  update if it describes the scoped/full split.

## 5. Verify

- `docker compose up -d` (Postgres) →
  `pnpm --filter @warehouse/backend test` →
  `pnpm --filter @warehouse/backend build` (tsc).
- Commit spec + plan + code + tests + docs.
