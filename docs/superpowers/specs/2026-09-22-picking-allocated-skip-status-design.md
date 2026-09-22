# Picking order `allocated` + `skip` statuses — design

Date: 2026-09-22
Status: approved (user Q&A 2026-09-22)

## Problem

Today every `pending`/`picking` picking order participates in every
`allocateAll` wipe/rebuild cycle (`loadDemands`, `apps/backend/src/db/allocate.ts`).
There is no way for an operator to say "this order's allocation is final —
stop touching it" or "never allocate this order".

## New status flow

```
pending → allocated → picking → finished → shipped
   ↘ skip (side state, admin-only)   issue (side state, from allocated/picking/pending)
```

- `allocated` — an admin has confirmed the order's current allocations. The
  allocation engine must **never** wipe/rebuild the order's rows again; they
  are locked for this order. Partial allocations may be confirmed as-is
  (freeze-what's-there; the engine stops topping up).
- `skip` — the order is never considered allocatable; the record is kept for
  reference only. Entering `skip` releases all its allocations. Reversible via
  the admin status override (with reason) back to `pending`, which re-enters
  allocation on the next cycle.

Transition to `allocated` is **manual only** (admin console status override,
single + batch). No auto-transition when fully allocated.

`allocated` vs the existing `allocation_status` column (`unallocated | partial
| allocated`): the order **status** `allocated` is an operator decision (lock);
`allocation_status` remains the engine-maintained coverage summary. Both exist
independently.

## Engine semantics

`loadDemands` already selects only `status IN ('pending','picking')`, and both
wipe/rebuild cores (`allocateAll`, `runScopedAllocation`) derive their wipe set
from the loaded demands — so `allocated` and `skip` orders are excluded from
auto-allocation **by construction**, with zero changes to the wipe logic.
Their allocation rows (auto, manual pins, perfect-match pins) survive every
cycle, and stock/dock availability keeps netting those rows out as today.

Changes:

1. `PICKING_ORDER_STATUSES` (`src/db/picking.ts`) gains `"allocated"`, `"skip"`.
2. `overridePickingOrderStatus` (`src/db/picking.ts`): today it releases ALL
   allocations (incl. manual pins) whenever the previous status is in
   `OPEN_PICKING_STATUSES = {pending, picking}` — unconditionally, even for
   `pending → picking`. Replace with a holding-set rule:
   - `ALLOCATION_HOLDING_STATUSES = {pending, picking, allocated}`.
   - Release allocations only when leaving a holding status **for a
     non-holding one** (`skip`, `issue`, `finished`, `shipped`).
   - `pending → allocated` and `allocated → picking` therefore preserve rows
     (the lock is the point). `pending → picking` via override also stops
     wiping+rebuilding — an intentional behavior fix; the post-override
     `scheduleAllocateAll` still reconciles.
3. `refreshAllocationStatus` (`allocate.ts`): extend its
   `status IN ('pending','picking')` filter to include `'allocated'` so the
   coverage badge stays truthful when an admin removes a row from a locked
   order.
4. `allocateForPickingOrder` (admin Re-allocate, `allocate.ts`): accept
   `allocated` orders (still 404 unknown / 409 `lock_held`) as the repair path
   for stale locks. Because the scoped core's demands come from
   `loadDemands` (which excludes `allocated`), `loadDemands` gains an
   `includeOrderId` option that force-includes that one order as a demand
   (work-lock guard still applied by the caller).

## PDA flow entry points

An `allocated` order must be workable end-to-end:

- `acquireWorkLock` (`picking.ts`): accept `allocated` (currently 409
  `picking_order_not_open` unless pending/picking).
- Pick scan (`scanPickingItem`): first scan moves `allocated → picking`
  (today only `pending → picking`), with the transition log `fromState`
  reflecting the real prior status.
- Barcode lookup `scanPickingItemByBarcode`: include `allocated` orders.
- Suggested box on the detail page: include `allocated`.
- Issue reporting (`reportPickingIssues`): reportable from `allocated`
  (picker finds a problem before starting). Reporting keeps the locked rows
  (same as today's behavior for pending/picking — issue just stamps the
  order); `resolvePickingOrderIssue` still resets to `pending`, which
  deliberately returns the order to the allocatable pool (admin then
  re-confirms to `allocated`). This is the unlock escape hatch.

## PDA list visibility

The PDA picking list shows only `allocated`, `picking`, `finished` (no
`pending`, `skip`, `issue`, `shipped`). Implemented client-side: default
status filter in `pages/picking/index.vue` and the option list in
`components/picking/PickingFilterModal.vue`. The backend `GET
/picking-orders` is unchanged (admin keeps full visibility).

## Admin console

- Status option lists (`pages/picking-orders/index.vue`,
  `components/picking-orders/StatusOverrideModal.vue`) gain `allocated`,
  `skip` — single + batch override already exists and logs `reason`.
- `allocated`/`skip` get `status.picking.*` i18n labels (en-US, zh-CN, zh-HK).
- No new endpoints; the existing any→any override covers every transition.

## Edge cases

- `pending → allocated` with zero allocations is allowed (degenerate freeze);
  `allocation_status` stays `unallocated` and the order is PDA-visible.
- Admin `removePickingAllocation` keeps working on `allocated` orders (no
  status check today) — rows removed this way are NOT auto-replaced; the
  repair path is admin Re-allocate.
- `allocated` orders hold no work lock by default; the engine's work-lock
  skip is irrelevant to them (they are not in `loadDemands` at all).
- Receiving confirm-arrival (`allocateForReceivingOrder`) and perfect-match
  pre-pass never touch locked rows (demand-scoped wipe).
- Badge: the shared `useStatusBadge` map already styles `"allocated"`
  (green). Left as-is.

## Tests

Backend (`apps/backend`):

- override `pending → allocated` preserves rows; a later `allocateAll` leaves
  them byte-identical.
- `allocateAll` never creates rows for `skip` orders.
- override `allocated → skip` releases all rows (`status override: release`
  ledger) and frees the lots; `skip → pending` + `allocateAll` re-allocates.
- `acquireWorkLock` succeeds on `allocated`; first scan moves
  `allocated → picking`.
- `allocateForPickingOrder` on an `allocated` order rebuilds that order
  (409 `lock_held` still honored).

## Docs to update

`docs/backend/api-design.md`, `docs/backend/schema-tables.md` (status enum
comment), `docs/app-docs/flows/picking/*` (overview/steps/ai-scope),
`AGENTS.md` (allocation section).
