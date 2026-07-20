# Picking scan session ("checkout" mode) — design

Date: 2026-07-18
Status: approved (design settled in conversation)

## Problem

Scan-to-pick today requires the worker to pre-select an item/allocation on the
picking order detail page (per-item scan button), and the hardware scanner is
armed on detail pages even when the worker is not scanning. For high-volume
work (many reels against one picking order) this is too many taps and too
error-prone.

## Goals

- One scan entry point per picking order ("Scan" button), no per-item scan buttons.
- A dedicated scan-session page: supermarket-checkout-style table. Worker scans
  QR labels one by one; each valid scan appends a row. No per-scan confirm, no
  review modal.
- Hardware scanner (wedge/broadcast) is only armed inside a scan session —
  not on detail pages.
- An OCR capture button on the session page adds a row from camera OCR too.
- A single **Confirm** applies the whole queued batch, then returns to where
  the session was launched from (picking detail, or the receiving order's
  picking tab).
- Works from both entry points: picking order page and receiving order picking
  tab (same page, same logic).

## Batch semantics (decided: option B)

Scans are queued **locally**; nothing is posted until Confirm.

- Removing a queued row is free (local delete) — this is the undo path.
- Validation happens as early as possible: at scan time, client-side
  (part must match an order item, cumulative qty per allocation must fit,
  duplicate QR raw value in the queue rejected). Server validation still runs
  per row at Confirm time.
- Confirm applies rows sequentially via the existing
  `POST /picking-items/:id/scan` endpoint. A failed row is marked failed with
  its message and stays in the list (removable/retryable); remaining rows
  continue. All-success → success toast → navigate back.
- Route-leave guard: navigating away with unapplied rows asks for confirmation.

## Non-goals / accepted limits

- No server-side picking serial dedup in this iteration (client-side queue
  dedup by raw QR value only). Same physical label scanned in two different
  sessions can still double-pick; the server qty guard is the backstop.
- Lot choice is automatic: first allocation of the matched item with enough
  remaining qty (allocation-engine FIFO order). No manual lot override in
  scan mode.
- Partial reels (qty override) are out of scope for the session page.
- Scanner gating is changed for the picking flow only in this iteration;
  receiving/put-away/goods-verify pages keep their current behavior.

## UX flow

1. Picking order detail (or receiving order picking tab) → tap **Scan**.
2. `/picking/scan/:id` opens: order ref header, per-item progress
   (required / already scanned on server / queued), empty checkout table,
   scanner armed, OCR button.
3. Each QR scan: parse via supplier templates → local validation → row
   appended (part, qty, lot/date/coo/cow, source=qr) + success toast;
   invalid → error toast, no row.
4. Worker can remove any queued row.
5. **Confirm** → rows applied sequentially → all ok: toast + back to origin.
   Partial failure: failed rows stay with error message; applied rows are
   dropped from the queue.

## Implementation outline

- New page `apps/web/pages/picking/scan/[id].vue`.
- New composable `apps/web/composables/usePickingScanQueue.ts` holding the
  queue + validation (unit-testable): `addScan(parsed, raw)`,
  `removeRow(key)`, `perItemProgress`, `applyAll()`.
- Parse path reuses `useLabelScan().parseRawValue` (QR) and
  `captureLabel()` + `parseAndIdentify` (OCR).
- `apps/web/pages/picking/[id].vue`: remove per-item scan flow
  (`openScan`, `scanTarget`, `scanContext`, review modal, `useHardwareScanner`,
  `useLabelScanReview`), add header "Scan" action linking to the session page.
- `apps/web/components/picking/PickingItemsSection.vue`: drop scan
  button/prop/emit.
- `apps/web/components/receiving/ReceivingPickingTab.vue` + its parent: add
  per-picking-order Scan button linking to
  `/picking/scan/:id?from=receiving&ro=<receivingOrderId>`.
- i18n keys under `picking.scanSession.*` in en-US / zh-CN / zh-HK.
- No backend changes.
