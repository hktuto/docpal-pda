# Admin receiving detail: shipper download (rename, re-calc, finished variant) — design

Date: 2026-09-14
Status: implemented
Supersedes: 2026-09-07-admin-receiving-picking-list-design.md

## Problem

The admin receiving-order detail shipper-style xlsx download needed three
changes:

1. Wording: the button/document is the **shipper (出貨單)**, not a "picking
   list".
2. A completed (`clear`) receiving order needs a **finished shipper**: the
   live `allocations` table can't power a post-completion document (picked
   allocations are consumed and drop out), so the same layout must be fed
   from what actually happened.
3. While the order is still `in_hand`, clicking download must **re-calculate
   the order's allocations first** — the sheet must never reflect a stale
   recompute.

## Decisions

- **One route, two modes.** `GET /admin/receiving-orders/:id/shipper`
  (renamed from `/picking-list`; `src/routes/admin/receivingPickingList.ts`
  renamed to `receivingShipper.ts`). Default = live mode; `?mode=finished`
  = finished mode. All grouping/rendering code is shared; only the
  slot-source queries and the title/file strings branch.

- **Live mode re-computes in the request.** When the order is `in_hand`,
  the handler awaits `allocateForReceivingOrder(db, id)` (the scoped
  wipe/rebuild already used by confirm-arrival) before reading
  `allocations`. Same await-in-request rationale: scoped to the order's
  part keys, fast, idempotent.

- **Finished mode reads actuals from `picking_packages`.** Slots are
  aggregated per part group per picking order (`SUM(qty)`, same customer /
  order / priority joins as live mode):
  - direct dock picks: `source_type='receiving_invoice_item'` →
    `source_id` ∈ the order's invoice items;
  - put-away picks: `source_type='inventory_lot'` traced via
    `inventory_lot_sources.receiving_invoice_item_id`. A lot maps to ONE
    part key (`MIN` over its sources from this order) so multi-source lots
    never double-count a package; a lot spanning several part keys lands on
    one of them (approximation — lots are single-part in practice).
  Group-level slots feed the existing merged-block slot rendering directly;
  there are no `(order-level)` closing blocks and no shelf suggestions in
  finished mode. Balance = group received − group actually picked (traced).

- **Naming.** Live: title `Shipper — {batchNo}`, sheet `Shipper`, file
  `shipper-{batchNo}.xlsx`. Finished: `Finished Shipper — …`, sheet
  `Finished Shipper`, file `finished-shipper-{batchNo}.xlsx`.

- **Admin UI** (`apps/admin/pages/receiving/[id].vue`): one
  `downloadShipper(finished)` helper (Bearer-token blob fetch). Buttons:
  `in_hand` → "Download shipper"; `clear` → "Download finished shipper"
  (replaces, not additional). After a live download the page reloads and
  bumps the audit-log table (the recompute may have changed allocations /
  written ledger rows). i18n keys renamed: `downloadShipper` /
  `downloadFinishedShipper` / `shipperError` under
  `admin.pages.receiving` (zh-HK 下載出貨單 / 下載已完成出貨單).

## Endpoints / UI

- `GET /admin/receiving-orders/:id/shipper` → live shipper xlsx; 404
  `receiving_order_not_found`; in-request scoped recompute when `in_hand`.
- `GET /admin/receiving-orders/:id/shipper?mode=finished` → finished
  shipper xlsx from `picking_packages` actuals.
- Tests: `src/routes/admin/receivingShipper.test.ts` (layout, in-request
  recompute picks up post-`allocateAll` demand, finished-mode actuals from
  both direct and lot-traced packages).
