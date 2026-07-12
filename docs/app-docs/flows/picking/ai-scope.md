# Picking — AI Scope and Remarks

## In scope

- List open picking orders.
- Show picking order detail with allocated lines.
- Confirm picks by quantity and source location.
- OCR-assisted picking via typed label input on the receiving detail Picking tab.
- Issue reporting for shortages/damages.
- Finish a picking order and create a measuring task.

## Out of scope

- Real camera barcode scanning (typed input / Android native rectangle detection only).
- Wave picking or batch picking across multiple orders.
- Pick-to-light or voice picking.
- Integration with external WMS/ERP.

## Key files

- `pages/picking/` — list and detail pages.
- `components/picking/` — picking-specific components.
- `composables/useLabelScan.ts` — label parsing.
- `composables/useScanMatchers.ts` — matching logic.
- `composables/useMockOcr.ts` — OCR normalization demo.
- `db/picking.ts` — picking DB helpers (pglite adapter only; in api mode the equivalent logic is `apps/api/src/db/pickScan.ts` behind `routes/pickingExecution.ts`).
- `db/ocrPicking.ts` — OCR-assisted picking apply logic (pglite adapter only; api mode: `apps/api/src/db/ocrPick.ts`).
- `db/allocate.ts` — allocation creation (pglite adapter only; api mode: `apps/api/src/db/allocate.ts`).
- `apps/api/src/routes/picking.ts` — admin ingestion endpoint `PUT /picking-orders/:external_id`.
- `apps/api/src/ingest/picking.ts` (with `ingest/parts.ts`) — idempotent order upsert; a changed upsert triggers `allocatePickingOrder` in `apps/api/src/db/allocate.ts` to allocate available received stock.
- `apps/api/src/routes/pickingExecution.ts` — operator picking-execution API: `POST /picking-orders/:id/scan`, `DELETE /picking-orders/:id/packages/:package_id` (undo-scan), `POST /picking-orders/:id/boxes` (+ `:box_id/cancel`, `:box_id/packages`, `:box_id/add-all-unboxed`, `DELETE :box_id/packages/:package_id`), `POST /picking-orders/:id/finish`, and the `GET /picking-orders` / `GET /picking-orders/:id` list/detail reads.
- `apps/api/src/db/pickScan.ts` — transaction logic behind the execution endpoints; `maybeAutoFinishPickingOrder` flips the order to `finished` and inserts a `measuring_tasks` row (`ON CONFLICT (picking_order_id) DO NOTHING`) once every item is fully boxed.
- `apps/api/src/routes/measuring.ts` — `GET /measuring-tasks` polling endpoint for the tasks created at auto-finish.
- `picking_items` quantities are API-maintained columns, not inputs: `picked_qty` is the boxed sum (packages with a `shipping_box_id`), `scanned_not_boxed_qty` is the scanned-but-unboxed sum, `allocated_qty` is the live allocation sum (all recomputed by `recomputePickingItem` in `apps/api/src/db/invariants.ts`), and `remaining_qty` is a generated column (`qty - picked_qty - scanned_not_boxed_qty`).

## Known limitations

- Typed input simulates scanning; the Android native `RectangleDetection.scanLabel()` path is used in some camera flows but not all.
- Matching depends on normalized text and may require manual review.
- In the default api mode all mutations run in the Hono API (validated server-side); only the `warehouseAdapter: "pglite"` fallback runs everything client-side in PGlite with no backend validation.
- The admin payload field names for the ingestion endpoints are currently PROPOSED (`external_id` on the order, receiving lines keyed by `invoice_no` + `line_no`, picking lines keyed by `line_id`) — to be reconciled with the real admin app.
- OCR scan candidate search (`findReceivingCandidates` / `findPickingCandidates` in `composables/useScanMatchers.ts`) goes through `WarehouseService.getScanCandidates` → `GET /receiving-orders/:id/scan-candidates` in api mode; the pglite adapter serves the same data locally.
- Receiving-order allocations may display a "Box IDs" remark when the underlying invoice items record `box_id` values. This is informational only and does not restrict scanning.

## Related specs/plans

- `docs/superpowers/specs/2026-07-01-ocr-assisted-picking-design.md`
- `docs/superpowers/specs/2026-07-03-picking-issue-reporting-design.md`
- `docs/superpowers/specs/2026-07-03-package-level-picking-design.md`
- `docs/superpowers/specs/2026-07-10-allocation-box-remark-design.md`
- `docs/superpowers/plans/2026-07-12-picking-execution.md`
