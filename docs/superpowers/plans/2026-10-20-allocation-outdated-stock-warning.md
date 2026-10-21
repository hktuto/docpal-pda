# Allocation outdated-stock warning — implementation plan

Mirrors the approved plan; spec: `docs/superpowers/specs/2026-10-20-allocation-outdated-stock-warning-design.md`.

1. **Backend `apps/backend/src/db/picking.ts`**
   - `PickingAllocationDetail`: add `outdated: boolean`.
   - `getPickingOrderDetail` allocation map (~lines 1047-1067): compute from
     `COALESCE(lotDateCode, recvDateCode)` via
     `dateCodeRank(code) < outdatedThresholdRank(outdatedStockYears())`
     (null rank → false).
   - `PickingOrderListRow`: add `hasOutdatedAllocations: boolean`.
   - `listPickingOrders` (~line 665): EXISTS scalar over `allocations` →
     `picking_items` → LEFT JOIN `inventory_lots` / `receiving_invoice_items`,
     `a.qty > 0`, valid-WWYY + rank < threshold (same rank expression as
     `src/db/stocksearch.ts:19-21`).
2. **Backend `apps/backend/src/routes/receiving.ts`** — allocations query
   (~lines 330-358): LEFT JOIN `inventory_lots`, select `il.date_code`; serialize
   `outdated` (lot code, else the invoice item's own `date_code`).
3. **Backend `apps/backend/src/routes/admin/partAvailability.ts`** —
   `AllocationBreakdownRow` already selects `COALESCE(il.date_code, rii.date_code)`;
   add `outdated` in TS.
4. **Type mirrors** — `apps/pda/services/types.ts` (`PickingAllocation`,
   `ReceivingPickingAllocation`, picking list row); `apps/admin/utils/flowApi.ts`
   (`PickingOrderRow`, allocation DTOs).
5. **PDA UI** — ⚠️ on outdated allocation rows
   (`components/picking/PickingUnifiedItems.vue`, `PickingItemsSection.vue`,
   `components/receiving/ReceivingPickingTab.vue`; OR-merge in
   `mergeAllocations`); picking list `warn-text` combines scan-warning +
   outdated-stock messages (`pages/picking/index.vue`).
6. **Admin UI** — ⚠️ in allocation cells (`components/allocations/AllocationDetail.vue`,
   `pages/picking-orders/[id].vue`, `pages/receiving/[id].vue`,
   `components/AllocationBreakdown.vue`).
7. **i18n** — `stockAgeWarning` section in all three locales.
8. **Tests** — backend node:test: picking detail flag (old/fresh/invalid code),
   picking list `hasOutdatedAllocations` incl. `_setOutdatedStockYearsForTests`
   sensitivity, receiving detail flag. Run pda vitest.
9. **Verify** — backend build + tests, `nuxt prepare`, pda build, admin build.
10. **Docs** — `docs/app-docs/ai/feature-registry.md`, picking/receiving
    `ai-scope.md` / `overview.md` warning notes.
