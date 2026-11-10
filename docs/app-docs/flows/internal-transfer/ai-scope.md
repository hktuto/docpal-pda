# Internal Transfer (admin, stage 1) — AI Scope and Remarks

## In scope

- Read-only list + server paging over the upstream-synced
  `internal_transfer_orders` / `internal_transfer_items` tables.
- Per-order Re-allocate (`allocateForInternalTransferOrder`): order-scoped
  wipe/rebuild of `internal_transfer_allocations`, sources restricted to the
  `from_` pair, shelf FIFO then dock FIFO, manual pins survive.
- Delegated picking order assign/clear with org validation
  (`picking_orders.org_id == to_org_id`, open orders only).
- Manual allocation add (availability dialog, any location — admin override)
  and remove, with ledger + counter maintenance.
- Transfer rows visible in `GET /admin/part-allocations` (`demandType`).

## Out of scope

- PDA transfer picking, packages, the finish branches (put-away task / feed
  the linked order) — stage 2.
- Dock pre-passes (PO/perfect-match pinning) in transfer runs.
- Cross-table steal: a picking override-steal never reclaims transfer rows.
- `part-demand` does not list transfer demand.
- Transfer status confirm/override — status stays `pending` in stage 1.

## Key files

- `apps/backend/src/db/internalTransferAllocate.ts` — engine + manual actions.
- `apps/backend/src/db/internalTransfer.ts` — reads, assignment mutation.
- `apps/backend/src/routes/admin/internalTransferOrders.ts` — routes.
- `apps/admin/pages/internal-transfer-orders/index.vue` / `[id].vue` — pages.
- `apps/admin/components/internal-transfer-orders/TransferAllocateModal.vue` — availability pin dialog.

## Remarks

- Shared-pool invariant: every availability path nets BOTH `allocations` and
  `internal_transfer_allocations` (`loadReceivingSources`, `recomputeLot`,
  part-availability dock numbers, picking manual-add cap).
- The orders/items rows are upstream-synced; our writes
  (`picking_order_id`, `allocation_status`, `allocated_qty`) must never be
  clobbered by the sync writer (insert-only).
- `to_sub_inventory_code` is NULL on ~99.7% of synced orders — the org is the
  enforced gate for the picking-order link.
