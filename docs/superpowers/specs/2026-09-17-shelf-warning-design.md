# Shelf Warning — Design

Date: 2026-09-17
Status: implemented

## Problem

Some shelves hold stock that is pickable but noteworthy — e.g. OL01–OL08 in the
HK warehouse store outdated items. Allocation may still pick those shelves, but
the operator (and admin) should see a warning wherever an allocation points at
such a shelf.

## Decision: column on `shelves`, not a policy table

A warning is an intrinsic, 1:1 property of a shelf (like `zone` or the advisory
`sub_inventory_scopes` jsonb). A separate policy/rules table would add a join, a
second CRUD screen, and precedence questions for zero current benefit. It only
pays off if we later need pattern-matched rules (`OL*`), org-scoped warnings,
validity windows, or multiple stacked warnings per shelf — migrate then; the
column data ports over trivially.

## Schema

`shelves.warning text NULL` — free text shown to the operator
(e.g. `"Outdated stock — verify before picking"`). NULL/empty = no warning.
Editable through the existing generic admin shelf CRUD
(`PUT/POST /admin/shelves`).

The HK shelf seed (`src/db/seed-shelves-hk.ts`) marks OL01–OL08 as outdated
stock. The allocator is unchanged — the warning is display metadata only;
allocation still picks the shelf.

## Read paths

Both allocation read queries left-join `shelves` on `inventory_lots.shelf_code`
and expose `shelfWarning` on the allocation's `lot` object (null when the
allocation has no lot, the lot has no shelf, or the shelf has no warning):

- `getPickingOrderDetail` (`GET /picking-orders/:id`) — `PickingLotDetail.shelfWarning`.
- `GET /receiving-orders/:id/picking` — allocation `lot.shelfWarning`.

Receiving-source allocations (dock stock, no `inventory_lots` row) never carry a
warning. The embedded allocations in `GET /receiving-orders/:id` are keyed by
`receiving_invoice_item_id` (dock sources) and are therefore out of scope.

## Display

A ⚠ icon next to the shelf code wherever an allocation's shelf is shown;
hover/tap title carries the warning text:

- Web picking detail — `components/picking/PickingItemsSection.vue` location row.
- Web picking scan page — `pages/picking/scan/[id].vue` `allocationSources` hint
  appends ⚠.
- Web receiving detail picking tab — `components/receiving/ReceivingPickingTab.vue`
  allocated-locations list.
- Admin picking order detail — `pages/picking-orders/[id].vue` allocation cell +
  tooltip warning row.

## Admin

`apps/admin/utils/entities.ts` shelves entity gains a `warning` text field
(label `admin.fields.shelfWarning`, all three locales).

## Out of scope / future

- Warning levels/types (info vs warn styling) — free text only for now.
- Scan-time blocking or confirmation prompts — advisory icon only.
- Policy-table migration if pattern/scope/window requirements appear.
