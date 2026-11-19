# Picking Scan Record — one scan = one line — Implementation Plan

Date: 2026-11-19
Spec: `docs/superpowers/specs/2026-11-19-picking-aggregate-scan-record-design.md`

## Phase 1 — schema + order-level scan endpoint

1. Migration: `picking_packages.picking_item_id` → nullable; add NOT NULL
   `picking_part_no text` (backfill from the joined item's part_no in the
   migration); add `over_picked` NOT needed (room check prevents surplus).
2. `apps/backend/src/db/picking.ts`:
   - New `scanPickingOrderReel(db, input)` — order-scoped scan:
     - body: part identity (partNo/wclItemNo decoded) + qty + optional
       shippingBoxId + shelf context + raw barcode + scanned_* fields.
     - Guards (per part, not per line): part must match one of the order's
       open lines (normalized part match); room check
       `sum(scanned qty for part on order) + qty <= sum(open demand for
       part)` → 409 `no_room_for_part` with remaining room in the message
       payload.
     - Portion resolution: reuse the existing allocation→source machinery
       by finding the allocations that cover the scanned qty for that part
       (FIFO by priority_seq), decrement lots / book PICK ledger rows
       per portion, insert ONE package row (picking_item_id NULL,
       picking_part_no set).
   - Route: `POST /picking-orders/:id/scan-reel`.
3. Existing `POST /picking-items/:id/scan` unchanged (backward compat).

## Phase 2 — derived line fulfillment

4. `apps/backend/src/db/picking.ts`:
   - `getPickingOrder` detail: packages list at order level; per item,
     derive consumed qty via FIFO mapping (order packages → item by part,
     capped at item qty); item `picked_qty` display = derived value.
   - `finishPickingOrder`: completion check per part
     `scanned >= demand`; ledger booking unchanged (already per-portion);
     `picking_items.picked_qty` updated from the derived mapping.
   - `shipping_box_items` rollups: derive from package part keys.
5. Verify / measuring / put-back consumers: switch package source from
   item-keyed to order+part-keyed where the code groups by
   `picking_item_id` (verify tasks, measuring, `put_back_task_items`).

## Phase 3 — PDA + admin

6. PDA unified picking page: scan flow targets the order-level endpoint
   when flow-config enables it; qty = the decoded label qty (no
   line-bounded pre-fill); room-check errors surface as toasts.
7. Flow-config knob `pickingScanRecord: "aggregate" | "item"` (default
   `item`); admin picking list shows the flat scan-record list.
8. Scan Excel: iterate order-level packages (one row per scan).

## Phase 4 — tests

- Whole-reel order → 56 scans → 56 rows, finishable, ledger −42,000.
- Room check: demand 500 vs 750 scan → 409 `no_room_for_part`.
- Undo: package delete → ledger reversal.
- Both config modes keep the existing suite green.
