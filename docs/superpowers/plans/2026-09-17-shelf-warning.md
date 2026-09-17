# Shelf Warning — Implementation Plan

Date: 2026-09-17
Spec: docs/superpowers/specs/2026-09-17-shelf-warning-design.md

1. Schema: add `warning: text("warning")` to `shelves` in
   `apps/backend/src/db/schema/master.ts`; run
   `pnpm --filter @warehouse/backend db:generate`.
2. Seed: mark OL01–OL08 as outdated stock in
   `apps/backend/src/db/seed-shelves-hk.ts`.
3. Backend admin CRUD: accept `warning` in the shelves create/update callbacks
   (`apps/backend/src/routes/admin/index.ts`).
4. Backend reads: left-join `shelves` and expose `shelfWarning` on allocation
   lots in `getPickingOrderDetail` (`apps/backend/src/db/picking.ts`, incl.
   `PickingLotDetail` + `AllocationQueryRow`) and in
   `GET /receiving-orders/:id/picking` (`apps/backend/src/routes/receiving.ts`,
   `PickingAllocationRow`).
5. Web: `shelfWarning` on `PickingAllocationLot` and `ReceivingPickingAllocation`
   lot types (`apps/web/services/types.ts`); ⚠ icon in
   `components/picking/PickingItemsSection.vue`,
   `components/receiving/ReceivingPickingTab.vue`, and the
   `pages/picking/scan/[id].vue` allocation hint.
6. Admin: `warning` field on the shelves entity (`apps/admin/utils/entities.ts`)
   + `admin.fields.shelfWarning` in all three locales
   (`layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`); `shelfWarning` on the
   picking detail lot type (`apps/admin/utils/flowApi.ts`); ⚠ in
   `pages/picking-orders/[id].vue` allocation cell + tooltip row.
7. Backend test: `shelfWarning` present/absent in `getPickingOrderDetail`
   (`apps/backend/src/db/picking.test.ts`).
8. Verify: backend tests + `pnpm --filter @warehouse/backend build`,
   web vitest + `nuxt prepare`.
9. Docs: `docs/backend/schema-tables.md` (shelves), `docs/backend/api-design.md`
   (allocation lot shape), relevant `docs/app-docs/` flow files.
