# Admin cross-order allocation control — Implementation Plan

Spec: `docs/superpowers/specs/2026-10-14-admin-cross-order-allocation-control-design.md`
(read it first — scope decisions live there).

## Phase 1 — backend

1. **Endpoint** (`apps/backend/src/routes/admin/partAvailability.ts`):
   `GET /admin/part-allocations?partNo=&wclItemNo=` per spec §1 — join
   `allocations` → `picking_items` → `picking_orders` (+ part for
   part_no/wcl_item_no filter), left-join the source (lot with shelf
   display name via `shelves`, or `receiving_invoice_items`), work-lock
   flags mirroring the `part-demand` query. Register next to the
   existing routes in the same file (mount already handled).
2. **Domain** (`apps/backend/src/db/allocate.ts`, next to
   `removePickingAllocation` / `addManualPickingAllocation`):
   `transferPickingAllocation(db, { orderId, itemId, allocationId, qty, actorId })`
   per spec §2 — validation table, then one tx doing
   remove-side (shrink-or-delete, RESERVE release
   `"admin: transfer out"`, recomputeLot, recomputePickingItem source,
   audit `allocation_transferred_out`) and add-side (amend-or-insert
   single manual pin, RESERVE `"admin: transfer in"`, recompute target,
   audit `allocation_transferred_in`). Reuse `locationMatches` from
   partAvailability (extract to a shared helper if not importable),
   the amend-or-insert shape from `pickingAllocateForm.ts`, and the
   ledger shelf-nulling rule from `removePickingAllocation`. No
   `scheduleAllocateAll`. SSE `allocation.computed` after commit.
3. **Route** (`apps/backend/src/routes/admin/allocation.ts`):
   `POST /:id/items/:itemId/allocations/transfer` → `transferPickingAllocation`,
   `actorFrom(c).id`, snake_case `HTTPException` codes per spec table.
4. **Tests** (`apps/backend/src/routes/admin/allocation.test.ts`) per spec
   §Tests. Run `pnpm --filter @warehouse/backend test` and `build`.

## Phase 2 — admin UI

5. **API client** (`apps/admin/utils/flowApi.ts`): `getPartAllocations`
   + `transferPickingAllocation(orderId, itemId, allocationId, qty?)`
   DTOs.
6. **Shared component** (`apps/admin/components/AllocationBreakdown.vue`):
   props `{ partNo, wclItemNo, currentOrderId?, transferable: boolean }`
   — expandable "N (k orders)" trigger, lazy fetch with per-part cache
   (module-level Map), rows: order no link, status badge, qty, 📌 manual,
   lock badge; emits removal via slots/exposes for the two host dialogs
   (picking: Transfer + Remove; receiving: Remove only). Confirm dialog
   for Remove with the pool-return hint; error toast/banner on 409s
   (`lock_held` etc.).
7. **Picking modal** (`apps/admin/components/PartAvailabilityModal.vue`):
   swap the stock table `allocatedQty` cell for `AllocationBreakdown`
   with `transferable: true`; Transfer posts the new endpoint and
   refreshes availability rows + form baseline; Remove calls the
   existing delete API on the holding order and refreshes.
8. **Receiving modal** (`apps/admin/components/receiving/PartSearchModal.vue`):
   same swap in the related-stock table with `transferable: false`.
9. Verify: `pnpm --filter @warehouse/backend build`, backend tests,
   `pnpm --filter @warehouse/pda nuxt prepare` (types untouched but
   cheap), manual smoke via `pnpm dev:backend` + `pnpm dev:admin` —
   open a picking order item availability dialog, expand an allocated
   cell, transfer + remove, reload and confirm the pin holds.

## Phase 3 — docs

10. `docs/backend/api-design.md` — catalog entries for
    `GET /admin/part-allocations` and
    `POST /admin/picking-orders/:id/items/:itemId/allocations/transfer`.
11. `docs/app-docs/ai/feature-registry.md` + `ai/code-map.md` — the new
    breakdown/transfer behavior and files.
