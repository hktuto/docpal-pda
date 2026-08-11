# Box-scoped measuring & verify (cross-order packing, per-box shipping) — design

Date: 2026-08-11
Status: approved, implementing
Supersedes the order-scoped parts of:
`2026-07-28-verify-step-and-flow-step-config-design.md`,
`2026-07-28-measuring-verify-refinements-design.md`.

## Problem

`measuring_tasks` and `verify_tasks` are keyed on `picking_order_id` (one task per order,
unique index). That assumes one order ↔ one shipment unit. The warehouse reality: one
shipping box can hold items from several picking orders, so measuring/verify/shipping must
follow the **box**, not the order.

## Decisions

1. **Tasks bind to the shipping box.**
   - `measuring_tasks` is **dropped**. Closing a box already requires non-empty contents,
     every package `verified`, destination, box size and positive weights (gross ≥ net) —
     closing *is* the measuring completion (one step). No pending measuring task exists.
   - `verify_tasks` is re-keyed: `shipping_box_id` NOT NULL FK → `shipping_boxes(id)`,
     UNIQUE (one verify task per box). It stays a real pending/completed task.
2. **Cross-order packing.** A shipping box accepts packages from any open picking order:
   - `addPackageToBox` no longer rejects other orders' unboxed packages.
   - New `POST /shipping-boxes/:id/scan`: resolve a scanned barcode to an open picking item
     + allocation across **all** orders and pick it straight into the box (package created
     with `shipping_box_id` set) — `scanPickingItem` gains an optional `shippingBoxId`.
   - `shipping_boxes.picking_order_id` stays as the informational "created for" order only.
3. **Per-box shipping.** The admin shipping feed lists closed, unshipped boxes (gated on a
   completed verify task when the verify step is enabled — "measured" ≡ closed). Shipping
   stamps the box (`shipped_at`/`shipped_by`). A picking order derives `shipped` when all
   its items are boxed, no package is unboxed, and every box holding its packages is
   shipped. Ship event renamed to `shipping_box.shipped`
   (topics `/shipping-orders`, `/picking-orders`).

## Flow

- **Pack**: create box from any order page (creator order recorded); add this order's
  packages as today, or scan any order's item into the box.
- **Measure** (step on): measuring page lists open boxes that contain packages → scan each
  package (`verified`) → enter measurements → close box. Close spawns the box's pending
  verify task when the verify step is on (idempotent `ON CONFLICT DO NOTHING`).
- **Verify** (step on): verify page lists boxes with pending verify tasks → re-scan every
  package (`verify_verified`) → complete (box must be closed). Reopen is box-scoped:
  requires the box's pending verify task, resets both flags, task stays pending.
- **Ship** (admin): feed = closed unshipped boxes (+ completed verify when enabled) → ship
  box → derive order `shipped`.

Order auto-finish (`maybeAutoFinishPickingOrder`) no longer creates any task; explicit
`finishPickingOrder` just flips the order to `finished`.

## Schema delta

- DROP TABLE `measuring_tasks`.
- `verify_tasks`: `picking_order_id` → `shipping_box_id` (FK cascade, UNIQUE index
  `idx_verify_tasks_shipping_box`).
- `shipping_boxes`: − `measuring_task_id` (dead column), + `shipped_at`, + `shipped_by`
  FK → `users(id)`.
- Migration deletes existing `verify_tasks` rows (ephemeral demo data).

## API delta

- Deleted: `GET /measuring-tasks*`, `POST /measuring-tasks/:id/complete`.
- Added: `GET /measuring-boxes`, `GET /measuring-boxes/:id` (box + packages +
  `suggestedNetWeightKg`), `POST /shipping-boxes/:id/scan`.
- Changed: `/verify-tasks*` payloads keyed by box (`shippingBoxId`, `orderNos[]`);
  `POST /picking-orders/:id/finish` returns `{id, status}` only;
  `GET /shipping-orders` returns box rows; `GET /shipping-orders/:boxId`;
  `POST /shipping-orders/:boxId/ship`.
- Errors: `no_matching_picking_item` (404), `ambiguous_picking_item` (409),
  `box_not_ready_to_ship` (409); `different_picking_orders` and `measuring_task_exists`
  removed.

## Out of scope

- `claimShelfBox` stays order-scoped; `addAllUnboxedToShippingBox` stays scoped to the
  box's creator order.
- No SSE toasts for the measuring/verify lifecycle (unchanged from today).
