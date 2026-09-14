# Admin manual allocation triggers — design

Date: 2026-09-14
Status: implemented

## Goal

Give the admin console two manual allocation controls:

1. **Allocate all** on the picking-order list page — run the full-fleet
   idempotent recompute (`allocateAll`) on demand.
2. **Re-allocate** on the picking-order detail page — recompute only the part
   keys of that one order (same wipe/rebuild core as
   `allocateForReceivingOrder`, scoped differently).

Both are operator recovery tools: the background runner normally converges
allocations on its own, but an admin may want to force a recompute after
upstream data fixes without waiting for a mutation to trigger it.

## Backend

### `src/db/allocate.ts`

- `runScopedAllocation(tx, partKeys, scope, startedAt)` — extracted from
  `allocateForReceivingOrder`; the shared wipe/rebuild core over a set of part
  keys inside a caller's transaction. `scope` is recorded on the allocation
  summary/log (`{scope: "receiving-order", receivingOrderId}` or
  `{scope: "picking-order", pickingOrderId}`).
- `allocateForReceivingOrder(db, receivingOrderId)` — unchanged behavior, now a
  thin wrapper over `runScopedAllocation`.
- `allocateForPickingOrder(db, pickingOrderId)` — new. Guards run **before**
  opening the transaction:
  - 404 `picking_order_not_found` for an unknown id.
  - 409 `order_not_open` unless the order is `pending`/`picking` (finished /
    cancelled orders are not re-allocated).
  - 409 `lock_held` with a JSON body `{error, holderId, holderName}` when a
    live PDA work lock is held — mirrors the picking mutation guard so the UI
    can show who holds the lock.

  Part keys = the order's `picking_items.part_no`. Because allocation is
  per-part and parts never compete, scoping to these keys provably leaves all
  other orders' allocations untouched — except sibling orders that share a part
  (same behavior as the receiving-scoped recompute).

### Routes (`src/routes/admin/allocation.ts`)

| Endpoint | Description |
|---|---|
| `POST /admin/allocation/run` | Awaits `allocateAll(db)` and returns its summary `{demands, fullyAllocated, partiallyAllocated, allocationsCreated, allocationsRemoved, skippedReceivingSources, changed, durationMs}`. Unlike mutation routes this deliberately blocks the request — the admin clicked to wait for a result. |
| `POST /admin/picking-orders/:id/reallocate` | Awaits `allocateForPickingOrder(db, id)`; 200 → `{allocation}` (scoped summary incl. `partKeys`), 404 / 409 as above. |

## Admin UI

- `utils/flowApi.ts`: `AllocateAllSummary` type, `allocateAll()`,
  `reallocatePickingOrder(id)`.
- List page `pages/picking-orders/index.vue`: "Allocate all" button in the
  toolbar. Confirmation dialog; on success a dismissible banner shows the
  recompute duration; auto-hides after 8 s.
- Detail page `pages/picking-orders/[id].vue`: "Re-allocate" button, visible
  only while the order is `pending`/`picking`. Confirmation dialog; on
  `lock_held` the JSON body is parsed and the error names the lock holder. On
  success the detail and transition logs reload.

i18n keys under `admin.pages.pickingOrders` (en-US / zh-CN / zh-HK):
`allocateAll`, `allocateAllConfirm`, `reallocate`, `reallocateConfirm`,
`allocationDoneIn`, `reallocateLocked`.

## Non-goals

- No PDA-side trigger; this is an admin-console tool only.
- No partial (single-item) re-allocate — the scope is the order's whole part
  set, matching the confirm-arrival precedent.

## Tests

`src/routes/admin/allocation.test.ts` — 404 unknown order; scoped rebuild
moves same-part sibling orders and provably leaves other parts' allocation
rows untouched; 409 `lock_held` with holder info; 409 `order_not_open` for a
finished order; allocate-all returns a summary and rebuilds allocations.
Seeding uses `src/db/test-fixtures.ts` direct inserts (the ingest apply layer
was retired) + `confirmReceivingArrival`.
