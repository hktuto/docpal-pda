# Receiving — AI Scope and Remarks

## In scope

- Per-user sub-inventory scope on list + detail reads: when the caller has a
  scope set (`user_profiles`, managed via `GET`/`PUT /auth/me/profile` or
  `/admin/user-profiles`), the list keeps an order only when it has no items
  or any item whose `sub_inventory_code` is NULL or in scope (aggregates
  unchanged); the detail 404s when out of scope and filters the returned
  items to NULL/in-scope. Enforcement is server-side
  (`apps/backend/src/db/user-scope.ts`), composes with `allowedOrgIds` by
  AND, reads only — mutations unaffected (spec
  `docs/superpowers/specs/2026-09-11-user-subinventory-scope-design.md`).
- List receiving orders with a status filter
  (`pending` / `provisional_received` / `in_hand` / `clear`) and a pending
  picking-order count badge per order (computed server-side); the list is
  paged server-side (50 per page, Load more) with server-side search.
- Show receiving order detail as one nested read: supplier (+ PDA profile),
  invoices → items (part embedded), each item carrying its flat mismatch
  columns.
- Confirm arrival (flips the order toward `in_hand`, re-stamps each item's
  `sub_inventory_code` from the configured `receivingSubInventoryRules`
  org/po-pattern rules, and triggers the backend's best-effort allocation
  pass).
- Label scanning with **server-side parse/match**: the raw label goes to
  `POST /receiving-orders/:id/scan`; on a 409 `{message, candidates}`
  (`no_match` / `multiple_matches`) the review modal lets the operator pick
  a candidate and resend with an explicit `{partNo, qty}` (the raw rides
  along so serial dedup still applies).
- Multi-item labels (e.g. a carton label whose items table lists several
  parts): the client parses the raw capture into one row per item
  (`extractMultiItemRows` in `utils/parseOcrScan.ts`) before posting; 2+
  rows opens the multi-item table modal (per-row part dropdown + qty, row
  remove, per-row ✓/✗ status) and applying loops one explicit
  `{partNo, qty}` scan per row (raw is not resent, so serial dedup never
  trips on the second row; succeeded rows are locked out of retries).
- S-key serial dedup: a parsed `serialNo` (KOA S-key) is recorded per order
  in `receiving_scan_labels`; a repeat serial is rejected with
  `409 label_already_scanned`. Scans without a serial skip dedup.
- Scanner symbology whitelist: while the detail page is open, the hardware
  decoder is restricted to the supplier profile's `barcode_types` (when set),
  so other symbologies on multi-barcode labels don't decode at all; restored
  on page leave (`useSupplierSymbologyScope`, xcheng/Movfast devices only).
- Report, edit, confirm, and cancel receiving item mismatches — **item-keyed**
  (every call addresses the receiving invoice item id; the mismatch is a set
  of flat columns on the item, no separate table, no status/reporter).
  Confirm writes a transition log; cancel clears the flag. The admin console
  lists open mismatches across orders (`GET /admin/receiving-mismatches`,
  `apps/admin/pages/issues/receiving.vue`) and confirms/cancels from there;
  admins can also report a mismatch themselves (Mark issue on the admin
  receiving detail) and remove a not-yet-worked issue item
  (`DELETE /admin/receiving-invoice-items/:id`, 409 `item_work_started`,
  `item_removed` log row against the order). Both admin detail pages render
  the order's `transaction_logs` audit trail
  (`GET /admin/receiving-orders/:id/logs`, server-paged/searchable/sortable
  via `?page=&pageSize=&q=&sort=&dir=`; item-typed rows carry
  partNo/poNo/poLine in `metadata`).
- Show the order's picking section (nested orders with items, allocations,
  packages, transition logs, and shipping boxes) on the detail's Picking tab.
  Allocation lots carry `shelfWarning` (`shelves.warning`) — shown as a ⚠️
  icon next to the shelf code when set.
  The tab (and its fetch) is hidden when flow config
  `picking.allocation.allowDockStock=false` — put-away is then a hard gate
  and receiving is decoupled from picking.
