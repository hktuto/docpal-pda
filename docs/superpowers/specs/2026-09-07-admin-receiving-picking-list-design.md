# Admin receiving detail: confirm in-hand + picking-list download — design

Date: 2026-09-07
Status: implemented

## Problem

The admin receiving-order detail page (`apps/admin/pages/receiving/[id].vue`)
has two gaps:

1. Arrival confirmation (pending → `in_hand`) is only possible from the PDA.
   Admins need the same action in the console when they confirm a shipment on
   behalf of the floor.
2. The 下載揀貨清單 button is a disabled placeholder. Warehouse staff need a
   printable picking list per receiving order, laid out like the supplier's
   shipper workbook (`66232-01,3,4,5 (shipper).xls`): receipts grouped by
   part, each receipt a 3-row block with per-row customer/order slots.

## Decisions

- **Confirm in-hand reuses the existing route.** `POST
  /receiving-orders/:id/confirm-arrival` (`src/routes/receiving.ts:312`) is
  JWT-gated only and already accepts `pending` and `provisional_received`; the
  admin console calls it directly (same as the mismatch confirm/cancel
  routes). No backend change. The button renders only while
  `status ∈ {pending, provisional_received}` and asks via `window.confirm`.

- **The picking list is a backend-generated `.xlsx`** — `GET
  /admin/receiving-orders/:id/picking-list` (new
  `src/routes/admin/receivingPickingList.ts`, registered in
  `src/routes/admin/index.ts`). Generating server-side keeps the allocation
  SQL next to the data and the admin client to a blob download (pattern:
  `appDownload.ts` / `app-download.vue`). Uses the `xlsx` package (already a
  root dev dependency for the seed scripts, added to the backend).

- **Layout follows the shipper example** (its rows 60–62): allocation columns
  are **per-row slots**, not a global column per picking order (each receipt's
  order set differs — global columns would sprawl). Every receipt prints as a
  **3-row block**:
  1. customer name per slot (`customer_profiles.label`, fallback
     `customer_code`, else `order_no`),
  2. **recommended put-away shelf one row above the part name** (same ranking
     as the put-away task detail — `computeItemShelfSuggestions` in
     `src/db/putaway.ts`; blank when the receipt is already fully allocated,
     and off when `putAway.suggestShelf="off"`) + the slot orders' `order_no`
     (fallback `po_no`),
  3. the item row: **`invoice_no` + `ctn_no`** (e.g. `66291-02 08040`, like
     the shipper's combined `單尾號 C/N`) | part (`wcl_item_no`, fallback
     `part_no`) | received qty | per-slot allocated qty.
  "Fully allocated" for a no-`ctn_no` receipt counts its FIFO share of the
  part group's whole-order allocations (those aren't pinned to a line).
  Slots within a row are ordered by `priority_seq`, then `order_no`; the
  sheet-wide slot count is the widest row's allocation count. Leading columns:
  `Invoice / Ctn` | `Part Number` | `Qty` | `Total Qty`; trailing `Balance`
  column. Rows grouped by part, one blank row between groups.
  - Title block: `Picking List — {batchNo}` (+ supplier name), `Date:`,
    `Total Ctn:` (= `SUM(receiving_invoices.total_ctn)`).
  - `Total Qty` (group received sum) and `Balance` (group received − group
    allocated, item-level + order-level) on the group's closing item row
    (mirrors the shipper's Balance).

- **Order-level allocations get their own block.** A receiving line with
  `ctn_no` allocates down to the item; a line WITHOUT `ctn_no` allocates to
  the whole receiving order (`allocations.receiving_order_id` —
  `allocate.ts:53-55`). Those can't be pinned to a carton row, so each part
  group ends with an `(order-level)` 3-row block when such allocations exist,
  carrying the per-slot qtys. The Balance column subtracts both kinds.

- **Allocation source is the live `allocations` table** (not
  `picking_packages`): the list reflects the current recompute. Fully picked
  items whose allocations were already consumed drop out — acceptable for a
  pick-time document; the on-screen picking section keeps the full picture.

- Plain `aoa_to_sheet` output, no styling (SheetJS community edition).
  Filename `picking-list-{batchNo}.xlsx`.

## Endpoints / UI

- `GET /admin/receiving-orders/:id/picking-list` → xlsx attachment; 404
  `receiving_order_not_found`.
- `apps/admin/pages/receiving/[id].vue`: confirm in-hand button + enabled
  下載揀貨清單 button (fetch blob with the `admin_token` Bearer header, save
  via object URL).
- i18n keys under `admin.pages.receiving`: `confirmInHand`,
  `confirmInHandConfirm`, `pickingListError` (`downloadPickingList` exists).
