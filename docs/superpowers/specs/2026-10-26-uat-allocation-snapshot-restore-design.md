# UAT allocation snapshot and restore design

## Problem

During dev/UAT, upstream deletes and re-seeds inventory each night. The foreign keys on `allocations` cascade those deletes, but upstream does not call the allocation engine or repair `inventory_lots.allocated_qty`, `picking_items.allocated_qty`, and order allocation summaries. Re-seeded source rows can also have new UUIDs.

## Behavior

An opt-in backend job snapshots all picking allocations at `ALLOCATE_BACKUP` (default `17:45:00+0800`) and restores the latest snapshot at `ALLOCATE_RECOVER` (default `08:00:00+0800`), after the upstream refresh. Both use `HH:mm:ss±HHmm`, independent of the server time zone. Admin-only manual endpoints expose the same operations for recovery and verification.

Snapshots are independent of upstream-managed foreign keys. A row preserves the original allocation UUID, quantity, manual flag, picking order/item business keys, and complete source identity. A daily capture replaces only that day's earlier capture.

Restore matches existing IDs first, then stable business keys. Picking items use order ID + upstream line ID, with guarded line-number/part fallbacks. Lots use the full natural-lot key. Receiving lines use batch/invoice/part/PO/PO-line/carton; order-level sources use the receiving order. Missing or ambiguous matches are reported and never guessed.

Only `pending`, `picking`, and `allocated` orders without a live work lock are restored. Restore validates open item qty and source availability and never silently reduces quantity. Conflicting automatic allocations are released with ledger rows; new manual allocations are preserved and reported as conflicts. Existing restored rows are no-ops.

Restored rows reuse the original allocation UUID, making retries idempotent and preventing duplicate reservation ledger entries. After every restore, set-based reconciliation recalculates **all** lot and picking-item allocated counters from current allocation rows, including unrestored rows, then refreshes order allocation statuses.

Restoration runs through the serialized allocation runner. It does not automatically run `allocateAll` afterwards; normal later recomputes retain their existing behavior, including wiping non-manual rows.

## Configuration and operations

- `UAT_ALLOCATION_RECOVERY=on` enables the scheduler; default is off.
- `ALLOCATE_BACKUP=17:45:00+0800` and `ALLOCATE_RECOVER=08:00:00+0800` are the defaults. Override either with `HH:mm:ss±HHmm`; the explicit offset makes scheduling independent of the server time zone.
- No snapshot boot catch-up: starting the backend after upstream cleanup must not overwrite a useful snapshot with an empty one.
- `POST /admin/allocation/snapshot` captures immediately.
- `POST /admin/allocation/restore` restores the latest snapshot immediately.
- Both return summaries; restore persists per-row outcomes on the snapshot batch.

## Scope

This covers picking `allocations`, including stock-lot, receiving-line, and whole-receiving-order sources. It does not change upstream deletion, foreign keys, normal allocation rules, internal-transfer allocations, or the admin UI.
