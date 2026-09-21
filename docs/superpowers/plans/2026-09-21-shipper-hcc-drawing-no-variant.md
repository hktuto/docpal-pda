# Shipper HCC drawing-no variant (plan)

Spec: `docs/superpowers/specs/2026-09-21-shipper-hcc-drawing-no-variant-design.md`

1. `apps/backend/src/export/shipper/model.ts`
   - `ShipperGroup.blockItems`: `{ invoiceCtn: string; qty: number }` →
     `{ invoiceNo: string | null; drawingNo: string | null; ctnNo: string | null; qty: number }`.
2. `apps/backend/src/export/shipper/data.ts`
   - Items query: add `rii.additional_data->>'drawing_no' AS "drawingNo"`
     (extend the `ItemRow` interface).
   - Build `blockItems` with the raw components; drop the pre-composed
     `invoiceCtn` join (moves to the renderer).
3. `apps/backend/src/export/shipper/render/default.ts`
   - Export `makeShipperRenderer(options?: { firstColumnHeader?: string; firstColumnField?: "invoiceNo" | "drawingNo" })`
     returning `{ render }`; the current `render` body becomes the factory
     body with `firstColumnHeader` (default `"Invoice / Ctn"`) driving the
     header row and the `!cols` comment, and the block item's first cell
     computed as `[item[field], item.ctnNo].filter(Boolean).join(" ")`.
   - Keep `registerRenderer("shipper", makeShipperRenderer())` at module
     bottom (default, unscoped).
4. `apps/backend/src/export/shipper/render/hcc.ts` (new)
   - `registerRenderer("shipper", makeShipperRenderer({ firstColumnHeader: "Drawing No / CTN", firstColumnField: "drawingNo" }), { supplierCode: "23" })`
     with a one-line header comment (supplier HCC = code 23, spec link).
5. `apps/backend/src/routes/admin/receivingShipper.ts`
   - Add `import "../../export/shipper/render/hcc.js";` beside the default
     import (registration side effect). No other route change.
6. `apps/backend/src/routes/admin/receivingShipper.test.ts`
   - Add the HCC test per spec §Testing (check the
     `insertReceivingOrder` fixture for a supplier-code param; the head
     query LEFT JOINs suppliers, so a suppliers row is not required).
7. Docs: `apps/backend/src/export/README.md` — point the "Adding a new
   layout" example at the real `render/hcc.ts` (config-style variant).
   Pointer note atop the 2026-09-14 shipper spec is already present; no
   api-design.md change (endpoint unchanged).
8. Verify: `docker compose up -d`;
   `pnpm --filter @warehouse/backend test` (suite green modulo the 4 known
   pre-existing failures: picking/receiving order logs, print printers,
   print dynamic); `pnpm --filter @warehouse/backend build`.
