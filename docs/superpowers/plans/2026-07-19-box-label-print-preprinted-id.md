# Box label printing + pre-printed box ids — implementation plan

Spec: `docs/superpowers/specs/2026-07-19-box-label-print-preprinted-id-design.md`

1. **Backend** `apps/backend/src/db/picking.ts` `createShippingBox`: optional
   `boxId` (trim, 400 `box_id_empty`, 409 `box_id_exists`); route
   `POST /picking-orders/:id/boxes` passes `body.boxId`. Tests in
   `src/db/picking.test.ts` (pre-printed id, duplicate, empty, trim).
2. **Service** `apps/web/services/warehouse.ts` +
   `services/adapters/backendWarehouse.ts`:
   `createShippingBoxForPickingOrder(orderId, boxId?)`.
3. **Print placeholder**: per-box Print buttons in
   `components/picking/PickingBoxesSection.vue` and
   `components/receiving/ReceivingPickingTab.vue` emit `print-box`; parents
   show a "printing later" toast. Real printing comes backend-side later.
5. **Scan box id** `apps/web/pages/picking/[id].vue`: hardware scanner armed
   while `actionable`; supplier-template match → "use scan mode" toast, else
   create box with scanned id. `PickingBoxesSection` gains a "Scan box id"
   button (camera/manual via `captureLabel`).
6. **i18n** en/zh-CN/zh-HK: `meta.boxLabel`, `boxLabel.*`,
   `picking.boxesSection.{scanBox,print}`, `picking.detail.{boxCreated,
   itemQrUseScanMode}`, `receiving.pickingTab.print`,
   `errors.{box_id_exists,box_id_empty}`.
7. **Verify**: backend `picking.test.ts` (+full suite), web vitest, vue-tsc,
   browser e2e (box scan create, duplicate 409 toast, item QR toast, print
   page render).
8. **Docs**: `docs/app-docs/flows/picking/ai-scope.md`,
   `docs/app-docs/ai/code-map.md`, `docs/app-docs/ai/feature-registry.md`.
