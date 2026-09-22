# Implementation plan — picking `allocated` + `skip` statuses

Spec: `docs/superpowers/specs/2026-09-22-picking-allocated-skip-status-design.md`

## Backend (`apps/backend`)

1. `src/db/schema/picking.ts:33` — update the status comment to
   `pending | allocated | skip | picking | issue | finished | shipped` (no
   migration; plain text column).
2. `src/db/picking.ts`
   - `PICKING_ORDER_STATUSES` += `"allocated"`, `"skip"` (order:
     pending, allocated, skip, picking, issue, finished, shipped).
   - Replace `OPEN_PICKING_STATUSES` with
     `ALLOCATION_HOLDING_STATUSES = {pending, picking, allocated}`; in
     `overridePickingOrderStatus` release allocations only when leaving a
     holding status for a non-holding one.
   - `acquireWorkLock` (:631): accept `allocated`.
   - `scanPickingItem` (:1216): `allocated → picking` transition with dynamic
     `fromState`.
   - Barcode lookup (:1291): `IN ('pending','picking','allocated')`.
   - Suggested box (:935): include `allocated`.
   - `reportPickingIssues` (:2128): reportable from `allocated`.
   - Check `scanPickingItem`'s own order-status gate (near :1100) and admit
     `allocated`.
3. `src/db/allocate.ts`
   - `loadDemands`: add optional `includeOrderId` force-include.
   - `refreshAllocationStatus` (:332): add `'allocated'` to the status filter.
   - `allocateForPickingOrder` (:679): accept `allocated`; pass
     `includeOrderId` into `runScopedAllocation` → `loadDemands`; update doc
     comment.
4. Tests: extend/add backend tests per spec (override lock preservation, skip
   exclusion, release on `allocated → skip`, re-entry on `skip → pending`,
   work-lock + scan on `allocated`, scoped re-allocate on `allocated`).

## Admin (`apps/admin`)

5. `pages/picking-orders/index.vue:16` and
   `components/picking-orders/StatusOverrideModal.vue:24` — add `allocated`,
   `skip` to the status arrays.

## Web (`apps/web`)

6. `pages/picking/index.vue` — default status filter
   `["allocated","picking","finished"]`; verify selectability/detail gates
   admit `allocated` (:231, `[id].vue`).
7. `components/picking/PickingFilterModal.vue:59` — status options =
   allocated/picking/finished.

## i18n (`layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`)

8. `status.picking.allocated` / `status.picking.skip` labels ×3 locales.

## Docs

9. Update `docs/backend/api-design.md`, `docs/backend/schema-tables.md`,
   `docs/app-docs/flows/picking/` (overview/steps/ai-scope), `AGENTS.md`
   allocation paragraph.

## Verify

10. `pnpm --filter @warehouse/backend test`, `pnpm --filter @warehouse/backend
    build`, `pnpm --filter @warehouse/web test`, `pnpm --filter @warehouse/web
    nuxt prepare`.
