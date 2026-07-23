# Picking order priority + page-locked re-allocation — design

Date: 2026-07-23
Status: draft (reviewed in conversation; admin UI explicitly out of scope — admin console revamp comes later)

## Problem

`allocateAll` (`apps/backend/src/db/allocate.ts`) is a full wipe-and-rebuild over
all open demand:

- Demand order is implicit: `delivery_date NULLS LAST, created_at, item id`
  (`loadDemands`). When stock is short, who gets allocated first is not
  controllable.
- The wipe can reshuffle allocations under a worker who is actively picking an
  order (a recompute triggered by someone else's scan/receipt).

Business wants: picking orders carry an explicit, admin-controllable priority
order; allocation follows that order; an order a user currently has open is not
touched; everything else is wiped and rebuilt.

## Status model (unchanged)

`picking_orders.status` stays a one-way lifecycle — `pending → picking`
(implicit on first applied scan), `→ issue` (report-issues), `→ finished`
(all items boxed). It is progress reporting, NOT the work-lock signal. The
lock lives in separate columns so an abandoned/left order always finds its way
back into the allocation pool (no permanent `picking`-status lock).

## Decisions

### 1. Page-driven work lock (decided)

"User is working" = a user has the picking order open on a PDA.

- New nullable columns on `picking_orders`: `working_by` (FK users),
  `working_at` (timestamp).
- **Acquire/refresh:** `POST /picking-orders/:id/work-lock`.
  - No live lock or same user → sets `working_by` = caller, `working_at` = now
    (idempotent; doubles as the keep-alive refresh).
  - Held by another user and fresh → `409 lock_held` with the holder's id/name;
    the client shows the page read-only with a "held by X" banner.
- **Keep-alive:** the web page re-POSTs every **3 min** while open. A lock is
  **expired** when `working_at` is older than **10 min** — expiry is evaluated
  inside `allocateAll`/acquire (timestamp compare, no cron). App killed,
  crashed, or offline → lock self-heals in ≤ 10 min.
- **Release:** `DELETE /picking-orders/:id/work-lock` — called best-effort on
  page leave (`navigator.sendBeacon`); also auto-cleared when the order goes
  `finished`. Missing the leave event is fine — expiry covers it.
- The picking detail page and the scan-session page both hold the lock for the
  same order (re-acquire is idempotent); navigating between them does not
  release.

### 2. Allocation rule under the lock

On every `allocateAll` run:

- Orders with a **live lock** → skipped entirely (no wipe, no top-up).
- Everything else → **wipe all remaining allocations and rebuild** in priority
  order. "Not in box" stock is exactly what the `allocations` table holds —
  scanned/picked qty lives in `picking_packages` and is never touched.
- Demand qty is `qty − Σ picking_packages (boxed or not)` — **not**
  `qty − picked_qty` (`picked_qty` counts boxed only, so scanned-but-unboxed
  packages would otherwise be double-reserved after the worker leaves and the
  order is rebuilt). This replaces the old `picked_qty = 0` guard: partially
  picked orders now get their remainder re-allocated like any other demand.
- Net-change detection / `allocation.computed` SSE event: unchanged.

### 3. Explicit priority on `picking_orders`

- New column `priority_seq integer` NOT NULL (lower = allocated first).
- Backfill: `row_number() OVER (ORDER BY delivery_date ASC NULLS LAST,
  order_no)` (decision 2026-07-23, revised from created_at; migration 0020
  re-sequenced existing rows).
- Ingest upsert **slots a new order into its delivery-date position**:
  position = count of open orders sorting before its `(delivery_date,
  order_no)` + 1; open orders at-or-after shift down one seq (relative order
  preserved, incl. manual reorders). Updates keep the seq.
- Demand order: `po.priority_seq, pi.id`.

### 4. Reorder endpoint triggers re-allocation

`POST /picking-orders/reorder` (authenticated, actor from token):

- Body `{ orderIds: string[] }` — full ordered list of open orders; seq
  rewritten to 1..n. Unknown/finished ids → 400 `invalid_order_ids`.
- Runs `allocateAll` afterwards; emits `picking.reordered` on topic
  `/picking-orders` even when allocations did not change (list order changed).

### 5. List ordering follows priority

`listPickingOrders` sorts `priority_seq ASC, created_at`. No web list-page
changes otherwise; the detail page gains the lock composable + held-by banner.

## Out of scope

- Admin UI (reorder + force-release land in the admin console revamp; the
  endpoints are the deliverable).
- Lock stealing / force-release by another user.
- Date-code rule interpretation (`parseDateCodeRule` stays unwired).

## Testing

- `allocate.test.ts`: priority beats delivery_date/created_at; locked order's
  allocations survive a recompute; expired lock → wiped/rebuilt; rebuilt order
  with unboxed packages reserves only the remainder (no double reserve);
  partially picked order's remainder is re-allocated.
- Work-lock: acquire idempotent per user, 409 + holder on other user, refresh
  extends `working_at`, release clears, finish auto-clears, expired lock can
  be re-acquired by anyone.
- `ingest.test.ts`: new order gets max+1 seq; re-upsert keeps it.
- Reorder: seq rewrite, 400 on bad ids, allocation follows new order, event
  emitted with no allocation change.
