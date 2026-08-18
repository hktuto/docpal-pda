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
  first shelf whose advisory `shelves.sub_inventory_codes` contain the
  item's sub-inventory;
  `steps.put-away.suggestShelf=off` suppresses it; advisory only, computed
  at read time, never stored), materialized inventory lots, staging scans,
  and the non-staging shelf boxes with their item rows.
- Scan physical pieces into the order's staging box (client-side label
  validation against supplier QR templates). The hardware scanner is armed on
  the detail page: a QR/wedge scan parses via the supplier templates and
  applies immediately to the first visible item whose part matches and whose
  `remainingQty` fits (`utils/putAwayScan.ts` `findPutAwayTarget`). The
  per-item camera OCR button opens a review step first: a single parsed
  record pops the `LabelScanReviewModal` confirm form
  (`confirmSingleMatch: true`); a multi-item (carton) label pops the shared
  `ScanMultiItemModal` table and rows are applied one by one.
- Assign staging scans into shelf boxes (one box per shelf), add-all-unboxed,
  remove-from-box, and remove scanned pieces.
- Scan a physical box QR to create a box: the "Scan box" button opens a
  dialog with the scanned (or manually typed) box id + a shelf dropdown; the
  backend uses that id for the box (an existing open box of the same order is
  reused, any other duplicate is a 409 `box_id_already_exists`). The
  created/scanned box becomes the **active box** (highlighted, switchable via
  a "Set active" button per open box); while an active box is set, every part
  scan — hardware scan, OCR review apply, multi-item apply — is assigned
  straight into it (`POST /receiving-orders/:id/put-away-scans` with
  `shelfBoxId`, one tx: staging insert + assign + lot materialization)
  instead of going to staging.
- Create / close / cancel shelf boxes; closing materializes inventory lots
  and auto-clears the receiving order when its last piece is boxed. Shelf box
  ids are server-generated as `BOX-H-<warehouse>-<YYYYMMDD>-<seq>` (per-day
  seq, `nextBoxId` in `apps/backend/src/db/boxes.ts`) unless a physical box id
  was scanned.
- Select a destination shelf (the `/admin/shelves` CRUD read doubles as the
  shelf list).

## Out of scope

- Velocity/zone/capacity-aware slotting (the suggestion hint is
  same-part-box / existing-stock / org-affinity only; fixed slots would be a
  new `suggestShelf` strategy). `shelves.sub_inventory_codes` is advisory — it
  ranks suggestions but is not enforced at scan time. It is a
  text array (a shelf can serve several sub-inventories), edited as a
  multi-select in the admin shelves CRUD.
- Forklift or robot integration.
- Multi-step directed put-away with confirmation checkpoints.
- Operator assignment / work locks on put-away tasks; manual
  complete/cancel task endpoints.

## Key files

- `pages/put-away/index.vue` — candidate list.
- `pages/put-away/[id].vue` — detail page (expected items, lots, scans,
  boxes; armed hardware scanner + camera OCR scan entry with
  single-record form / multi-item table review).
- `utils/putAwayScan.ts` — `findPutAwayTarget` first-fit item matching for
  hardware QR scans (tests in `tests/putAwayScan.test.ts`).
- `components/ScanMultiItemModal.vue` — shared multi-item label table (also
  used by the picking scan session).
- `components/put-away/PutAwayLotsPanel.vue` — expected items and scan
  staging.
- `components/put-away/ShelfBoxesPanel.vue` — shelf boxes and scan
  assignment; "Scan box" button, active-box highlight + "Set active" switch.
- `components/put-away/ScanBoxDialog.vue` — scanned/typed box id + shelf
  selection for scan-to-create-box.
- `components/SelectShelfDialog.vue` — shelf selection UI.
- `composables/useScanMatchers.ts` — client-side `matchPutAway` validation;
  apply calls `WarehouseService.recordPutAwayScan` (with `shelfBoxId` when an
  active box is set).
- `services/adapters/backendWarehouse.ts` — put-away + shelf-box methods.
- `apps/backend/src/routes/putaway.ts` + `apps/backend/src/db/putaway.ts` —
  `GET /put-away/candidates`, `GET /receiving-orders/:id/put-away`,
  `POST /receiving-orders/:id/put-away-scans` (optional `shelfBoxId` =
  scan straight into a box), `DELETE
  /put-away-scans/:scanId`, `/shelf-boxes*` lifecycle (lot materialization
  + receiving-order auto-clear; `POST /shelf-boxes` takes an optional `boxId`
  for scanned physical boxes).
- `apps/backend/src/db/putawaytasks.ts` — task mode: `createPutAwayTaskTx`
  (called from `confirmReceivingArrival` when `autoCreateTasks` is on),
  `completePutAwayTaskTx` (called from `tryMarkReceivingOrderClear`),
  `listPutAwayTasks`, `getPutAwayTaskDetail` (+ shelf suggestion).

## Known limitations

- Shelf selection is manual; no validation of shelf capacity or restrictions.
- Scanned pieces are tracked per receiving invoice item. The app does not
  support splitting a single scanned piece across multiple boxes.
- Put-away scans do not yet dedup by serial (the `receiving_scan_labels`
  table built for receiving-scan dedup can be reused for this later).

## Related specs/plans

- `docs/backend/api-design.md` §Put-away
- `docs/superpowers/specs/2026-08-10-put-away-tasks-design.md`
- `docs/superpowers/specs/2026-08-12-put-away-shelf-org-suggestion-design.md`
- `docs/superpowers/specs/2026-08-10-flow-config-design.md`
- `docs/superpowers/specs/2026-07-03-cancel-empty-box-design.md`
- `docs/superpowers/specs/2026-07-06-put-away-scan-first-design.md`
- `docs/superpowers/plans/2026-07-06-put-away-scan-first.md`
- `docs/superpowers/specs/2026-07-20-put-away-scan-box-design.md`
