# Stock-search lot batch edit — implementation plan

Spec: `docs/superpowers/specs/2026-11-19-stock-search-lot-batch-edit-design.md`

- [x] Backend: `updateInventoryLotFields` in `src/db/adminedits.ts` (audit rows + 409 duplicate_lot_identity)
- [x] Backend: `PATCH /admin/inventory-lots/:id` route in `src/routes/admin/flowEdits.ts`
- [x] Backend test: set/clear/audit + 404/400 in `src/db/adminedits.test.ts`
- [x] Admin `flowApi.ts`: `updateInventoryLot(lotId, fields)`
- [x] Modal: `withLotCode` / `withCtnNo` props on `components/receiving/ItemEditModal.vue`; date-code Today/Next-week buttons generate the flow's label format
- [x] `pages/stock-search.vue`: row selection (both table modes, shared Set), batch bar, per-row ✏️ edit, modal wiring, `saveLotEdit` with canonical date-code conversion, selection reset per search
- [x] Verify: backend build + admin typecheck (no new errors), backend test file green
- [x] UAT tracker: CR-065 record, ADM-034 name extended
