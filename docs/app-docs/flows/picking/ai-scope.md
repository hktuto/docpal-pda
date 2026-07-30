# Picking — AI Scope and Remarks

## In scope

- List picking orders with a status filter and text search; multi-select
  batch issue reporting.
- Show picking order detail as one nested read: order (incl. issue fields
  and its measuring task), items → allocations (with lot or receiving-area
  source) and packages, plus the shipping boxes.
- Scan-to-pick ("checkout" scan session): one Scan button per picking order
  opens `/picking/scan/:id`. The hardware scanner is armed only on that page;
  each QR scan is validated client-side (part matches an order item, qty fits
  the first allocation with enough remaining minus already-queued qty,
  duplicate raw QR rejected) and appended to a local queue table — no per-scan
  confirm/review. An OCR button captures a label with the camera: a capture
  that parses into a single record opens a confirm form
  (`PickingScanReviewModal` — editable fields with OCR candidate chips),
  while a multi-item label (2+ rows via `extractMultiItemRows`) opens an
  editable table (`PickingScanMultiItemModal`) whose rows are added to the
  queue row-by-row. The queue table aggregates scans of the same item +
  batch fields (lot/date/coo/cow) into one row with the total qty — display
  only; Confirm still applies each scan individually. Confirm
  batch-applies the queue sequentially via
  `POST /picking-items/:id/scan {allocationId, qty, ...batch overrides}`;
  failed rows stay in the list with their error. Launched from the picking
  detail page or the receiving order's picking tab (`?from=receiving&ro=`).
- Package and shipping-box operations: remove (undo-scan) / verify packages,
  create / cancel / close boxes, add/remove packages, add-all-unboxed;
  box sizes and weights in kilograms (decimals, 3 dp — see the measuring
  flow for the kg convention and the formula-based net-weight pre-fill).
- Box labels + pre-printed box ids: on the picking detail page the
  hardware scanner is armed for box ids — a scan that does not match a
  supplier QR template creates an open box with that scanned (pre-printed)
  id; item QRs get a "use scan mode" toast. A "Scan box id" button covers
  camera/manual entry. Server side, `createShippingBox` accepts an optional
  `boxId` (409 `box_id_exists` on duplicates — the id is the global PK);
  server-generated ids follow `BOX-S-<warehouse>-<YYYYMMDD>-<seq>` (per-day
  seq, `nextBoxId` in `apps/backend/src/db/boxes.ts`).
  The per-box Print button on the picking detail was removed (2026-07);
  the receiving picking tab's Print button remains a placeholder — real
  printing will be added backend-side later.
- Finish a picking order manually, or automatically when the last package
  is boxed — finishing creates a measuring task.
- Per-order issue reporting (`POST /picking-orders/report-issues`). An issued
  order is frozen (scan/unpack 409, excluded from `allocateAll`) until an
  admin resolves it — `POST /picking-orders/:id/resolve-issue` returns it to
  `pending`, clears the `issue_*` columns and re-allocates (admin Issues page
  `apps/admin/pages/issues/picking.vue` + picking order detail). The full
  history (report, resolve, and all other transitions) is visible on the
  admin detail's audit-log table (`GET /admin/picking-orders/:id/logs`).
- Page work lock: opening the picking detail or scan-session page acquires
  the server-side work lock on the order (`POST /picking-orders/:id/work-lock`,
  refreshed every 3 min while open, keepalive release on leave, expires 10 min
  after `working_at`). A locked order's allocations are never wiped by
  `allocateAll`. A second user opening the same order gets 409 `lock_held` and
  a read-only page with a "held by <name>" banner.
- Allocation priority: `picking_orders.priority_seq` (lower = allocated
  first) drives both `allocateAll` demand order and the picking list order;
  `POST /picking-orders/reorder` rewrites it and re-allocates (admin UI
  comes with the console revamp).
