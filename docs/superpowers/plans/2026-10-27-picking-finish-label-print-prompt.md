# Picking-finish label print prompt — implementation plan

Spec: `docs/superpowers/specs/2026-10-27-picking-finish-label-print-prompt-design.md`
(open questions resolved below in §Decisions).

## Decisions (from the spec's open questions)

- **Q1 multiplicity:** first-match-wins per `label_type` (the 2026-09-16 contract) — at most one match each for `carton` / `item_box` / `item`.
- **Q2 template mapping:** one generic params builder per label type emitting a superset of every documented template field (`docs/backend/print-service.md`); canvas templates bind fields by name and ignore extras. No per-template registry in v1; refine per-template after real printouts.
- **Q3 printer:** omit `printerName` — the print service uses the template's default printer.
- **Q4 timing:** prompt right after the finish succeeds (boxes/packages are final); re-entry via a "Print labels" header action on the finished order's picking detail page.

## Backend

1. `apps/backend/src/db/labelPrint.ts`
   - Extract the glob matcher so SQL (`globToLike`) and JS evaluation share semantics: add `globToRegExp(glob)` (full-string, `*` → `.*`, literals escaped).
   - Add `LabelPrintOrderContext` = `{ orgId, subInventoryCode, orderNo, pickingOrderType, customerCode, brands[] }` and `evaluateLabelPrintConditions(conditions, ctx)` (and/or combinator; `eq` = exact case-sensitive (org_id numeric), `match` = glob; `supplier` = any brand matches).
   - Add `resolveLabelPrintRulesForOrder(db, orderId)`: 404 `picking_order_not_found` unknown; load order + distinct brands; active rules ordered `priority ASC, created_date ASC`; first match per label type → `{matches: [{ruleId, name, labelType, printTemplateId}]}`.
2. `apps/backend/src/routes/picking.ts` — `GET /picking-orders/:id/label-print-rules` → `{matches}` (regular auth route; read-only).
3. Tests `apps/backend/src/db/labelPrint.test.ts` (new): per-type first-match-wins, priority order, combinator and/or, eq vs glob match, supplier brand set, inactive rules skipped, unknown order 404.

## PDA

4. `apps/pda/services/types.ts` — `LabelPrintRuleMatch { ruleId, name, labelType, printTemplateId }`.
5. `apps/pda/services/warehouse.ts` + `services/adapters/backendWarehouse.ts` — `getPickingLabelPrintRules(orderId)` (interface + adapter; check other adapters for the method signature).
6. `apps/pda/utils/print.ts` — `dynamicPrint({templateId, printingParams})`, `getPrintJob`, `waitForPrintJob` over `services/apiClient.ts` (mirror `apps/admin/utils/print.ts` shapes; no printer/copies args in v1).
7. `apps/pda/utils/labelPrintParams.ts` — `buildLabelPrintParams(labelType, order)`:
   - `carton` → one row per shipping box of the order; `item_box`/`item` → one row per package.
   - Row = superset: identity (`orderNo`, `poNo`, `customerCode`, `customerName`, `shipTo`, `invNo`), part (`partNo`, `wclItemNo`, `itemCode`, `itemNum`, `sku`, `productCode`, `mfgPn`, `partNumber`), qty (`qty`, `quantity` — string), batch (`dateCode`, `lotCode`, `lotNo`, `coo`, `cow`, `makeIn`, `originCountry`, `productionDate`), box (`serialNo`, `boxId`, `barcodeValue`, `barCode`, `extraCode`), codes (`qrcode`/`qrPayload`/`traceCode`/`midQr`/`topQr` = canonical trace string `partNo|dateCode|lotCode|qty`), paging (`page`/`total` as 1-based strings over the row set), `ATICode`/`MFRCode` (partNo / brand).
   - Batch-field values prefer the pick-time scanned values, fall back to the source snapshot (same rule as verify).
   - Vitest: `apps/pda/tests/labelPrintParams.test.ts`.
8. `apps/pda/components/picking/LabelPrintPrompt.vue` — modal listing matches (rule name, label type, template id, label count); per-match Print (spinner → poll → success/error state), Print all, Skip. Errors toast, never block.
9. Wire-up:
   - `pages/picking/unified/[id].vue` + `pages/picking/[id].vue` finish handlers: after `finishPickingOrder` succeeds → fetch matches; any → open the prompt (prompt close then runs the measuring-off `/verify` navigation when applicable); none → today's behavior.
   - `pages/picking/[id].vue` header action "Print labels" when status is `picking_finished`/`measuring_finished`/`shipped` (re-entry/reprint).
10. i18n keys in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` under `picking.printLabels.*`.

## Verify

- `pnpm --filter @warehouse/backend test`, `pnpm --filter @warehouse/backend build`
- `pnpm --filter @warehouse/pda test`, `pnpm --filter @warehouse/pda exec nuxt prepare`
- Docs: spec status → the design stays; update `docs/backend/api-design.md` (new route), `docs/app-docs/ai/feature-registry.md` + picking ai-scope, AGENTS.md label-print-rules bullet.
