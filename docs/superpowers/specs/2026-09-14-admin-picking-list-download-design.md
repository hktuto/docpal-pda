# Admin picking-order detail: picking list download — design

Date: 2026-09-14
Status: implemented (no in-request recompute; placeholder download buttons removed)
Mirrors: 2026-09-14-admin-receiving-shipper-download-design.md

## Problem

Warehouse staff need a printable/downloadable sheet for a picking order
telling them, for each ordered item, **where to get the allocated stock**
(shelf / box / lot) or which receiving order the stock is coming from
(dock pick). The admin picking-order detail page
(`apps/admin/pages/picking-orders/[id].vue`) already shows this data
on screen but has no export, unlike the receiving detail page which has
the shipper xlsx download.

## Decisions

- **One read-only route.** `GET /admin/picking-orders/:id/picking-list`
  returns an xlsx. Unlike the live shipper, it does **not** recompute
  allocations in-request: the picking detail page already has an explicit
  **Reallocate** action (`POST /admin/picking-orders/:id/reallocate`),
  and an in-request recompute would have to fail on `lock_held` /
  `order_not_open`. The sheet reflects the allocations as they currently
  stand — the operator recomputes explicitly first if needed. (The
  receiving shipper recomputes in-request only because its live mode has
  no equivalent admin action.)

- **Data source: the same query shape as `getPickingOrderDetail`**
  (`apps/backend/src/db/picking.ts:778`): order head from
  `picking_orders`, items from `picking_items`, and per-item rows from
  `allocations` left-joined to `inventory_lots` (shelf, box, date code,
  lot, coo/cow, org/sub-inventory) and to `receiving_orders` /
  `receiving_invoice_items` for dock-sourced allocations (no shelf).
  Admin route, so no user-scope filtering.

- **Flat allocation table, one row per allocation.** Easier to print,
  filter and follow at the shelf than the shipper's merged carton-block
  layout, because the question here is "go to location X, take N units",
  not "which carton feeds which customer".

## Endpoint

`GET /admin/picking-orders/:id/picking-list`
(`src/routes/admin/pickingList.ts`, registered in
`src/routes/admin/index.ts` next to `receivingShipper.ts`).

- 404 `picking_order_not_found` for unknown id.
- Response: raw `Response`, `Content-Type:
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
  `Content-Disposition: attachment; filename*=UTF-8''picking-list-{orderNo}.xlsx`,
  `Content-Length`.
- Built with `xlsx` (SheetJS) array-of-arrays, exactly like
  `receivingShipper.ts`: `XLSX.utils.aoa_to_sheet`, numeric cells get
  `z = "#,##0"`, `!cols` widths, `XLSX.write(wb, { type: "buffer", bookType: "xlsx" })`.

## Sheet layout

Title row: `Picking List — {orderNo}`. Then a two-column order-info block
(label / value, one row each):

| Field | Source |
|---|---|
| Order No | `picking_orders.order_no` |
| PO No | `picking_orders.po_no` |
| Customer | `picking_orders.customer_code` |
| Ship To | `picking_orders.ship_to` |
| Org / Sub-Inventory | `org_id` / `sub_inventory_code` (ship-from partition) |
| Status | `picking_orders.status` |
| Allocation Status | `picking_orders.allocation_status` |
| Generated At | server timestamp |

Blank row, then the item/allocation table. Items are ordered by
`picking_items` row order; within an item, allocations are sorted by
`shelf_code` then `box_id` (NULLS LAST) so the sheet reads as a walking
route. A blank separator row appears **between item blocks** (rows within
one item stay contiguous). Columns:

| Column | Content |
|---|---|
| Part Number | `picking_items.part_no` (item columns — Part Number, Item Qty, Allocated Qty, Picked Qty — appear on the item's **first row only**; continuation rows and the UNALLOCATED footer leave them blank) |
| Item Qty | `picking_items.qty` |
| Allocated Qty | `picking_items.allocated_qty` |
| Picked Qty | `picking_items.picked_qty` |
| Source | `Shelf` for lot-sourced rows; `Receiving {batchNo}` for dock-sourced rows (`receiving_invoice_item_id` / `receiving_order_id` → receiving order's `batch_no`) |
| Location (Shelf) | `inventory_lots.shelf_code`; `(dock)` for receiving-sourced rows |
| Box | `inventory_lots.box_id` |
| Date Code | `inventory_lots.date_code` |
| Lot Code | `inventory_lots.lot_code` |
| COO / COW | `inventory_lots.coo` / `inventory_lots.cow` |
| Source Org / Sub-Inv | `inventory_lots.org_id` / `sub_inventory_code` (only relevant when allocation recompute sources cross sub-inventory, e.g. transfer picks) |
| Alloc Qty | `allocations.qty` |

Per-item footer rows:

- If `qty > Σ allocations.qty`: an `UNALLOCATED` row in the Source column
  with the shortfall in Alloc Qty, so the sheet never hides a shortfall.
- If the item has no allocations at all, a single row with the item
  columns filled and Source = `(no allocation)`.

Filename `picking-list-{orderNo}.xlsx`, sheet name `Picking List`.

## Admin UI

`apps/admin/pages/picking-orders/[id].vue`: **remove the
`downloadPackingList` / `downloadTN` placeholder buttons** (and their
handlers/i18n keys) and add a **Download picking list** button in the
head-actions row (next to Reallocate). Reuse the
receiving page's blob-download pattern (`pages/receiving/[id].vue:288`):
raw `fetch` with `Authorization: Bearer ${localStorage.getItem("admin_token")}`,
`res.blob()` → object URL → `<a download>` click → revoke. No page reload
needed afterwards (the route is read-only). i18n keys under
`admin.pages.pickingOrder`: `downloadPickingList` / `pickingListError`
(zh-HK 下載揀貨清單).

## Tests

`src/routes/admin/pickingList.test.ts` next to
`receivingShipper.test.ts`:

- order-info block values;
- one row per lot-sourced allocation with shelf/box/date-code/qty;
- receiving-sourced allocation renders `Receiving {batchNo}` / `(dock)`;
- unallocated shortfall row appears when partially allocated;
- 404 for unknown id.

## Docs to update on implementation

- `docs/backend/api-design.md` — new endpoint entry next to the shipper
  entry (§ around line 123).
- `docs/app-docs` feature-registry / code-map entries per the docs
  maintenance rules.
