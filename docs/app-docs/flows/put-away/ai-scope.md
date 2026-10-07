# Put-away — AI Scope and Remarks

## In scope

- List put-away candidates (in-hand receiving orders with unboxed received
  pieces) — manual mode.
- Task mode (flow config `steps.put-away.autoCreateTasks`, `warehouse_config`
  row `"flow"`): the list
  page shows the `put_away_tasks` queue instead (`GET /put-away-tasks`) — one
  pending task per receiving order, auto-created in the arrival-confirm tx,
  completed by the auto-clear. The task detail (`GET /put-away-tasks/:id`) is
  the same per-order aggregate plus the task row.
- Show the put-away detail as **one aggregate read**
  (`GET /receiving-orders/:id/put-away`): expected invoice items (with
  remaining qty and a per-item shelf/box suggestion —
  `suggestedShelfCode` / `suggestedBoxId` / `suggestionReason`, ranked
  within the item's org + sub-inventory (the partition pair lives on
  receiving ITEMS — items with no pair get no suggestion): most recent OPEN
  shelf box containing the same part → shelf of the most recent lot of the
  same part →
  first shelf whose advisory `shelves.sub_inventory_scopes` contain the
  item's org + sub-inventory pair;
  `steps.put-away.suggestShelf=off` suppresses it; advisory only, computed
  at read time, never stored), materialized inventory lots, staging scans,
  and the non-staging shelf boxes with their item rows.
- Scan physical pieces (client-side label validation against supplier QR
  templates). **Shelf-direct flow (spec
  `2026-10-06-put-away-shelf-direct-design.md`)** — the operator never sees a
  box. Commit rule: a scan commits onto the selected shelf iff one is
  selected (banner with × to deselect); otherwise it waits in the pending
  list. A shelf QR scan selects the shelf and — when pieces are pending —
  prompts "Put N pcs to shelf X?": confirming calls
  `POST /receiving-orders/:id/put-away-commit`, which assigns every pending
  scan onto the shelf in ONE backend tx (the order's box there is
  found-or-created invisibly; `shelfCode` on `put-away-scans` does the same
  Pending scans live inside each item's expanded detail (under the matching
  invoice line) alongside the **committed scans** (the aggregate's `scans[]`
  carries every scan of the order — pending ones have `shelfCode: null`,
  committed ones carry their shelf + box): pending rows offer **Add to
  shelf** (enabled with a shelf selected; commits just that row via
  `put-away-commit` with `scanIds`) and **Remove** (hard-delete, mis-scan
  correction); committed rows show their shelf/box and offer **Remove from
  shelf** (`DELETE /shelf-boxes/:boxId/scans/:scanId` — reverses the lot +
  ledger, moving the qty back to pending; 409 `lot_has_pick_allocations` when
  the lot feeds pick allocations). A `BOX-*` scan is rejected with an
  informational toast — boxes are not used in this flow. The detail list is
  grouped by part number — all visible invoice lines of one part render as a
  single card with summed qty (`utils/putAwayGroups.ts`
  `groupPutAwayItems`, spec `2026-10-05-put-away-part-grouping-design`);
  expanding the card lists the member lines with their per-line remaining +
  batch values. One label's qty may span several same-part lines (a 20300
  package against 300 + 20000 lines): every write path splits the qty FIFO
  across the group's lines into one `recordPutAwayScan` per line
  (`utils/putAwayScan.ts` `findPutAwayTargets`) — hardware gun scan, OCR
  review apply (`matchPutAway` matches against the review context's
  `putAwayItems` = all visible order lines, so a part number corrected in
  the review form can re-match any line; an unchanged part still spans only
  its own group's lines), and the multi-item table. The hardware scanner
  is armed on the detail page: a QR/wedge scan parses via the supplier
  templates and applies immediately. Item-first mode (opt-in): the per-card
  "Gun scan" button on `PutAwayLotsPanel.vue` emits `arm-scan`; the page
  holds `armedItemId` as the armed part GROUP's key (toggle to disarm,
  another card re-arms) and the armed card shows a highlighted border + badge
  + hint. Scanner routing: shelf QR (exact shelf-code match, sticky
  `selectedShelf`) → `BOX-*` (toast) → armed group (strict
  `findPutAwayTargets` against that group's lines only, same
  `errors.scanned_part_does_not_match_item` toast on mismatch) → free-match.
  A successful armed scan stays armed; the armed state auto-clears when a
  reload drops the group from `groups`. The per-card camera OCR button opens
  a review step first: a single parsed record pops the
  `LabelScanReviewModal` confirm form (`confirmSingleMatch: true`); a
  multi-item (carton) label pops the shared `ScanMultiItemModal` table and
  rows are applied one by one. All write paths thread the selected shelf
  (`shelfCode`) so reviewed scans follow the same commit rule as gun scans.
  The review form's Apply re-matches the EDITED fields before writing (spec
  `2026-10-07-label-scan-review-edits-and-country-dropdown-design`), and
  `recordPutAwayScan` lets a supplied batch value overwrite the one stamped
  on the invoice item (null keeps it). Part no in the form is a select over
  the order's visible lines (the review context's `putAwayItems` carries ALL
  visible lines so a corrected part re-matches; matching still splits FIFO
  over the selected part's lines only). COO/COW are country dropdowns
  (`CountrySelect` over the `country_list` master via `useCountryList` →
  `GET /admin/countries`, value = ISO code, names localized client-side via
  the `countryLabels` locale map) and default to EMPTY — the operator picks
  explicitly; OCR-parsed values stay as raw extra options.
