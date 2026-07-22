# Put-away scan-box + active-box auto-put — design

Date: 2026-07-20. Status: implemented.

## Problem

On the put-away detail page, creating a shelf box is a manual "New box" flow
that generates a server-side id, and every part scan lands in the staging box
first — the operator must then assign each scan into a box by hand. In the
real warehouse the physical boxes carry pre-printed QR labels, and the
operator wants to scan pieces directly into the box they are filling.

## Design

### 1. Scan a box QR to add a box

- The shelf-boxes panel gains a **Scan box** button that opens a dialog
  showing the scanned box id (editable, so manual entry works as a fallback)
  plus the existing shelf dropdown.
- While the dialog is open, the armed hardware/wedge scanner feeds the box id
  field instead of part matching.
- Confirm calls `POST /shelf-boxes` with an optional `boxId`. The backend
  (`createShelfBox` in `apps/backend/src/db/putaway.ts`):
  - no existing row → creates the box with that id (instead of
    `nextBoxId`'s `BOX-H-<warehouse>-<YYYYMMDD>-<seq>`);
  - existing **open** box of the **same receiving order** → returned
    unchanged (idempotent re-scan; shelf is not moved);
  - any other existing id → 409 `box_id_already_exists`; blank id → 400
    `box_id_required`.

### 2. Active box auto-put

- The created/scanned box becomes the page's **active box** (highlighted
  card + "Active" badge); each open box card has a **Set active** button to
  switch. The active box is cleared when a reload shows it is no longer open.
- While an active box is set, every part scan path — hardware QR scan, OCR
  review-modal apply, multi-item table apply — passes `shelfBoxId` to
  `POST /receiving-orders/:id/put-away-scans`. The backend inserts the
  staging row and immediately runs the existing `assignScanToBoxTx` in the
  same transaction (guards, lot materialization, PUT_AWAY ledger rows, and
  receiving-order auto-clear all reused; a guard failure rolls back the
  staging insert too). The route re-runs `allocateAll` best-effort after such
  commits since stock moved dock → on_hand.
- With no active box, behavior is unchanged (scans go to staging).

### Client threading

- `WarehouseService.recordPutAwayScan` gains an optional trailing
  `shelfBoxId`; `createShelfBox` an optional trailing `boxId`
  (`services/warehouse.ts`, `services/adapters/backendWarehouse.ts`).
- `ScanTaskContext` / `matchPutAway` (`composables/useScanMatchers.ts`) carry
  `shelfBoxId` so the OCR review apply path auto-puts too.
- New `components/put-away/ScanBoxDialog.vue` (modeled on
  `SelectShelfDialog.vue`); `ShelfBoxesPanel.vue` gains the Scan box button,
  active highlight, and Set active button; `pages/put-away/[id].vue` holds
  `activeBoxId` state and wires the scanner branch.

## Non-goals

- No schema change (`shelf_boxes.id` is already a text PK).
- No camera-OCR box scanning; box id entry is hardware/wedge scan or typing.
- Box id reuse does not move the box to a newly chosen shelf.

## Tests

- Backend (`src/db/putaway.test.ts`): createShelfBox with a scanned id
  (custom id, open-same-order reuse, closed/other-order 409, blank 400);
  recordPutAwayScan with `shelfBoxId` (lands in the box with lot + sources +
  put_away_qty + ledger, closed-box/other-order guards roll back the staging
  insert).
- Web (`services/adapters/backendWarehouse.test.ts`): new body fields.
