# Measuring / Verify 2-level navigation + single-item box quick scan

Spec: `docs/superpowers/specs/2026-11-18-measure-verify-2level-and-item-scan-design.md`

1. Backend: `scanItemCompleteBox` in `apps/backend/src/db/measuring.ts` +
   `POST /measuring-boxes/scan-item` route.
2. PDA service: `scanItemCompleteBox` on `WarehouseService` +
   `backendWarehouse` adapter + types.
3. `/measuring` → order list; new `/measuring/order/[orderId].vue` box list with
   item quick scan.
4. `/verify` → order list; new `/verify/order/[orderNo].vue` box list with item
   quick scan.
5. i18n keys (en-US / zh-CN / zh-HK).
6. Backend test for the new endpoint; `tsc` + vitest + nuxt prepare.
