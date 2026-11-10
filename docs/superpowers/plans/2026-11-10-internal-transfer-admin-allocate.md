# Internal transfer — admin allocation + delegated picking order — implementation plan

Spec: `docs/superpowers/specs/2026-11-10-internal-transfer-admin-allocate-design.md`

1. Backend engine (`apps/backend/src/db/internalTransferAllocate.ts`)
   - `allocateForInternalTransferOrder(db, transferOrderId)`: tx, `FOR UPDATE` order guard (404/`order_not_open`/`lock_held`), own-order demand load (open qty = qty − Σ `internal_transfer_packages`), wipe non-manual `internal_transfer_allocations` + RESERVE-release ledger (`referenceType: "internal_transfer_allocation"`), up-front negative lot deltas, rebuild shelf-FIFO (reuse `loadLotSources`, exported from `allocate.ts`, with a synthesized `DemandRow` carrying the `from_` pair) then dock-FIFO via a local `loadTransferReceivingSources` (nets BOTH allocation tables, excludes own order), positive deltas + RESERVE ledger, `internal_transfer_items.allocated_qty`, `refreshTransferAllocationStatus`, `transaction_logs` + SSE (`allocation.computed`/`finished` on `/internal-transfer-orders`). No pre-passes, no status writes (`shortcut` comments per spec).
2. Picking-side netting unions
   - `allocate.ts` `loadReceivingSources`: `locked_ii`/`locked_ro` subqueries `UNION ALL` `internal_transfer_allocations` (per-scope manual/work-lock rule).
   - `allocate.ts` `addManualPickingAllocation`: source-availability cap nets transfer rows.
   - `picking.ts` `recomputeLot`: `Σ allocations + Σ internal_transfer_allocations`.
   - `routes/admin/partAvailability.ts`: `/part-availability` receiving `allocatedQty` union; `/part-allocations` transfer rows + `demandType` (+ `transferOrderId`), `AllocationBreakdown.vue` renders/removes them.
3. Assignment + manual actions (`apps/backend/src/db/internalTransfer.ts` grows its first mutations)
   - `assignTransferPickingOrder(db, id, pickingOrderId|null, actorId)` with the spec's 404/409 validation, `logTransition`, `internal-transfer.updated` SSE.
   - `addManualInternalTransferAllocation` / `removeInternalTransferAllocation` mirroring the picking actions (guards, ledger, recomputes, SSE).
   - `getInternalTransferOrder`: embed per-item allocations (source detail) + assigned picking order summary; list adds `linked`.
4. Routes (`apps/backend/src/routes/admin/internalTransferOrders.ts`)
   - `POST /:id/reallocate`, `PUT /:id/picking-order`, `POST /:id/items/:itemId/allocations`, `DELETE /:id/items/:itemId/allocations/:allocationId`; `actorFrom(c)` everywhere.
5. Backend tests
   - `src/db/internalTransferAllocate.test.ts`: spec test list 1–8 (from_-partition restriction, FIFO, dock + `allowDockStock=false`, both-ways netting, `recomputeLot` union, pin survival + uncovered items, manual guards, assignment validation).
   - Run the full suite (picking allocation tests must stay green over the unions).
6. Admin API (`apps/admin/utils/flowApi.ts`)
   - Types: transfer allocation rows, assignment request/response, `demandType` on part-allocations; methods: `reallocateInternalTransferOrder`, `assignTransferPickingOrder`, `addTransferAllocation`, `removeTransferAllocation`.
7. Admin UI
   - `pages/internal-transfer-orders/[id].vue`: Re-allocate header action (picking-detail button pattern), delegated picking order card (`PickingOrderSearchInput` + org/open filter, Set/Change/Clear), items table with expandable allocations + Remove + 🔍 availability modal (`PartAvailabilityModal` transfer mode if shape allows, else thin variant) posting the transfer manual pin.
   - `pages/internal-transfer-orders/index.vue`: `linked` badge column.
   - i18n ×3 locales.
8. Docs + tracking
   - `docs/backend/api-design.md` rows; `docs/backend/allocation.md` transfer engine + both-tables netting invariant; `docs/backend/event-catalog.md` events; `docs/app-docs/flows/internal-transfer/` (minimal overview/steps/ai-scope) + `feature-registry.md` + `code-map.md`; `docs/uat/functions.json` ADM- entry (covers the 2026-11-09 pages too) + `node scripts/gen-uat-xlsx.mjs`.
9. Verify + commit
   - `pnpm --filter @warehouse/backend build && pnpm --filter @warehouse/backend test`; admin `vue-tsc` clean on touched files; live smoke against the cloned data (Re-allocate a pending order, check from_-partition sourcing + assignment org rejection); browser pass on the detail page; commit.
