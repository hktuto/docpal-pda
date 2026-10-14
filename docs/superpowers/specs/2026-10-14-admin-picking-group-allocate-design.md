# Admin picking group allocate (by part_no) — design

Date: 2026-10-14
Status: implemented
Related: `2026-09-15-admin-picking-item-actions-design.md`,
`2026-10-12-admin-receiving-reallocate-form-design.md`

## Problem

The picking-order detail page has a grouped items view that merges lines sharing the same
item number (`wclItemNo ?? partNo`) into one row with summed qtys. Real orders repeat the
same part on many lines (different line/shipment numbers), and the grouped view is how
admins look at such orders — but it is read-only. To move the group's stock the admin must
switch back to flat mode and open the availability modal line by line, re-entering the same
source split on every line.

## Decision

Make the grouped view's 🔍 availability button open the **same final-state form**, scoped
to the whole part group: each source row states the total the *group* should hold from
that source afterwards, and one Confirm applies it across all member lines in a single
all-or-nothing transaction.

### Group key = `part_no`

The UI groups by `wclItemNo ?? partNo`, but `getPickingOrderDetail`
(`apps/backend/src/db/picking.ts`) joins `parts ON p.wcl_item_no = pi.part_no` and
`parts.wcl_item_no` is UNIQUE, so `wclItemNo === partNo` whenever the join matches. The
backend endpoint therefore keys the group on `picking_items.part_no` and reproduces the UI
grouping exactly. All lines of one order share the order's org/sub-inventory, so there is
no per-line partition ambiguity inside a group.

### Final-state per source, distributed across lines

The modal is unchanged visually — one qty input per stock lot / receiving source. What
changes is the meaning: the input is the **group total** from that source. The backend
turns each source total into per-line allocation rows with a deterministic rule:

- **Grow** (target > current group total from that source): walk the group's items in line
  order (`line_number` nulls-last, then `shipment_number`, then `id`) and fill each item up
  to its remaining headroom — `qty − Σ packages − Σ (final allocations already planned for
  that item in this batch)` — until the delta is placed. Earlier lines fill first.
- **Shrink** (target < current): walk items in **reverse** line order releasing qty, with
  the existing per-item victim rule inside each item (manual pins first, then engine rows,
  oldest first). Earlier lines keep their allocations.
- If a grow cannot be fully placed (group open qty exhausted) the whole form is rejected
  with 409 `over_allocation` carrying the group sums `{openQty, allocated}`.

Per-line application reuses the per-item form's primitives exactly: amend-or-insert one
allocation row per (item, source) forced to `manual = true`, RESERVE ledger rows, the
`shelf_not_found` / `insufficient_available` per-row rejection batch (409
`allocate_rejected`), the work-lock guard (409 `lock_held`), and override-reclaim via
`stealAllocationsOnSource` (which skips the group's own member items and work-locked
orders). The pins are `manual = true`, so the wipe/rebuild cores preserve them.

### Why not a per-line × per-source matrix

A matrix form would be exact but unwieldy (sources × lines inputs) and duplicates what the
flat view already offers. The grouped workflow's value is "cover this part from these
sources" — which line physically holds which qty rarely matters to the admin, and when it
does the flat per-line form is still there.

## API

### `POST /admin/picking-orders/:id/allocate-group`

Body `{partNo, rows: [{inventoryLotId? | receivingInvoiceItemId?, qty, override?}]}` where
each `qty` is the DESIRED FINAL group total from that source (0 releases the group's
holdings from it); sources absent from the body keep their current value.

Validation, all before any write: 400 `invalid_qty` / `source_required` /
`duplicate_source`, 404 `picking_order_not_found` / `picking_item_not_found` (no line with
that part_no) / `inventory_lot_not_found` / `receiving_invoice_item_not_found`, 409
`lock_held` / `over_allocation` (group sums) / `allocate_rejected` (per-row
`l:<lotId>` / `r:<receivingItemId>` keys, reasons `insufficient_available` /
`shelf_not_found`).

Response mirrors the per-item form: `{partNo, itemIds, openQty, allocated, changed}` with
`changed` entries carrying the item id so the audit trail shows the split. One
`transaction_logs` entry (`action: "allocate_group"`, metadata `{partNo, itemIds,
changes}`) and one `allocation.computed` SSE event on `/picking-orders`
(`scope: "picking-order-group"`).

## Admin UI

- `apps/admin/pages/picking-orders/[id].vue` — the 🔍 button renders on group rows too;
  group rows carry their member lines' **unmerged** allocations (`groupAllocations`) so
  the modal's per-source baseline stays exact (the merged display allocations lose the
  lot/receiving-item id mapping).
- `apps/admin/components/PartAvailabilityModal.vue` — new optional `pickingGroup` prop
  (`{partNo, wclItemNo, qty, pickedQty, allocations}` with group sums). When set, the
  headroom/current-baseline math is unchanged (it already works off sums) and Confirm posts
  to `allocate-group` instead of the per-item `allocate-form`. A hint line tells the admin
  the totals apply to all lines of the part.
