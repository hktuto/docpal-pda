# Picking scan label record + verify re-scan — implementation plan

Spec: `docs/superpowers/specs/2026-10-02-picking-scan-label-record-design.md`

1. Backend schema — `apps/backend/src/db/schema/picking.ts`
   - Add `labelBarcode: text("label_barcode")` (nullable) to `pickingPackages`.
   - `pnpm --filter @warehouse/backend db:generate` → new `drizzle/00NN_*.sql`
     (ADD COLUMN only, no backfill).
2. Backend scan route — `apps/backend/src/routes/picking.ts`
   - `POST /picking-items/:id/scan` body type gains optional `barcode`.
   - `POST /shipping-boxes/:id/scan` already takes `barcode` — thread it
     through to the db call.
3. Backend db — `apps/backend/src/db/picking.ts`
   - `scanPickingItem` (~:1092-1306): persist `input.barcode ?? null` as
     `label_barcode` on every `picking_packages` INSERT (~:1235-1241); all
     split portions of one label carry the same string.
   - `scanIntoShippingBox` (~:1319-1359): persist the barcode on the package
     rows it creates.
4. Web service types — `apps/web/services/types.ts` +
   `apps/web/services/adapters/backendWarehouse.ts`
   - Scan input type gains optional `barcode`; adapter passes it through.
5. Picking scan page — `apps/web/pages/picking/scan/[id].vue`
   - Confirm (~:586-596): include the queue row's `raw` as `barcode` in each
     portion's `scanPickingItem` POST. Camera/OCR path omits it.
6. Verify/measure matcher — `apps/web/composables/useScanMatchers.ts`
   - `matchMeasuring` (~:188-237): new label pass before the qty pass — if
     the raw scan string non-empty and exactly equals the `labelBarcode` of
     packages in the candidate pool (unverified set for the active mode),
     return a multi-package result; packages already verified → an
     already-verified informational result. No label hit → existing exact-
     qty path untouched. Matcher signature gains the raw scan string.
7. `apps/web/components/MeasureBox.vue`
   - Consume the multi-package result: `verifyPackage` per package, single
     toast "N items verified by label"; consume the already-verified result
     as an info toast (no error).
8. i18n — `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`
   - New keys for verified-by-label toast + already-verified info.
9. Tests
   - Web: matcher label-hit / already-verified / legacy-fallback cases
     (extend the existing matcher/scan test files under `apps/web/tests/`).
   - Backend: scan test asserting `label_barcode` persisted on the package
     row (item-scan path; box-scan path if the suite covers it).
10. Verify: `pnpm --filter @warehouse/backend build` + `test` (needs the
    docker Postgres up), `pnpm --filter @warehouse/web test` + `nuxt prepare`.
11. Docs: update `docs/app-docs/flows/` verify + picking `ai-scope.md`
    paragraphs and `ai/feature-registry.md` for the label-record behavior.
