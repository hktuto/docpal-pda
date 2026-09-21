# Admin receiving detail: shipper download (rename, re-calc, finished variant) — design

> Note (2026-09-21): the layout/xlsx code described here moved out of the route into `apps/backend/src/export/shipper/` per 2026-09-21-admin-excel-export-renderer-separation-design.md.

Date: 2026-09-14 (updated 2026-09-15: download made read-only; re-allocation moved to a dedicated endpoint + button)
Status: implemented
Supersedes: 2026-09-07-admin-receiving-picking-list-design.md
Amended: 2026-09-16-admin-receiving-shipper-related-allocated-design.md (group header cell: related-order allocated qty replaces the shelf suggestion)

## Problem

The admin receiving-order detail shipper-style xlsx download needed three
changes:

1. Wording: the button/document is the **shipper (出貨單)**, not a "picking
   list".
2. A completed (`clear`) receiving order needs a **finished shipper**: the
   live `allocations` table can't power a post-completion document (picked
   allocations are consumed and drop out), so the same layout must be fed
   from what actually happened.
3. While the order is still `in_hand`, the admin needs a way to
   **re-calculate the order's allocations** — originally this happened
   implicitly on download; it is now an explicit action (see below).

## Decisions

- **One route, two modes.** `GET /admin/receiving-orders/:id/shipper`
  (renamed from `/picking-list`; `src/routes/admin/receivingPickingList.ts`
  renamed to `receivingShipper.ts`). Default = live mode; `?mode=finished`
  = finished mode. All grouping/rendering code is shared; only the
  slot-source queries and the title/file strings branch.

- **The download is read-only (2026-09-15).** The live mode used to await
  `allocateForReceivingOrder(db, id)` in the request before reading
  `allocations`; that recompute moved to a dedicated
  `POST /admin/receiving-orders/:id/reallocate` endpoint so a download
  never mutates state. The shipper now reflects the current `allocations`
  as-is — click Re-allocate first if stale. The reallocate endpoint awaits
  the same scoped wipe/rebuild used by confirm-arrival (scoped to the
  order's part keys, fast, idempotent) and returns `{allocation}` (null
  when it fell back to the background full recompute). 404
  `receiving_order_not_found`; 409 `order_not_in_hand` unless the order has
  arrived (re-allocation is only meaningful once in-hand).

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
  (replaces, not additional). A separate **Re-allocate** button shows for
  `in_hand` orders; it confirms, awaits
  `POST /admin/receiving-orders/:id/reallocate`, reloads, and shows the
  allocation banner (`allocation: null` → wait for `allocation.finished`
  over SSE; 409 `order_not_in_hand` / `lock_held` and 404 get friendly
  errors). The download itself no longer reloads the page — it writes
  nothing. i18n keys: `downloadShipper` / `downloadFinishedShipper` /
  `shipperError` / `reallocate` / `reallocateConfirm` /
  `reallocateNotInHand` / `reallocateNotFound` under
  `admin.pages.receiving` (zh-HK 下載出貨單 / 下載已完成出貨單 / 重新分配).

## Endpoints / UI

- `GET /admin/receiving-orders/:id/shipper` → live shipper xlsx; 404
  `receiving_order_not_found`; read-only (no recompute).
- `GET /admin/receiving-orders/:id/shipper?mode=finished` → finished
  shipper xlsx from `picking_packages` actuals.
- `POST /admin/receiving-orders/:id/reallocate` → awaited scoped recompute;
  `{allocation}` (null on background fallback); 404
  `receiving_order_not_found`, 409 `order_not_in_hand`.
- Tests: `src/routes/admin/receivingShipper.test.ts` (layout, download
  reflects current allocations without recompute, finished-mode actuals
  from both direct and lot-traced packages) and
  `src/routes/admin/allocation.test.ts` (reallocate endpoint).
