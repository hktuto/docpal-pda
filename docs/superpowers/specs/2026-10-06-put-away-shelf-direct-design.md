# Put-away: shelf-direct flow (no operator-facing boxes) — design

Date: 2026-10-06

Replaces the box-driven put-away operator UX with a direct shelf flow.
Confirmed decisions: (1) **commit rule** — a scan commits to a shelf iff a
shelf is selected; otherwise it waits in a pending list; (2) **no mode
switch**, the box UI does not return; (3) OCR-reviewed scans follow the same
rule as gun scans after the review modal confirms.

## Operator flow

1. Open a receiving order (or put-away task) — unchanged.
2. Scan an item (hardware gun QR or camera OCR with review modal).
3. Scan a shelf code.
4. If pending scans exist, a confirm prompt: "Put N pcs to shelf X?" — confirm
   commits **all** pending scans to that shelf in one transaction; decline
   just selects the shelf.
5. A banner shows the current shelf; × deselects (back to pending mode).
6. With a shelf selected, every subsequent scan commits immediately — no
   extra tap. Pending rows (scans made before the shelf was selected, or
   after deselect) each carry an **Add to shelf** button; pending rows are
   removable (mis-scan correction).

## Architecture: box-less UI, boxes under the hood

The data model is unchanged — every commit still lands in a `shelf_boxes`
row (auto-created, never named or shown) so `inventory_lots`,
`inventory_lot_sources`, the PUT_AWAY ledger, allocation sources, stock
search, and the sync feed keep their exact current shape. What disappears is
the operator surface: no ShelfBoxesPanel, no box dialogs, no active box, no
close/cancel, no per-scan box dropdowns, no staging-box QR concept.

### Backend (`apps/backend/src/db/putaway.ts`, `src/routes/putaway.ts`)

- **`ensureOrderShelfBoxTx(tx, orderId, shelfCode)`** — mirror of
  `ensureStagingBox` for a real shelf: the open box on this shelf holding
  this order's items → reuse; else any empty open box on the shelf → adopt
  (refresh its pair from the order); else create (order pair, open transition
  log with `{order}` metadata so `boxOrderId` resolves while empty).
- **`recordPutAwayScan` gains `shelfCode`** (mutually exclusive with
  `shelfBoxId`, 400 `both_shelf_box_and_shelf_code` when both): resolves the
  box via `ensureOrderShelfBoxTx` and runs the existing assign core in the
  same tx (the current `shelfBoxId` auto-put path, unchanged semantics:
  scan → staging insert → assign → lot materialization + ledger).
  `null`/absent = pending (staging) as today.
- **New `commitPendingScansToShelf(db, {orderId, shelfCode, actorId})`** —
  one tx: resolve the box once, then assign every staging scan of the order
  (optionally filtered by `scanIds`) into it; returns `{count, qty}`.
  `count: 0` is a valid empty result (race with another device), not an
  error. Route: `POST /receiving-orders/:id/put-away-commit`
  `{shelfCode, scanIds?}` → `{count, qty}`; schedules `allocateAll` when
  `count > 0`.
- Existing box endpoints (`/shelf-boxes*`) stay for admin/debug; the PDA
  stops calling them. No auto-close: committed scans keep their reversal
  path (`DELETE /shelf-boxes/:id/scans/:scanId`) and goods-verify is being
  revamped separately anyway.

### PDA (`apps/pda/pages/put-away/[id].vue` + new panel)

- **Removed**: `ShelfBoxesPanel`, `SelectShelfDialog`, `ScanBoxDialog`,
  `activeBoxId`, box-scan handling (a `BOX-*` scan now toasts that boxes are
  not used), add-to-box / remove-from-box / add-all / close / cancel /
  create-box handlers, and the box adapter methods (`createShelfBox`,
  `closeShelfBox`, `cancelShelfBox`, `assignPutAwayScanToBox`,
  `removePutAwayScanFromBox`, `addAllUnboxedScansToBox`).
- **Scan routing (gun)**: `classifyPutAwayScan` shelf branch → select the
  shelf (+ pending-commit prompt when `scans.length > 0`); box branch →
  informational toast; item branch → parse → `recordPutAwayScan(...,
  shelfCode: selectedShelf)` (null when no shelf = pending).
- **New `components/put-away/PutAwayPendingPanel.vue`**: pending scans
  grouped by part (qty summed, batch fields shown), each row with
  **Add to shelf** (enabled when a shelf is selected → `put-away-commit`
  with that single `scanId`) and **Remove** (`DELETE /put-away-scans/:id`).
- **OCR review + multi-item apply**: same commit rule — the review context
  carries `shelfCode` (replaces `shelfBoxId`); `matchPutAway` threads it to
  `recordPutAwayScan`.
- Part-group cards, armed gun-scan mode, FIFO split across same-part lines
  (spec `2026-10-05-put-away-part-grouping-design`) are unchanged; the
  expanded card's scan list now shows pending rows without box dropdowns.
- `PutAwayDetail.boxes`/`stagingBoxId` are no longer consumed by the page
  (API shape unchanged).

## Out of scope

- Moving committed stock between shelves (a reversal + re-commit).
- goods-verify rework (separate feature).
- Physical box labels / `claimShelfBox` picking claim (kept working; boxes
  still exist in the data model, the operator just never sees them).

## Tests

- Backend `src/db/putaway.test.ts`: scan with `shelfCode` materializes the
  lot in one tx; second scan to the same shelf reuses the auto box (single
  box per order+shelf); adopt-empty-box path; 400 on
  `shelfBoxId`+`shelfCode` together; `commitPendingScansToShelf` commits all
  pending (and a `scanIds` subset) in one tx, returns `{count, qty}`, count
  0 on empty.
- PDA: `tests/putAwayScan.test.ts` unchanged (classify untouched); routing
  logic lives in the page (not unit-tested, same as before).

## Files

- `apps/backend/src/db/putaway.ts` — `ensureOrderShelfBoxTx`,
  `shelfCode` on `RecordPutAwayScanInput`, `commitPendingScansToShelf`.
- `apps/backend/src/routes/putaway.ts` — `shelfCode` passthrough,
  `POST /receiving-orders/:id/put-away-commit`.
- `apps/backend/src/db/putaway.test.ts` — new cases.
- `apps/pda/pages/put-away/[id].vue` — scan routing + pending commit prompt.
- `apps/pda/components/put-away/PutAwayPendingPanel.vue` — new.
- `apps/pda/components/put-away/ShelfBoxesPanel.vue`, `ScanBoxDialog.vue` —
  deleted.
- `apps/pda/composables/useScanMatchers.ts` — `shelfCode` in the put-away
  context/matcher.
- `apps/pda/services/warehouse.ts` + `services/adapters/backendWarehouse.ts`
  — `recordPutAwayScan(..., shelfCode)`, box methods removed.
- `layers/i18n/locales/{en-US,zh-CN,zh-HK}.ts` — new putAway strings.
- `docs/backend/api-design.md` — put-away section update.
