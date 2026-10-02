# Picking shelf-scan mode config — implementation plan

Spec: `docs/superpowers/specs/2026-10-02-picking-shelf-scan-config-design.md`

1. Backend config — `apps/backend/src/config.ts`
   - `FlowConfig` gains `pickingShelfScan: "off" | "require-match" | "require-any"`
     (default `"off"`); validated in the key-merge loop (~:425) rejecting
     other values; getter `pickingShelfScan()` + runtime setter
     `setPickingShelfScan()` following the `outdatedStockYears` pattern
     (~:611 getter, ~:679 setter). `FLOW_CONFIG` env override wins (existing
     plumbing).
2. `apps/backend/src/routes/config.ts` — add `pickingShelfScan:
   pickingShelfScan()` to the `GET /config` response.
3. Admin flow-config — the existing `GET/PUT /admin/flow-config` route +
   `admin-flow-config.test.ts`: accept/return the new key; add test.
4. Backend scan route — `apps/backend/src/routes/picking.ts`
   - `POST /picking-items/:id/scan` body gains optional `shelfCode`, `boxId`,
     passed to `scanPickingItem`. The box-scan path (`scanIntoShippingBox`)
     already forwards to `scanPickingItem`, so it inherits the behavior.
5. Backend db — `apps/backend/src/db/picking.ts` `scanPickingItem`
   - Read the mode from config.
   - `require-match`: absent shelf → 409 `shelf_scan_required`; ≠ the
     allocation lot's shelf/box → 409 `shelf_mismatch`; otherwise unchanged.
   - `require-any`: same required check; resolve the physical lot —
     `inventory_lots` for the item's part at the scanned shelf/box
     (org/sub-inventory scope per `src/db/org-filter.ts`), label batch fields
     (`dateCode`/`lotCode`) must match the lot when provided, oldest
     `date_code` wins (FIFO, like `allocate.ts` loadLotSources); none → 409
     `no_stock_at_location`. Deduct that lot, PICK ledger rows + package
     `source_id` point at it; `reduceAllocation` on the original allocation
     as today.
   - `off`: fields ignored.
6. Web config — `apps/web/services/types.ts` + config composable: expose
   `pickingShelfScan` from `GET /config`.
7. Web picking scan — `apps/web/pages/picking/scan/[id].vue` +
   `apps/web/composables/usePickingScanQueue.ts`
   - `require-*` modes: one shelf/box scan sets a sticky `pendingShelf`
     context chip (clearable, replaced by the next shelf scan); item scans
     rejected with "scan shelf first" while empty. NOT per-item — one shelf
     scan per location visit.
   - `require-match`: allocation candidates filtered to the pending shelf;
     no candidate → shelf-mismatch toast.
   - `require-any`: allocation matching unchanged; `shelfCode`/`boxId`
     attached to each portion's confirm POST.
   - Camera/OCR scans rejected in `require-*` modes ("use the scanner").
8. i18n — `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — mode labels +
   new toasts/errors.
9. Admin UI — `apps/admin/pages/display-config.vue` gains a
   `pickingShelfScan` select (off / require-match / require-any) editing via
   `/admin/flow-config`; i18n labels.
10. Tests
    - Backend: `scanPickingItem` mode matrix — off ignores fields;
      require-match absent/mismatch 409s, match passes; require-any deducts
      the scanned shelf's lot (assert ledger + package source + original
      allocation reduced), no_stock_at_location 409. Extend
      `apps/backend/src/db/picking.test.ts`.
    - Web: queue/matcher shelf filtering cases in the existing scan-queue
      tests.
11. Verify: `pnpm --filter @warehouse/backend build` + `test`, `pnpm
    --filter @warehouse/web test` + `nuxt prepare`, `pnpm --filter
    @warehouse/admin nuxt prepare` (admin touches).
12. Docs: `docs/app-docs/flows/picking/ai-scope.md` + `ai/feature-registry.md`;
    add `pickingShelfScan` to the flow-config key list in root `AGENTS.md`.