- Scanner symbology whitelist: while the detail page is open, the hardware
  decoder is restricted to the supplier profile's `barcode_types` (when set),
  but the shelf/box QR symbologies always stay enabled — shelf scanning is
  core to this flow (`useSupplierSymbologyScope(..., { withShelfCodes: true })`,
  xcheng/Movfast only); restored on page leave.
- Boxes exist in the data model but are invisible to the operator: every
  commit lands in a `shelf_boxes` row found-or-created per (order, shelf)
  (`ensureOrderShelfBoxTx` — reuse the open box holding the order's items →
  adopt an empty open box on the shelf → create with the order's pair), so
  `inventory_lots`, `inventory_lot_sources`, the PUT_AWAY ledger, allocation
  sources, stock search, and the sync feed keep their exact box-era shape.
  The old operator-facing box UI (box list, scan-box dialog, active box,
  close/cancel, per-scan box dropdowns, staging-box QR) is removed.
- Select a destination shelf by scanning its QR code (the shelf list comes
  from the `/admin/shelves` CRUD read).
- Supplier outdated date-code scan warnings (spec
  `docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md`):
  when a put-away scan's label date code is older than the receiving order
  supplier's `supplier_profiles.outdated_limit_months` (NULL = no check),
  the scan still succeeds but records an `outdated_scan_warnings` row inside
  the scan tx and the `POST /receiving-orders/:id/put-away-scans` response
  carries `outdatedWarning: {supplierCode, dateCode, limitMonths}` — the
  detail page shows the dismissible `components/OutdatedWarningDialog.vue`
  alert and scanning continues. The put-away commit is NOT blocked; instead
  the auto-clear (`tryMarkReceivingOrderClear`, which also completes the
  put-away task) is held while the order has unresolved warnings — the order
  stays `in_hand`. `GET /put-away/candidates`, `GET /put-away-tasks` and the
  `GET /receiving-orders/:id/put-away` aggregate carry
  `outdatedWarningCount` (unresolved) → warning chip when > 0. An admin
  resolves the whole order's warnings
  (`POST /admin/outdated-warnings/resolve-order`), which also re-runs the
  held auto-clear (`retryReceivingOrderClear`) so the order clears on
  resolution. SSE: `outdated.warning.created` /
  `outdated.warning.resolved` (topics `/admin/outdated-warnings` +
  `/receiving-orders`). Backend module: `apps/backend/src/db/outdated.ts`
  (shared with the picking flow).

## Out of scope

- Velocity/zone/capacity-aware slotting (the suggestion hint is
  same-part-box / existing-stock / org-affinity only; fixed slots would be a
  new `suggestShelf` strategy). `shelves.sub_inventory_scopes` is advisory — it
  ranks suggestions but is not enforced at scan time. It is a
  jsonb array of `{ orgId, code }` pairs (a shelf can serve several
  sub-inventories, org-scoped since codes repeat across orgs), edited with an
  org-grouped picker in the admin shelves CRUD.
- Forklift or robot integration.
- Multi-step directed put-away with confirmation checkpoints.
- Operator assignment / work locks on put-away tasks; manual
  complete/cancel task endpoints.

## Key files

- `pages/put-away/index.vue` — candidate list.
- `pages/put-away/[id].vue` — detail page (shelf banner, pending panel,
  part-group item cards; title/status badge/supplier info registered into the
  app header via `composables/usePageHeader.ts`; armed hardware scanner +
  camera OCR scan entry with single-record form / multi-item table review).
- `utils/putAwayScan.ts` — `findPutAwayTargets` FIFO split of one scan's qty
  across same-part lines (plus the legacy single-line `findPutAwayTarget`)
  and `classifyPutAwayScan` shelf/box/item scan routing (tests in
  `tests/putAwayScan.test.ts`).
- `utils/putAwayGroups.ts` — part-group display model for the detail page:
  `groupPutAwayItems` (summed qty per part, staged qty folded in) and
  `putAwayGroupFieldValue` (qty fields summed, batch fields distinct-joined).
- `components/ScanMultiItemModal.vue` — shared multi-item label table (also
  used by the picking scan session).
- `components/OutdatedWarningDialog.vue` — dismissible outdated date-code
  alert shown when a scan response carries `outdatedWarning`.
- `components/put-away/PutAwayLotsPanel.vue` — expected items as part-group
  cards built on the shared `AppListRow` (same config-driven design as the
  receiving/picking detail rows): identity field = title, collapsed meta =
  the configured `putAwayDetail.itemFields` ("Label: value" segments, empty
  omitted — `suggested_shelf` renders the group suggestion) + a
  Total/Scanned/Put-away progress line, expanded = the configured
  `expandedFields` + member lines + the line's pending scans (per-row
  Add-to-shelf / Remove); per-card "Gun scan" button (`arm-scan` emit) +
  armed-card styling driven by the group-key `armedItemId` prop. The detail
  page's app-header title renders through the put-away list's title
  template (`viewListRow("put-away", …)`), same as the list rows.
