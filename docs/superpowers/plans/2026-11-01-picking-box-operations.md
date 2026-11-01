# Picking box operations redesign — implementation plan

Spec: `docs/superpowers/specs/2026-11-01-picking-box-operations-design.md`

## Backend (`apps/backend`)

1. `src/db/picking.ts`
   - Add `listOpenShippingBoxes(db)` — open boxes, oldest first, with creator
     order id/no + package count.
   - Add `boxEachUnboxedPackage(db, { pickingOrderId, actorId })` — one tx: one new
     box per unboxed package of the order (reuse `nextBoxId`, `assignPackageToBoxTx`,
     `prefillShippingBoxFromSources`, `logTransition`), returns `{created, boxIds}`.
   - `closeShippingBox`: when `!isStepEnabled("measuring")`, skip the
     `all_packages_must_be_verified` guard and the box-size/weights guards.
2. `src/routes/picking.ts`
   - `GET /shipping-boxes` → `{ boxes }`.
   - `POST /picking-orders/:id/box-each-unboxed` → 201 `{created, boxIds}`.
3. `src/db/picking.test.ts` — tests per spec §Tests.

## PDA (`apps/pda`)

4. `services/types.ts`: `OpenShippingBox`.
5. `services/warehouse.ts` + `services/adapters/backendWarehouse.ts`:
   `listOpenShippingBoxes`, `createBoxPerUnboxedPackage`.
6. `components/picking/PickingBoxesSection.vue`: remove Scan-box button/emit/prop;
   add Choose-box + Box-each-unboxed header buttons; add per-box Close button gated
   on a new `closable` prop.
7. New `components/picking/ChooseBoxDialog.vue`.
8. `pages/picking/unified/[id].vue`: wire the three actions + armed-box banner +
   cross-order-safe disarm in `load()`; pass `closable = !flowSteps.measuring`.
9. `pages/picking/[id].vue`: remove scan-box-label flow (`scanBoxId`,
   `createBoxWithId`, `scanningBox`, hardware fallback); wire the three actions.
10. `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`: add/remove keys per spec.

## Docs

11. `docs/backend/api-design.md` — new endpoints.
12. `docs/app-docs/flows/picking/` — update changed UI behavior; refresh
    `ai/feature-registry.md` / `ai/code-map.md` if files changed.
13. `AGENTS.md` — note the measuring-off close-guard relaxation + new endpoints.

## Verify

14. `pnpm --filter @warehouse/backend build && pnpm --filter @warehouse/backend test`
15. `pnpm --filter @warehouse/pda test && pnpm --filter @warehouse/pda nuxt prepare`
