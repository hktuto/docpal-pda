# Admin cross-order allocation control — design

Date: 2026-10-14
Status: implemented
Related: `2026-09-15-admin-picking-item-actions-design.md`,
`2026-10-12-admin-receiving-reallocate-form-design.md`,
`2026-10-06-admin-availability-dialog-improvements-design.md`

## Problem

When an admin allocates a picking item (or redistributes a receiving
item's stock) and the needed stock is already `allocated` on a lot, the
availability dialogs show only a lot-level aggregate counter
(`allocatedQty`). To free that stock the admin must leave the dialog, find
the other picking order, open it, and remove the allocation there — then
come back and hope the recompute did not hand the freed qty to a third
order by priority.

The mechanics to fix this already exist partially:

- `DELETE /admin/picking-orders/:id/items/:itemId/allocations/:allocationId`
  (`removePickingAllocation`, `apps/backend/src/db/allocate.ts:727`) has no
  order-status restriction, so it can legally remove *another* order's
  allocation.
- The picking allocate-form's override growth already reclaims other
  orders' non-manual allocations on a source (`stealAllocationsOnSource`),
  but invisibly — the admin never sees *which* orders are being taken from.

What is missing is **visibility** (which orders hold a lot's allocations)
and a **durable move** (free the stock *for my order*, not back into the
priority pool).

## Decision

### 1. `GET /admin/part-allocations` — the missing breakdown

`apps/backend/src/routes/admin/partAvailability.ts`, next to the existing
`part-availability` / `part-demand` endpoints. Same part matching as
`part-availability` (exact `part_no = ?`, or `wcl_item_no = ?` when given).

Response — one row per `allocations` row of the part, across **all**
picking orders and statuses:

```jsonc
{ "allocations": [{
    "allocationId", "pickingOrderId", "orderNo", "orderStatus",
    "pickingItemId", "partNo", "wclItemNo",
    "qty", "manual",
    "sourceType": "lot" | "receiving-item" | "receiving-order",
    "inventoryLotId"?, "receivingInvoiceItemId"?, "receivingOrderId"?,
    "orgId", "subInventoryCode",
    "shelfCode"?, "shelfDisplayName"?, "boxId"?,       // lot location (NULL for receiving sources)
    "dateCode"?, "lotCode"?,                           // lot / receiving item date codes
    "locked", "workingByName"                          // live PDA work lock on the holding order
}] }
```

`locked`/`workingByName` reuse the work-lock rule from `part-demand`
(`working_by` set and `working_at` unexpired).

### 2. `POST /admin/picking-orders/:id/items/:itemId/allocations/transfer`

Moves qty from another order's allocation onto this item as a **manual
pin**, in one transaction. Body:

```jsonc
{ "allocationId": "…", "qty": 50 }   // qty optional, default = full allocation qty
```

`allocationId` identifies the source allocation (its order/item derived
from the row). Validation, all before any write:

| Check | Error code |
| --- | --- |
| order / item exist | 404 `picking_order_not_found` / `picking_item_not_found` |
| allocation exists and belongs to a **different** picking item | 404 `allocation_not_found` / 409 `same_item` |
| source order work lock | 409 `lock_held` (holder info) |
| target order work lock | 409 `lock_held` |
| `qty` positive integer ≤ source allocation qty | 400 `invalid_qty` |
| source location matches the target item's partition (same `locationMatches` rule as the availability `matched` flag: same org + same sub-inventory or share-group sibling) | 409 `location_mismatch` |
| target item capacity: Σ target item's allocations on the same source + qty ≤ item open qty (`qty − picked`) — after netting out a same-source row being amended | 409 `over_allocation` |

Apply, in one `db.transaction`:

1. **Source side** — delete (or shrink, when `qty < allocation.qty`) the
   source allocation row; RESERVE-release `inventory_transactions` row
   (`txn_reason: "admin: transfer out"`, shelf nulled when unknown —
   same rule as all release-side ledger writes); `recomputeLot`;
   `recomputePickingItem`; `transaction_logs` on the source order
   (`action: "allocation_transferred_out"`, before/after qty).
2. **Target side** — amend-or-insert one allocation row on the target
   item for the same source (one picking item + one source = one
   allocation line, same rule as the reallocate/allocate-form specs),
   forced `manual = true`; RESERVE ledger row (`txn_reason: "admin:
   transfer in"`); `recomputePickingItem`; `transaction_logs` on the
   target order (`action: "allocation_transferred_in"`).
3. `allocation.computed` SSE event on `/picking-orders`.

**No `scheduleAllocateAll`** — matching `removePickingAllocation` and the
manual-pin paths: the new row is a manual pin that survives every
wipe/rebuild, and the source item's residual demand is deliberately left
for the next engine run (which is the documented "removal is transient"
behavior freed of its main hazard: the admin's qty is pinned).

Manual source allocations are transferable too — the transfer *is* an
explicit admin decision, and the destination row is a pin either way.

Response: `{ pickingItemId, allocationId, qty }` (`allocationId` = the
target row, new or amended).

### Why a transfer endpoint instead of bare remove + re-allocate

A bare remove returns the qty to the pool; the next `allocateAll` is a
full wipe/rebuild in `priority_seq` order, so a higher-priority order
re-grabs it and the admin's intent is lost (the "removal is transient"
note on `removePickingAllocation`). Transfer pins the qty on the target in
the same commit, so it is durable. The dialogs keep a bare **Remove** as
well (some admins genuinely want to return stock to the pool), with a
hint that the recompute may re-allocate it by priority.

## Admin UI

### Picking availability modal (`apps/admin/components/PartAvailabilityModal.vue`)

The stock table's `allocatedQty` cell becomes an expandable breakdown:
"N (k orders)". Expanding lazily fetches `GET /admin/part-allocations` for
the row's part (cached per part for the dialog session) and lists, per
allocation: order no (link to the order), status badge, qty, 📌 for manual
pins, work-lock holder badge when locked.

Row actions:

- **Transfer to this order** — posts the transfer endpoint; disabled for
  allocations of the current order itself and for locked orders. On
  success the availability rows and the form baseline refresh.
- **Remove** — confirm dialog, then the existing
  `DELETE …/allocations/:allocationId` on the holding order; hint that
  the freed qty returns to the pool and the next recompute may
  re-allocate it by priority.

### Receiving PartSearchModal (`apps/admin/components/receiving/PartSearchModal.vue`)

The read-only related-stock table gets the same expandable `allocatedQty`
cell. Action: **Remove** only — the receiving dialog's allocate job is
the demand form; there is no single "current picking item" to transfer
onto.

### Explicitly out of scope

Previewing *which* orders the allocate-form's override growth will steal
from before Confirm. The breakdown popover covers the discoverability
need; a steal preview can build on the same endpoint later.

## Tests

`apps/backend/src/routes/admin/allocation.test.ts`:

- `GET /admin/part-allocations` returns the per-order breakdown with
  `manual`, source location, and `locked` flags.
- transfer happy path — full and partial qty; source row deleted/shrunk,
  target row is one manual pin; RESERVE ledger rows on both sides with
  the new txn reasons; audit entries on both orders; `allocation.computed`
  SSE fires; the pin survives a later `allocateAll` (wipe/rebuild).
- 404 unknown order / item / allocation; 409 `same_item` when the
  allocation already belongs to the target item.
- 409 `lock_held` for a live work lock on either the source or the
  target order; nothing changed.
- 400 `invalid_qty` (zero / negative / above the source qty); 409
  `over_allocation` beyond the target item's open qty; 409
  `location_mismatch` for a source outside the item's partition.
- manual-pin source transfers fine and lands as a manual pin.

## Docs

- `docs/backend/api-design.md` — route catalog entries for the two new
  endpoints.
- `docs/app-docs/ai/feature-registry.md` + `ai/code-map.md` — new
  endpoint / modal behavior entries.