- Allocation location matching: a picking order's `(org_id,
  sub_inventory_code)` pair must match the stock source's pair (pair-less
  orders are org-agnostic), widened by `sub_inventory_share_members` —
  sources whose sub-inventory shares the demand order's `share_group` (same
  org) also match. Groups are configured per warehouse on the admin
  sub-inventories page (`/admin/sub-inventory-share-groups`); the seed ships
  a demo group (org 2 STORE1 + WSTORE1 in `HK`). Customer-segregated stores
  keep their customer restriction even inside a share group.
- Whole-box exact-match claim: when a shelf box's current contents
  (`inventory_lots`, never the `shelf_box_items` put-away manifest) exactly
  equal the order's full remaining demand and no other order reserves any
  piece of it, the detail page shows a hint banner (`suggestedBox` on
  `GET /picking-orders/:id`) with a "Use whole box" action —
  `POST /picking-orders/:id/claim-shelf-box` reuses the carton as the
  shipping box in one tx: prefilled with box size/net/gross weight from the
  source receiving lines' `additional_data` (`{boxSize, netWeight,
  grossWeight, weightUnit}`, g→kg, default kg), one boxed package per
  (item, lot) portion, the order's allocations released, `source_shelf_box_id`
  recorded on the shipping box, and the order auto-finishes like the scan
  path (409 `box_not_exact_match` / `box_not_fully_available`).

## Out of scope

- Real camera barcode scanning (typed input / Android native rectangle detection only).
- Wave picking or batch picking across multiple orders.
- Pick-to-light or voice picking.
- Integration with external WMS/ERP.
- Server-side picking-scan matching — the scan session matches client-side
  (part + allocation fit), so client-side template validation is sufficient.
- Server-side picking serial dedup — the scan queue dedups by raw QR value
  within the session only; the same label scanned in two sessions can still
  double-pick (the server qty guard is the backstop).

## Key files

- `pages/picking/index.vue` — list page (search, status filter, batch issue
  report dialog).
- `pages/picking/[id].vue` — detail page (items/allocations/packages,
  boxes, logs, finish; single Scan action → scan session).
- `pages/picking/scan/[id].vue` — scan-session ("checkout") page: armed
  hardware scanner, OCR capture button (single-record confirm form /
  multi-item table review before queueing), local queue table, Confirm
  batch-apply, leave guard.
- `components/picking/PickingScanReviewModal.vue` — single-record OCR
  confirm form (editable fields + candidate chips, retake).
- `components/ScanMultiItemModal.vue` — shared multi-item OCR label
  table (part select + qty per row, per-row add results; also used by the
  put-away detail page).
- `composables/usePickingScanQueue.ts` — the session queue + client-side
  validation (tests in `tests/usePickingScanQueue.test.ts`).
- `composables/usePickingWorkLock.ts` — page work lock acquire/3-min
  refresh/keepalive release + `heldByOther` state (tests in
  `tests/usePickingWorkLock.test.ts`).
- `components/picking/PickingItemsSection.vue`,
  `components/picking/PickingBoxesSection.vue`,
  `components/picking/PickingIssueBanner.vue` — detail sub-views.
- `components/PickingIssueReportModal.vue` — batch issue report dialog.
- `composables/useLabelScan.ts` + `utils/parseOcrScan.ts` — label parsing
  (QR templates from `GET /scan-templates`, OCR fallback).
- `composables/useScanMatchers.ts` — client-side matchers for put-away and
  measuring (`matchPicking` remains but picking no longer routes through it —
  the scan session validates in `usePickingScanQueue` instead).
- `services/adapters/backendWarehouse.ts` — picking + shipping-box methods.
- `apps/backend/src/routes/picking.ts` + `apps/backend/src/db/picking.ts` —
  `GET /picking-orders`, `GET /picking-orders/:id`,
  `POST /picking-items/:id/scan`, `POST /picking-orders/:id/claim-shelf-box`,
  `/packages/:id` verbs,
  `/shipping-boxes/:id*` lifecycle, `POST /picking-orders/:id/finish`
  (→ measuring task), `POST /picking-orders/report-issues`,
  `POST /picking-orders/:id/resolve-issue`,
  `POST`/`DELETE /picking-orders/:id/work-lock`, `POST /picking-orders/reorder`.
- `apps/backend/src/db/allocate.ts` — allocation engine: demands in
  `priority_seq` order, skips work-locked orders, open qty = `qty − Σ
  picking_packages`.
- `apps/backend/src/routes/ingest.ts` + `apps/backend/src/db/ingest.ts` —
  `PUT /picking-orders/:externalId` upsert; a changed upsert triggers
  allocation.

## Known limitations

- **Work lock is best-effort:** page leave releases via keepalive fetch, but
  an app kill/crash relies on the 10-min expiry — an abandoned order can hold
  its allocations for up to 10 minutes. No force-release yet (admin console
  revamp); no lock stealing.
- **Allocation ids are unstable between scan and boxing:** post-scan
  `allocateAll` rebuilds an item's allocation rows with new ids until its
  packages are boxed, so the detail page re-fetches after every scan/box
  mutation instead of caching allocation ids (documented in
  `docs/backend/README.md`).
- Typed input simulates scanning; the Android native
  `RectangleDetection.scanLabel()` path is used in some camera flows but
  not all.
- Matching depends on normalized text and may require manual review.

## Related specs/plans

- `docs/backend/api-design.md` §Picking
- `docs/superpowers/specs/2026-07-01-ocr-assisted-picking-design.md`
- `docs/superpowers/specs/2026-07-03-picking-issue-reporting-design.md`
- `docs/superpowers/specs/2026-07-27-admin-issue-handling-design.md`
- `docs/superpowers/specs/2026-07-27-admin-item-removal-and-audit-logs-design.md`
- `docs/superpowers/specs/2026-07-03-package-level-picking-design.md`
- `docs/superpowers/specs/2026-07-10-allocation-box-remark-design.md`
- `docs/superpowers/specs/2026-07-18-picking-scan-session-design.md`
- `docs/superpowers/specs/2026-07-19-box-label-print-preprinted-id-design.md`
- `docs/superpowers/specs/2026-07-23-picking-priority-allocation-design.md`
- `docs/superpowers/specs/2026-07-29-whole-box-picking-claim-design.md`
- `docs/superpowers/plans/2026-07-23-picking-priority-allocation.md`
- `docs/superpowers/plans/2026-07-12-picking-execution.md`
- `docs/superpowers/plans/2026-07-18-picking-scan-session.md`
- `docs/superpowers/plans/2026-07-19-box-label-print-preprinted-id.md`
