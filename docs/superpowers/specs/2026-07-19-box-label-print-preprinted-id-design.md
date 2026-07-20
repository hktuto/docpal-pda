# Box label printing + pre-printed box ids — design

Date: 2026-07-19
Status: approved (settled in conversation)

## Problem

- Shipping boxes get server-generated UUID ids; there is no way to print a box
  label for the physical carton.
- Warehouses often use **pre-printed box labels** — the worker should be able
  to scan the box's QR/barcode and have that id become the shipping box id.

## Design

### 1. Print box label

- Per-box **Print buttons** (picking detail `PickingBoxesSection`, receiving
  picking tab `ReceivingPickingTab`) are **placeholders**: they show a
  "printing will be available later" toast. The real print function will be
  added backend-side later. (An earlier iteration had a `/box-label/:id`
  QR label page — removed as out of scope.)

### 2. Pre-printed box ids

- Backend `createShippingBox` accepts optional `boxId`: trimmed non-empty;
  409 `box_id_exists` when the id is already taken (it is the global PK).
  Route `POST /picking-orders/:id/boxes` passes `body.boxId`.
- `WarehouseService.createShippingBoxForPickingOrder(orderId, boxId?)`.
- Picking detail page arms the hardware scanner: a scan that **matches a
  supplier QR template** is an item QR → toast directing to scan mode; any
  other scan is treated as a box id → creates an open box with that id
  (409 → "box id already exists" toast).
- A "Scan box id" button next to New box covers camera OCR / manual entry
  (browser prompt fallback via `captureLabel`).

## Non-goals

- No box-id format validation (any non-empty scanned string is accepted).
- No print-template designer; single fixed label layout.
- Receiving picking tab keeps auto-id box creation (scan-box is picking
  detail only in this iteration).
