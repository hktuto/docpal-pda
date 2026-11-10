# Internal transfer — stage 2: PDA picking + finish branches — implementation plan

Spec: `docs/superpowers/specs/2026-11-10-internal-transfer-pda-picking-design.md`
(forks resolved per the recommended leanings; put-away branch = native
transfer shelving, see spec §Put-away branch).

1. Backend domain (`apps/backend/src/db/internalTransferPicking.ts`, mirrors
   `picking.ts` mechanics; reuses `recomputeLot`, `workLockExpiry`, config,
   `checkPartScanOutdated`/`recordOutdatedWarning`):
   - `listInternalTransferQueue(db)` — pickable (allocated/picking/issue) +
     put-away-pending (finished ∧ unshelved packages), per-order progress +
     work-lock holder.
   - `getInternalTransferPickingDetail(db, id)` — order + items (allocations
     as pick guidance) + packages.
   - `acquireInternalTransferWorkLock` / `releaseInternalTransferWorkLock` —
     conditional-claim mirror on `internal_transfer_orders`.
   - `scanInternalTransferItem(db, transferItemId, input)` — allocation-capped
     pick: three source branches (lot conditional decrement + shelf-scan
     modes; invoice-item `picked_qty+`; order-level FIFO), shrink
     `internal_transfer_allocations` + recomputes, `internal_transfer_packages`
     row + PICK ledger pair, status → picking, logTransition, SSE.
   - `removeInternalTransferPackage(db, {packageId, actorId})` — reversal
     mirror (restore source, bump allocation, ledger, delete, recompute).
   - `reportInternalTransferIssue(db, id, {reason, qty, note})` — issue_*
     columns + status issue (picking continues; finish allows a recorded
     shortage).
   - `finishInternalTransferOrder(db, id, actorId)` — guard (coverage or
     recorded issue); status finished + lock release; linked → materialize
     unshelved lots at `to_` (natural-key merge, ADJUST on_hand ledger) then
     the awaited `allocateForPickingOrder(delegated)` OUTSIDE the tx
     (confirm-arrival sequencing, null on scoped failure); unlinked → the
     `put_away_tasks` row.
   - `shelveInternalTransferPackage(db, id, {partNo, qty?, dateCode?, shelfCode})`
     — consumes unshelved packages FIFO, merge/create lot at
     (to_org, to_sub, shelf) + PUT_AWAY ledger, stamps package shelf_code,
     task → completed at the last package.
   - `overrideInternalTransferStatus(db, {id, status, actorId})` —
     pending ↔ allocated + work-lock steal.
2. Backend routes: `src/routes/internalTransfer.ts` (PDA verbs above, actor
   from JWT) mounted in `src/index.ts`; `PATCH
   /admin/internal-transfer-orders/:id/status` in
   `routes/admin/internalTransferOrders.ts`.
3. Backend tests (`src/db/internalTransferPicking.test.ts`): queue gating,
   scan caps/branches, package removal, finish linked (lots at to_ +
   delegated allocation), finish unlinked (task + shelve + complete),
   confirm/unconfirm, work lock.
4. PDA app: `FlowStep` key; DTOs + adapter methods in
   `services/adapters/backendWarehouse.ts`; home tile; pages
   `pages/internal-transfer/{index,[id]}.vue` (queue; detail with pick mode /
   put-away mode); i18n ×3.
5. Admin: Confirm/Unconfirm buttons on the transfer detail + flowApi method.
6. Docs + UAT: api-design rows, event-catalog entries, app-docs
   internal-transfer steps/ai-scope extend, functions.json (PDA entry +
   ADM-040 remark), xlsx regen.
7. Verify + commit: backend build + full suite; admin/pda typechecks; live
   smoke (pick → finish → shelve on a test order); browser pass.