- The admin console's receiving detail (`apps/admin/pages/receiving/[id].vue`)
  can confirm arrival itself (Confirm In-hand button while `pending` /
  `provisional_received`, same `confirm-arrival` endpoint), edit item batch
  details (date code / lot code / COO / COW / ctn no via
  `PATCH /admin/receiving-invoice-items/:id` — per-row edit modal or
  multi-select batch edit where blank fields keep each item's current value;
  `apps/admin/components/receiving/ItemEditModal.vue`), and download the
  shipper xlsx (`GET /admin/receiving-orders/:id/shipper`,
  `apps/backend/src/routes/admin/receivingShipper.ts`): receipts grouped
  by part, each group one merged block (customer names / order_nos overlaid
  on the block's last rows, one `invoice_no ctn_no` item row per carton)
  with per-block slots, per-group Total/Balance, and a group header cell
  showing the related-order allocated qty (Σ allocations of the part on the
  picking orders tracing back to this receiving order, any source; spec
  `docs/superpowers/specs/2026-09-16-admin-receiving-shipper-related-allocated-design.md`).
  The
  download is read-only; a separate Re-allocate button (`in_hand` only)
  awaits `POST /admin/receiving-orders/:id/reallocate` (same scoped core as
  confirm-arrival; 404 `receiving_order_not_found`, 409
  `order_not_in_hand`) to recompute the order's allocations first if stale;
  whole-order (no `ctn_no`) allocations close each group on a closing
  `(order-level)` block. Completed (`clear`) orders get
  `?mode=finished` instead — same layout, slots from actual
  `picking_packages` (direct + lot-traced via `inventory_lot_sources`).
- Admin receiving detail per-item actions (spec
  `docs/superpowers/specs/2026-09-15-admin-picking-item-actions-design.md`):
  a search icon on the part-no cell opens the part-search + allocate dialog
  (`apps/admin/components/receiving/PartSearchModal.vue`): the part's open
  picking demand (`GET /admin/part-demand`, split by
  `components/receiving/PartDemandTables.vue` into rows matching the item's
  org/sub-inventory vs all other demand) with a per-row qty input + Allocate
  that pins a manual allocation sourced from this receiving item (capped by
  the item's received qty minus already-allocated/picked), plus a read-only
  related-stock table (`GET /admin/part-availability`, stock only);
  `GET /receiving-orders/:id` embeds each item's `orgId`/`subInventoryCode`
  and `allocations` (qty, manual flag, picking order no/status), rendered in
  the allocated-qty cell (shared `apps/admin/components/allocations/`
  `ReceivingAllocationRow`, blue dot) with a per-allocation (x) →
  `DELETE /admin/picking-orders/:id/items/:itemId/allocations/:allocationId`;
  a hover tooltip on each row shows the target picking order (link to the
  admin picking-order detail), its status and the allocated qty.

## Out of scope

- ASN (advance shipping notice) import.
- Supplier label printing.
- Integration with carrier tracking.
- Quality inspection hold statuses.
- Client-side scan candidate search (`getScanCandidates` /
  `/scan-candidates`) — removed; matching is server-side now.

## Key files

- `pages/receiving/index.vue` — list page (compact rows, sticky status
  filter + search, picking badge; server-side paging — 50-row pages with
  Load more, refresh button, debounced server-side search).
- `pages/receiving/[id].vue` — detail page (items + picking tabs, confirm
  arrival, scan entry points).
- `components/receiving/ReceivingItemsTab.vue` — items sub-view: compact
  per-row-expand rows grouped by carton number (`ctnNo`, trailing "no
  carton" group; flat when no carton numbers exist), mismatch actions
  inside the expanded row.
- `components/receiving/ReceivingPickingTab.vue` — picking sub-view.
- `components/receiving/ReceivingScanReviewModal.vue` — candidate review
  dialog for scan 409s.
- `components/receiving/ReceivingScanMultiItemModal.vue` — multi-item label
  review table (row per parsed item, editable part/qty, per-row apply
  status).
- `composables/useReceivingScan.ts` — scan submission, multi-item pre-check,
  409 → review flow, and the per-row `applyRows` loop.
- `components/ReportIssueModal.vue` + `utils/mismatch.ts`
  (`validateMismatchInputs`) — mismatch dialog and its pure validation.
- `services/adapters/backendWarehouse.ts` — receiving + mismatch methods.
- `apps/backend/src/routes/receiving.ts` + `apps/backend/src/db/receiving.ts` —
  `GET /receiving-orders?status=`, `GET /receiving-orders/:id` (+`/picking`),
  `POST .../confirm-arrival`, `POST .../scan` (with serial dedup), and the
  item-keyed mismatch CRUD: `GET|POST|PATCH
  /receiving-invoice-items/:id/mismatch`, `POST .../mismatch/confirm|cancel`.
- `apps/backend/src/db/ingest.ts` — reusable sync apply layer for upstream
  receiving orders (replaced the retired `PUT /receiving-orders/:batchNo`
  ingest route and the ElectricSQL consumer).
- `apps/backend/src/db/allocate.ts` — `allocateAll` runs best-effort after
  confirm-arrival and other stock-changing commits.

## Known limitations

- Demo-only data; no real supplier integration.
- Mismatch resolution rules are simplified (flat columns; confirm/cancel
  only — no approval chain).
- Allocation runs are best-effort: a failure never rolls back the committed
  write.

## Related specs/plans

- `docs/backend/api-design.md` §Receiving
- `docs/superpowers/specs/2026-07-01-receiving-list-picking-order-count-design.md`
- `docs/superpowers/specs/2026-07-03-receiving-mismatch-design.md`
- `docs/superpowers/specs/2026-07-27-admin-issue-handling-design.md`
- `docs/superpowers/specs/2026-07-27-admin-item-removal-and-audit-logs-design.md`
- `docs/superpowers/specs/2026-09-02-receiving-subinventory-rules-design.md`
- `docs/superpowers/specs/2026-09-14-admin-receiving-shipper-download-design.md`
- `docs/superpowers/specs/2026-09-11-user-subinventory-scope-design.md`