- `composables/useScanMatchers.ts` — client-side `matchPutAway` validation
  against the reviewed card's part-group member lines (aggregate remaining);
  apply splits FIFO into `WarehouseService.recordPutAwayScan` calls per line,
  threading the selected shelf (`shelfCode`) so reviewed scans follow the
  same commit rule as gun scans.
- `services/adapters/backendWarehouse.ts` — put-away methods
  (`recordPutAwayScan` with `shelfCode`, `commitPutAwayToShelf`,
  `removePutAwayScannedPiece`).
- `apps/backend/src/routes/putaway.ts` + `apps/backend/src/db/putaway.ts` —
  `GET /put-away/candidates`, `GET /receiving-orders/:id/put-away`,
  `POST /receiving-orders/:id/put-away-scans` (optional `shelfCode`/`shelfBoxId`
  = commit straight onto the shelf/box in one tx),
  `POST /receiving-orders/:id/put-away-commit` (all/selected pending scans
  onto a shelf in one tx), `DELETE /put-away-scans/:scanId`,
  `/shelf-boxes*` lifecycle kept for admin/debug (lot materialization +
  receiving-order auto-clear; reversal path for committed stock).
- `apps/backend/src/db/putawaytasks.ts` — task mode: `createPutAwayTaskTx`
  (called from `confirmReceivingArrival` when `autoCreateTasks` is on),
  `completePutAwayTaskTx` (called from `tryMarkReceivingOrderClear`),
  `listPutAwayTasks`, `getPutAwayTaskDetail` (+ shelf suggestion).

## Known limitations

- Shelf selection is manual; no validation of shelf capacity or restrictions.
- Scanned pieces are tracked per receiving invoice item. The app does not
  support splitting a single scanned piece across multiple shelves.
- Moving committed stock between shelves is not supported (reverse + re-scan
  instead).
- Put-away scans dedup by supplier serial only when the label carries one
  (e.g. iC-Haus LTS → `serialNo` template group → `shelf_box_items.serial_no`):
  a repeat serial on the same receiving order is rejected with 409
  `label_already_scanned` (mirrors the receiving S-key check; deleting the
  scan frees the serial). Labels without a serial group are not deduped —
  the camera-OCR and multi-item paths do not pass a serial either.

## Related specs/plans

- `docs/backend/api-design.md` §Put-away
- `docs/superpowers/specs/2026-08-10-put-away-tasks-design.md`
- `docs/superpowers/specs/2026-08-12-put-away-shelf-org-suggestion-design.md`
- `docs/superpowers/specs/2026-08-10-flow-config-design.md`
- `docs/superpowers/specs/2026-07-03-cancel-empty-box-design.md`
- `docs/superpowers/specs/2026-07-06-put-away-scan-first-design.md`
- `docs/superpowers/plans/2026-07-06-put-away-scan-first.md`
- `docs/superpowers/specs/2026-07-20-put-away-scan-box-design.md`
- `docs/superpowers/specs/2026-10-02-put-away-item-first-scan-design.md`
- `docs/superpowers/specs/2026-10-05-put-away-scan-box-shelf-design.md`
- `docs/superpowers/specs/2026-10-05-put-away-part-grouping-design.md`
- `docs/superpowers/specs/2026-10-06-put-away-shelf-direct-design.md`
- `docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md`
