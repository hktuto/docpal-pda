# Internal transfer — negative-qty order auto-close

Date: 2026-11-17
Status: implemented

## Background

Upstream sync (external service) writes `internal_transfer_orders` /
`internal_transfer_items` directly. Sometimes the ERP sends a transfer order
whose line quantities are **negative** (adjustment / correction rows). Such an
order has no pickable demand, but nothing in the backend ever closed it:

- The allocation engine already skips negative lines
  (`loadTransferDemands` filters `iti.qty > COALESCE(pkg.qty, 0)`), so the
  order sat at `pending` / `unallocated` forever in the admin list.
- `recomputeTransferItem` mislabeled those lines: `picked >= qty` is true for
  `qty <= 0` (0 ≥ −5), so a negative line read as `"picked"`.
- If the upstream sync wrote `status = 'allocated'` directly on a negative
  order, it appeared in the PDA queue with a negative total.

UAT feedback (2026-11-17): "sometimes the qty of an internal-transfer-order
will be negative — if this is the case, just ignore this order and mark status
to done."

## Decision

An order whose lines **all have qty ≤ 0** is auto-closed: status →
`finished` ("done" in the user's words). Mixed orders (some positive lines)
flow normally — only the negative lines are ignored.

- **Scope:** orders in `pending` / `allocated` / `picking` that have at least
  one item line and no line with `qty > 0`. Header-only orders are NOT
  touched — sync may insert the order header before its line rows arrive, and
  closing an empty order would orphan the lines that arrive later.
- **Where:** `refreshTransferAllocationStatus`
  (`internalTransferAllocate.ts`) — the engine-maintenance function that runs
  after every transfer allocation mutation (scoped Re-allocate, manual pin /
  remove). The auto-close runs first; the allocation_status refresh then
  naturally skips the freshly finished orders.
- **Audit:** one `transaction_logs` row per closed order
  (`actor_id NULL`, `metadata {reason: "no_positive_qty"}`). This is a system
  transition, not the admin override — `PATCH .../status` stays deliberately
  narrow at `pending ↔ allocated` and `finished` remains impossible as an
  admin keystroke.
- **Item status fix:** `recomputeTransferItem` marks an item `picked` only
  when `qty > 0 AND picked_qty >= qty`.
- **PDA queue hardening:** `listInternalTransferQueue` only lists
  `allocated/picking/issue` orders that have at least one positive line — belt
  and braces for the window before the first allocation pass runs (covers
  sync writing `allocated` directly).

## Non-goals

- No change to how negative lines are displayed in the admin detail (they
  stay visible for traceability).
- No fleet-wide cron sweep — transfer allocation already runs on admin
  action, and the PDA queue filter covers visibility in the meantime.
