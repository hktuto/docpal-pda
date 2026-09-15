# Picking — AI Scope and Remarks

## In scope

- Per-user sub-inventory scope on list + detail reads: when the caller has a
  scope set (`user_profiles`, managed via `GET`/`PUT /auth/me/profile` or
  `/admin/user-profiles`), the list/detail are filtered by a predicate on the
  order's `(org_id, sub_inventory_code)` pair (NULL sub-inventory stays
  visible; out-of-scope detail = 404). Enforcement is server-side
  (`apps/backend/src/db/user-scope.ts`), composes with `allowedOrgIds` by
  AND, reads only — mutations, allocation and SSE events unaffected (spec
  `docs/superpowers/specs/2026-09-11-user-subinventory-scope-design.md`).
- List picking orders with a status filter and text search (both
  server-side, paged 50 at a time); multi-select batch issue reporting.
- Show picking order detail as one nested read: order (incl. issue fields),
  items → allocations (with lot or receiving-area
  source) and packages, plus the shipping boxes.
- Scan-to-pick ("checkout" scan session): one Scan button per picking order
  opens `/picking/scan/:id`. The hardware scanner is armed only on that page;
  each QR scan is validated client-side (part matches an order item, qty fits
  the first allocation with enough remaining minus already-queued qty,
  duplicate raw QR rejected) and appended to a local queue table — no per-scan
  confirm/review. Each item row shows where its remaining qty is allocated
  from (`allocationSources` — `CTN <ctn>`, `<box> @ <shelf>`, or a bare shelf
  code) so the operator knows what/where to scan. A raw scan that matches no
  supplier QR template is treated as a location barcode, with two behaviors:
  a **receiving carton** (`ctn_no` — `matchCartonAllocations`) auto-queues
  everything the order still needs from that carton (`addCartonScan`, one
  row per allocation at its full remaining; re-scan = duplicate), because a
  supplier carton's contents are known and sealed; a **shelf box id or shelf
  code** (`lot.boxId` / `lot.shelfCode` — `matchBoxAllocations`) opens the
  "pick from box" dialog (`PickFromBoxDialog`) listing what the order
  still needs from it, and part-label scans while it is open are queued
  against that box's allocations only (`addAllocationScan` — part must
  match, label qty must fit the allocation's remaining; distinct
  `part_not_in_box` / `qty_exceeds` toasts). Scanning another box/shelf
  barcode switches the dialog to it; scanning a carton closes it and queues
  the carton. An OCR button captures a label with the
  camera: a capture
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
  Cross-order packing: a box accepts any open order's unboxed packages, and
  the boxes section's **Scan item into box** mode (`POST
  /shipping-boxes/:id/scan`) resolves a scanned part barcode across ALL open
  orders (404 `no_matching_picking_item`, 409 `ambiguous_picking_item`) and
  picks it straight into the box — `shipping_boxes.picking_order_id` stays
  as the informational creator order only.
- Box labels + pre-printed box ids: on the picking detail page the
  hardware scanner is armed for box ids — a scan that does not match a
  supplier QR template creates an open box with that scanned (pre-printed)
  id; item QRs get a "use scan mode" toast. A "Scan box id" button covers
  camera/manual entry. Server side, `createShippingBox` accepts an optional
  `boxId` (409 `box_id_exists` on duplicates — the id is the global PK);
  server-generated ids follow `BOX-S-<YYYYMMDD>-<seq>` (per-day
  seq, `nextBoxId` in `apps/backend/src/db/boxes.ts`).
  The per-box Print button on the picking detail was removed (2026-07);
  the receiving picking tab's Print button remains a placeholder — real
  printing will be added backend-side later.
- Finish a picking order manually, or automatically when the last package
  is boxed — finish just flips the order to `finished`; no next-step task is
  created (closing a box is the measuring completion, and the box's verify
  task is spawned by `closeShippingBox`).
- Per-order issue reporting (`POST /picking-orders/report-issues`). An issued
  order is frozen (scan/unpack 409, excluded from `allocateAll`) until an
  admin resolves it — `POST /picking-orders/:id/resolve-issue` returns it to
  `pending`, clears the `issue_*` columns and re-allocates (admin Issues page
  `apps/admin/pages/issues/picking.vue` + picking order detail). The full
  history (report, resolve, and all other transitions) is visible on the
  admin detail's audit-log table (`GET /admin/picking-orders/:id/logs`,
  server-paged/searchable/sortable via `?page=&pageSize=&q=&sort=&dir=`;
  item-typed rows carry partNo in `metadata`).
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
- Admin manual allocation triggers (spec
  `docs/superpowers/specs/2026-09-14-admin-allocation-buttons-design.md`):
  "Allocate all" on the admin picking-order list page awaits the full
  `allocateAll` via `POST /admin/allocation/run`; "Re-allocate" on the admin
  picking-order detail page (visible while pending/picking) awaits
  `POST /admin/picking-orders/:id/reallocate` — a recompute scoped to that
  order's part keys (`allocateForPickingOrder`), which also rebuilds sibling
  orders sharing a part and 409s on a live work lock (`lock_held` with the
  holder's name) or a non-open order (`order_not_open`).
- Admin picking-item actions (spec
  `docs/superpowers/specs/2026-09-15-admin-picking-item-actions-design.md`):
  each allocation row in the items table of the admin picking-order detail
  page has an (x) remove button
  (`DELETE /admin/picking-orders/:id/items/:itemId/allocations/:allocationId`
  → `removePickingAllocation`) that deletes that one allocation row,
  releases the lot's `allocated_qty`, and logs an audit row — deliberately
  transient, so the next `allocateAll`/scoped recompute may re-allocate the
  item (404 `picking_order_not_found`/`picking_item_not_found`/
  `allocation_not_found`, 409 `lock_held`; NO order-status check); and the
  part-no cell has a search icon opening a modal over
  `GET /admin/part-availability?partNo=&wclItemNo=` listing every stock lot
  and receiving order containing the part across ALL org/sub-inventory
  locations (rows matching the order's pair are highlighted). The modal
  also pins MANUAL allocations: each row has a qty input + Allocate button
  (`POST /admin/picking-orders/:id/items/:itemId/allocations`, any
  location, capped by source availability and the item's open demand —
  409 `insufficient_available` / `over_allocation`). Manual rows
  (`allocations.manual = true`) are pinned: `allocateAll` /
  `runScopedAllocation` never wipe them and subtract their qty from the
  item's auto-allocation demand.
- Admin picking-list download (spec
  `docs/superpowers/specs/2026-09-14-admin-picking-list-download-design.md`):
  "Download picking list" on the admin picking-order detail page fetches
  `GET /admin/picking-orders/:id/picking-list`
  (`apps/backend/src/routes/admin/pickingList.ts`) — a read-only xlsx with an
  order-info block and one flat row per allocation (shelf / box / date code /
  lot / source org+sub-inventory / qty for lot sources, `Receiving {batchNo}`
  / `(dock)` for dock sources, `UNALLOCATED` shortfall rows, `(no allocation)`
  for unallocated items). It never recomputes allocations — the operator uses
  the explicit Re-allocate action first if the sheet might be stale.
- Admin order-field edits: the admin picking-order detail page inline-edits
  the delivery date, the ship-to (single-select dropdown over
  `GET /admin/countries` — shows the `country_list` name, stores the code),
  and the ship-from location pair
  (org + sub-inventory, chosen from `GET /admin/sub-inventories`; the pair is
  a composite FK to `org_info` so both must be set together, both empty
  clears it) via `PATCH /admin/picking-orders/:id`
  (`apps/backend/src/db/adminedits.ts` `updatePickingDeliveryDate` /
  `updatePickingOrderFields`). Each change writes a `transaction_logs`
  `admin_edit` audit row (metadata field/from/to); a location change also
  schedules a background `allocateAll` because location-matched allocations
  go stale. The detail grid also shows the read-only `picking_order_type`
  and `remark` (also list columns; the list filters type client-side,
  invoice/tn).
- Allocation location matching: a picking order's `(org_id,
  sub_inventory_code)` pair must match the stock source's pair (pair-less
  orders are org-agnostic), widened by `sub_inventory_share_members` —
  sources whose sub-inventory shares the demand order's `share_group` (same
  org) also match. Groups are configured per warehouse on the admin
  sub-inventories page (`/admin/sub-inventory-share-groups`); the seed ships
  a demo group (org 2 STORE1 + WSTORE1 in `HK`). Customer-segregated stores
  keep their customer restriction even inside a share group. Transfer orders
  are the exception: items carrying `additional_data.from_subinventory` name
  their source there (the order's pair is the destination) — `allocateAll`
  converts the demand's pair via flow-config `pickingFromSubinventoryOrgs`
  (from_subinventory → org), taking the sub-inventory from
  `receivingSubInventoryRules` over the item's `additional_data.order_no`
  (fallback: `additional_data.po_no`, else the group default; no rule match →
  the from_subinventory code itself; no org group → order pair unchanged). Pure
  lookup at allocation time, nothing is written back (spec
  `docs/superpowers/specs/2026-09-03-picking-from-subinventory-orgs-design.md`).
- Allocation sources: shelf lots first, then in-hand receiving (dock) stock —
  a picking order can allocate straight off the receiving dock before
  put-away (cross-dock). When the flow config (`warehouse_config` row
  `"flow"`) sets
  `steps.picking.allocation.allowDockStock=false`, dock stock is skipped and
  only put-away lots allocate — put-away becomes a hard gate and uncovered
  orders stay `unallocated`/`partial` until put-away happens (spec
  `docs/superpowers/specs/2026-08-10-flow-config-design.md`).
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
- Shipping-box prefill on the pack path: when a package lands in a shipping
  box (`addPackageToBox` / `add-all-unboxed`), the box's still-NULL box
  size/net/gross are filled from the receiving lines behind the box's
  packages (`receiving_invoice_item` sources directly, lot sources via
  `inventory_lot_sources`; order-level receiving sources record no line and
  stay manual). COALESCE only — operator edits are never clobbered. This is
  what carries a picked carton's `additional_data` into measuring.

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

- `pages/picking/index.vue` — list page (compact rows, sticky search,
  status filter, batch issue report dialog; server-side paging — 50-row
  pages with Load more, refresh button, debounced server-side search and
  multi-status/allocation filters).
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
- `components/picking/PickingItemsSection.vue` — items sub-view: compact
  per-row-expand rows (status badge + required/scanned and boxed/total
  progress at a glance; allocations and package/box actions inside the
  expanded row),
  `components/picking/PickingBoxesSection.vue` (incl. the per-box
  **Scan item into box** cross-order toggle),
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
  `/shipping-boxes/:id*` lifecycle (incl. `POST /shipping-boxes/:id/scan`
  cross-order scan-to-box), `POST /picking-orders/:id/finish`
  (→ `{id, status}`, no task), `POST /picking-orders/report-issues`,
  `POST /picking-orders/:id/resolve-issue`,
  `POST`/`DELETE /picking-orders/:id/work-lock`, `POST /picking-orders/reorder`.
- `apps/backend/src/db/allocate.ts` — allocation engine: demands in
  `priority_seq` order, skips work-locked orders, open qty = `qty − Σ
  picking_packages`.
- `apps/backend/src/db/ingest.ts` — reusable sync apply layer for upstream
  picking orders (replaced the retired `PUT /picking-orders/:id` ingest route
  and the ElectricSQL consumer); a synced order change should trigger
  re-allocation.

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
- `docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`
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
- `docs/superpowers/specs/2026-09-11-user-subinventory-scope-design.md`
- `docs/superpowers/plans/2026-07-23-picking-priority-allocation.md`
- `docs/superpowers/plans/2026-07-12-picking-execution.md`
- `docs/superpowers/plans/2026-07-18-picking-scan-session.md`
- `docs/superpowers/plans/2026-07-19-box-label-print-preprinted-id.md`
