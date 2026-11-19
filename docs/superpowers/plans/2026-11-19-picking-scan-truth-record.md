# Picking Scan Truth Record — Implementation Plan

Date: 2026-11-19
Spec: `docs/superpowers/specs/2026-11-19-picking-scan-truth-record-design.md`

## Steps

1. **Schema + migration**
   - `apps/backend/src/db/schema/picking.ts`: add `scannedDrawingNo:
     text("scanned_drawing_no")` on `pickingPackages`.
   - New drizzle migration (next number): `ALTER TABLE "picking_packages"
     ADD COLUMN "scanned_drawing_no" text;`
2. **Backend scan accepts + stores `scannedDrawingNo`**
   - `apps/backend/src/routes/picking.ts`: add `scannedDrawingNo?: string`
     to the scan body; pass through to `scanPickingItem`.
   - `apps/backend/src/db/picking.ts` `scanPickingItem` (~line 1892
     insert): store `scanned_drawing_no` (trim → NULL normalization like
     the other scanned_* fields).
3. **Decode returns `drawingNo`**
   - `apps/backend/src/decode/brands/ncc.ts`: set `parsed.drawingNo =
     drawno` (type gains optional `drawingNo`).
   - `apps/pda/utils/labelDecode.ts` `ocrResultToInput` maps
     `drawingNo: parsed.drawingNo`.
4. **PDA posts the five missing fields**
   - `apps/pda/composables/usePickingScanQueue.ts`: `addScan` /
     `addAllocationScan` rows gain `scannedDrawingNo` (from
     `parsed.drawingNo`).
   - `apps/pda/pages/picking/unified/[id].vue` `confirm()`: post
     `scannedDateCode`, `scannedLotCode`, `scannedCoo`, `scannedCow`,
     `scannedDrawingNo` from the row.
   - `apps/pda/services/types.ts`: extend `ScanPickingItemInput`.
5. **`scan_events` audit table**
   - Schema table (id text PK, source, raw, matched, template_id, parsed
     jsonb, actor_id, created/last_update) + migration.
   - `apps/backend/src/routes/decode.ts`: fire-and-forget insert per
     `/scan/decode` call (console.warn on failure, never blocks response).
6. **Scan Excel drawing column**
   - `apps/admin/utils/pickingScanExcel.ts`: `p.scannedDrawingNo ??
     p.drawingNo ?? ""` (type gains optional `scannedDrawingNo`).
7. **Tests**
   - Backend: decode NCC barcode asserts drawingNo; scan commit asserts
     `scanned_drawing_no` + the four scanned_* columns persisted.
   - `pnpm --filter @warehouse/backend test` + `pnpm --filter
     @warehouse/pda test` green.

## Non-goals

- No change to `ncc_lot_ymmdd` (ISO week confirmed).
- Lot-per-reel-date receiving change (tracked separately in the spec).
