# Picking order `allocation_status` + terminal `shipped` state

Date: 2026-07-29
Status: implemented

## Problem

Two visibility gaps had piled up at the end of the picking chain:

1. **No order-level allocation visibility.** Allocation was only visible per
   line (`picking_items.allocated_qty`). To answer "is this order fully
   covered by stock?" a client had to fetch the nested detail and sum
   per-item `allocated_qty` against open qty itself — the list page, the
   admin console, and the reorder screen all wanted that answer at a glance,
   and each would have re-derived it (slightly differently) client-side.
2. **No terminal `shipped` state.** The picking order lifecycle ended at
   `finished`; the admin shipping feed (`GET /shipping-orders`) was
   read-only, so an order stayed in the feed forever even after the goods
   physically left. There was no way to mark "this order has shipped" and
   get it out of the outstanding list.

## Decisions

### 1. `picking_orders.allocation_status` — a persisted, recomputed summary

`allocation_status text NOT NULL DEFAULT 'unallocated'` with values
`unallocated | partial | allocated`. It is derived from per-item sums:

- Σ alloc = Σ `picking_items.allocated_qty`
- Σ open = Σ (`qty` − Σ `picking_packages.qty`) (the same open-qty formula
  the allocation engine uses)

then: `allocated` when Σ alloc = Σ open (**including the Σ open = 0
fully-picked edge** — a fully picked order reads `allocated`, not
`unallocated`), `partial` when 0 < Σ alloc < Σ open, else `unallocated`.

**Recompute point: the end of every `allocateAll` transaction.** The engine
already runs (best-effort) after every stock-changing commit — receiving
scan/confirm, put-away assign/remove, pick scan/unpack, goods-verify ADJUST,
issue resolve, reorder, ingest — so folding the status recompute into the
same tx keeps it consistent with the allocation rows it summarizes for
free: no separate scheduler, no drift window, and every writer path is
covered by construction. The recompute only touches `pending`/`picking`
orders; `issue` orders are excluded from allocation and keep their last
value until resolve returns them to `pending`, and `finished`/`shipped`
orders are terminal for allocation purposes. Work-locked orders
(`working_by`/`working_at`) are skipped by the wipe/rebuild but keep their
existing allocation rows, so the recompute still reads correct per-item
sums for them and their status stays accurate. `last_update_date` bumps
only when the value actually changes (plain UPDATEs for unchanged rows
would poison the system-field audit semantics for no benefit).

The status is persisted (not computed in the list query) so list/detail
reads stay cheap and the value is filterable later; the derivation rule is
simple enough that a backfill UPDATE and the in-tx recompute share one
obvious formula.

### 2. `picking_orders.status` gains `shipped` — a pure workflow marker

Status enum becomes `pending | picking | issue | finished | shipped`, plus
nullable `shipped_at timestamp` and `shipped_by text FK → users(id)`.

Stock leaves inventory at **pick-scan time** (the PICK ledger rows), not at
shipping — by the time an order reaches the shipping feed its stock is long
gone. Shipping is therefore deliberately a **pure workflow transition**: no
inventory movement, no allocation changes, just the terminal status stamp.

`POST /shipping-orders/:pickingOrderId/ship` `{actorId}` validates that the
order is actually in the **config-aware shipping feed** — the same rule the
feed itself uses: verify step on → a completed verify task; measuring on →
a completed measuring task; neither → a `finished` order with no task rows.
Anything else (order still pending/picking/issue, task not completed, or
**already shipped**) → 409 `order_not_ready_to_ship`. Reusing the feed
predicate (instead of a parallel "ready" rule) means the ship button and
the feed can never disagree. On success the tx sets
`status = 'shipped'` + `shipped_at`/`shipped_by`, writes a
`transaction_logs` audit row, and emits an SSE event with topics
`/picking-orders` + `/shipping-orders` so both the PDA list and the admin
feed refresh.

Shipped orders are excluded from `GET /shipping-orders` in **all three
source queries** (verify/measuring/picking) — the feed is the outstanding
list — and remain visible via `GET /picking-orders?status=shipped`.

## API changes

- **`GET /picking-orders` list rows** gain `allocationStatus` and
  `allocatedQty` (Σ `allocated_qty` — the numerator behind the status, for
  display).
- **`GET /picking-orders/:id` detail** gains `allocationStatus` on the
  order object.
- **New** `POST /shipping-orders/:pickingOrderId/ship` `{actorId}` → the
  updated order; 409 `order_not_ready_to_ship` when the order is not in the
  config-aware feed (including already-shipped).
- **`GET /picking-orders?status=`** accepts `shipped`.

## Migration

`apps/backend/drizzle/0006_*.sql`:

- Adds `allocation_status text NOT NULL DEFAULT 'unallocated'` to
  `picking_orders`, with a backfill UPDATE computing the correct value for
  existing `pending`/`picking` rows from the same Σ alloc / Σ open formula
  (other statuses keep the default; their next relevant transition or a
  later recompute fixes any stale default — `finished` orders' value is
  display-only).
- Adds nullable `shipped_at timestamp` and
  `shipped_by text FK → users(id)`.

## Out of scope

- Un-ship / reopening a shipped order (the audit row + status are terminal
  for the POC; a reverse transition can be added if a real flow needs it).
- Shipper/carrier document generation off the shipped state (the admin
  download buttons stay placeholders).
- Filtering the picking list by `allocationStatus` server-side (the value
  is exposed; client-side filtering is enough for now).
