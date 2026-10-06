# Admin part-availability dialog improvements: sort, combined location, allocation override

Date: 2026-10-06
Status: implemented

## Context

The admin picking-order detail's "零件可用量" modal
(`apps/admin/components/PartAvailabilityModal.vue`, backed by
`GET /admin/part-availability`) lists every stock lot and receiving source for a
part so an admin can pin manual allocations. Three UX gaps:

1. The stock table has a fixed SQL order (org/sub-inventory/shelf) — admins
   want to sort by date code or available qty (FIFO-style picking).
2. Lot identity is spread across 貨架 / Date Code / 批次號 columns; admins want
   one combined `shelf - date code - coo - cow` field to eyeball a location.
3. A lot whose `available_qty = 0` (fully allocated) greys out its Allocate
   button, so an admin cannot take stock that the engine assigned to another
   order. They want an explicit override that reclaims the allocation.

## Design

### 1. Sort-by dropdown (client-side)

Both availability modals' stock tables get a sort `<select>`:

- `date-code` (DEFAULT): `dateCode` ascending, empty dateCode last, ties broken
  by `availableQty` descending.
- `available-qty`: `availableQty` descending.
- `shelf`: `shelfCode` ascending.

Rendering order only; the endpoint keeps its deterministic SQL order.

### 2. Combined location column

New column after 箱 in both stock tables: the non-empty parts of
`shelf - dateCode - coo - cow` joined with `" - "`, `—` when all empty.
Backend: the `part-availability` stock SELECT adds `il.coo, il.cow` (both
columns already exist on `inventory_lots` and are selected by
`addManualPickingAllocation`).

### 3. Override an allocated source (picking modal only)

UI: when the entered qty exceeds the row's available qty and the row has
allocated qty, the Allocate button is replaced by 覆寫分配, enabled when
`qty <= min(remaining demand, totalQty)`. Clicking confirms (native confirm)
that allocations from other orders will be removed, then posts
`POST /admin/picking-orders/:id/items/:itemId/allocations` with
`{ qty, inventoryLotId | receivingInvoiceItemId, override: true }`.

Backend (`addManualPickingAllocation` in `apps/backend/src/db/allocate.ts`):

- Input gains `override?: boolean`. Without it, `qty > available` keeps the
  existing 409 `insufficient_available`.
- With it, the shortfall (`qty - available`) is reclaimed from OTHER picking
  items' **non-manual** allocations on the same source
  (`inventory_lot_id` = lot or `receiving_invoice_item_id` = item,
  `picking_item_id != current item`), oldest `created_date` first. Victim rows
  whose picking order holds a live PDA work lock are skipped (not failed).
- Per victim: delete the allocation row, insert an `inventory_transactions`
  RESERVE-release row (`txnReason: "admin: override steal"`,
  `referenceType: "allocation"`, reference the victim allocation id),
  `logTransition` on the VICTIM order (metadata `action: "allocation_stolen"`,
  qty, thief order/item ids), and an `allocation.computed` SSE event on
  `["/picking-orders"]`. Then `recomputeLot` + `recomputePickingItem` for the
  victim item.
- Manual pinned rows (`manual = true`) are NEVER stolen — they are deliberate
  admin decisions. If the shortfall remains after all stealable rows,
  409 `insufficient_available`.
- After stealing, the new manual allocation is created exactly as today
  (manual pin, RESERVE ledger, audit, SSE).

The victim order's demand stays uncovered until the next recompute, matching
the existing admin remove-allocation semantics (deliberate: manual override,
not a persistent exclusion).

The receiving-side modal (`receiving/PartSearchModal.vue`) gets the sort +
combined column on its read-only stock table only; its Allocate action sources
from the receiving item and is out of scope for override.

## Verification

- Backend tests in `src/routes/admin/allocation.test.ts`: steal happy path
  (victim recomputed + ledger + events + new pin), manual-pin refusal (409),
  locked-victim skip (409 on shortfall), part-availability coo/cow in rows.
- `pnpm --filter @warehouse/backend test`, `pnpm --filter @warehouse/backend build`.
