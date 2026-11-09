# VMI picking-order Excel upload — design

Date: 2026-11-09 · Status: implemented · Admin function: ADM-025 (picking order list) / new CR-053

## Goal

A second source of picking orders: the operator uploads a `VMI_Template_*.xlsx`
(华为 VMI 出货通知) from the admin picking-order list ("New VMI" button). One
VMI Ref.No = one picking order; its rows become the order's items. After
creation the admin opens the first new order's detail page.

## Sheet contract (fixed tabular layout)

Header row with the columns `VMI Ref.No | Customer Code | Customer Name | Ship
To Address | Customer PO | PO Line | Customer Item | Item | Qty | Sub
Inventory` (matched case/whitespace-insensitively; column order free). Rows
below it are data until the sheet ends. Required headers: VMI Ref.No, Item,
Qty, Sub Inventory — anything else maps to nullable columns.

## Field mapping

| Excel | Target |
|---|---|
| VMI Ref.No | `picking_orders.order_no` (group key, first-seen order) |
| Customer Code | `customer_code` (sheet's Customer Name is dropped — re-derivable from the code) |
| Ship To Address | `ship_to` |
| Customer PO | `po_no` (first non-blank in the group) |
| Sub Inventory | `sub_inventory_code`; `org_id` resolved client-side via `GET /admin/sub-inventories` (unique name match) |
| Item | `picking_items.part_no` (wcl_item_no form) |
| Qty | `picking_items.qty` (positive integer) |
| PO Line | `picking_items.line_number` |
| Customer Item | `picking_items.additional_data.customerItem` (jsonb passthrough) |

`picking_order_type` is fixed to `'vmi'` by the backend. deliveryDate/priority
defaults (null / 0). Visibility: `pickingOrderOrgFilter` (db/picking.ts) rides
`vmi` on the invoice branch — allowedOrgIds + the caller's exact
(org, sub-inventory) scope pairs; without that branch VMI orders are hidden
from every picking list/detail query.

## Flow (mirrors the CN Excel upload, spec 2026-11-08)

1. `pages/picking-orders/vmi.vue`: file → `XLSX.read` client-side → `utils/vmiExcel.ts`
   parses AOA into per-ref order drafts.
2. Gates before anything is created: parts-master existence for every Item
   (`usePartsBrandCheck` batch), unique Sub Inventory → org_id resolution,
   positive-integer Qty. Any issue → shown, nothing created.
3. Clean upload shows a summary table + "Create N orders" button (irreversible
   bulk stock demand gets one review click; CN auto-creates only because its
   orders are editable drafts).
4. `POST /admin/picking-orders/vmi-create` (`{orders:[…]}`, routes/admin/
   vmiPickingOrder.ts): field validation + batch duplicate-order_no guard
   (409 — re-uploading the same file must not double-reserve stock), all
   orders+items in one tx, then per-order scoped allocation exactly like
   test-create. Unlike test-create there is no `[TEST]` remark — these are
   real orders.
5. Navigate to the first created order's detail page; the list picks the new
   rows up via the normal reload.

## Deliberate limits

- No edit UI: wrong/ambiguous sheets surface as gate issues and fall back to
  the manual create page; upgrade path is a draft table like the CN wizard.
- Group header fields (customer/PO/sub-inventory) come from the group's first
  row; later rows differing in those cells keep the first value.
- Sub Inventory codes spanning several orgs are NOT a blocker: every preview
  row gets an `org · SUBINV` dropdown limited to the orgs that actually have
  the sheet's code, plus one "apply to all orders" picker over every
  (org, sub-inventory) pair (the usual VMI case is one pair for the whole
  file — it pre-selects when the sheet resolves uniformly). A code no org has
  is a hard issue until apply-to-all replaces it (never guess a shipping
  location).
