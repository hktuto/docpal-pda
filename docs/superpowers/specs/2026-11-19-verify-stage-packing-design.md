# Verify-Stage Packing ("no box at picking") — Design

Date: 2026-11-19
Status: draft

## Problem

Today the picking operator must decide box assignment while picking: every
scan creates a `picking_packages` row and the operator packs it into a
shipping box on the unified picking page ("Choose box", "Box each unboxed",
scan-into-box, per-box cards). Finish picking expects lines picked **and
packed**.

Requested alternative: let the operator pick without choosing any box, and
pack at the verify stage instead — the verify operator re-scans items
continuously, and when the current box is full taps a **New box** button to
start the next shipping box.

## Current architecture (what we are changing)

- `verify_tasks` is strictly box-keyed: `shipping_box_id NOT NULL`, one task
  per box (unique index), spawned by `closeShippingBox` (measuring on) or
  `finishPickingOrder` (measuring off, verify on).
- Boxes exist before verify; verify re-scans one box's packages and its
  completion closes the box (`completeVerifyTask`).
- Carton/item label verification (`label_verified`, `carton_label_verified`,
  `label_prints` matching) happens inside the box-scoped verify pass.
- The labeling stage gate (`picking_orders.labeling_pending`) and the
  label-printing stage sit between picking finish and the verify spawn.
- Flow steps today: `labeling`, `measuring`, `verify` in `warehouse_config`
  `"flow"` (`apps/backend/src/config.ts`).

## Design

### Config knob

New flow-config top-level key:

```
"packingStage": "picking" | "verify"   // default "picking" (today's behaviour)
```

`"verify"` = pick-time boxing is hidden; packing happens during the verify
session. All existing warehouses default to `"picking"` and are unaffected.
Editable via `GET/PUT /admin/flow-config`; `FLOW_CONFIG` env override wins.

### Picking in verify-packing mode

- The unified picking page hides the boxes section and all box operations
  (choose box, box each unboxed, scan-into-box, close, move out, pick-from-box
  dialog remains — that reads *shelf* boxes, unrelated).
- `finishPickingOrder` guard relaxes: all `picking_items.picked_qty >= qty`
  is enough; packages with `shipping_box_id IS NULL` are not an error. The
  order reaches `picking_finished` with all packages unboxed.
- Labeling / label-printing stages behave as today (they are per order, not
  per box). Item labels print before packing — unchanged.

### Verify task becomes order-or-box keyed

Schema (one migration):

- `verify_tasks.shipping_box_id` → nullable.
- New `verify_tasks.picking_order_id text FK → picking_orders(id)` nullable.
- Replace the unique box index with two partial unique indexes:
  - one pending task per box (`WHERE shipping_box_id IS NOT NULL`),
  - one task per order in verify-packing mode (`WHERE picking_order_id IS NOT NULL`).
- Exactly one of the two keys is set per row.

`finishPickingOrder` (packingStage=verify, verify step enabled, measuring
step disabled): after clearing the labeling gate, spawn a pending
**order-keyed** verify task instead of box tasks.

### The verify packing session (order-keyed task)

New API shape (routes under `POST /verify-tasks/:id/...`):

- `GET /verify-tasks/:id` — extended detail: the order's packages grouped per
  part/batch (same aggregate display groups as today, `verifyDisplayGroups`),
  plus the **current box** (open box of this session) and the boxes already
  packed in the session.
- Scan credit: `POST /packages/:id/verify` gains an optional `boxId`. In an
  order-keyed session the first credit of a package stamps
  `picking_packages.shipping_box_id = boxId`; credits require `boxId` when
  the session has a current box. Aggregate FIFO partial credits and the
  label-mode rules (label scan first, server-side batch compare) are reused
  unchanged.
- **`POST /verify-tasks/:id/boxes`** — create the next box:
  server-generated `BOX-S-…` box with `picking_order_id` = the session order,
  `status open`. Becomes the session's current box. Guard: reject when the
  current box holds a partially-credited package (see "Package integrity"
  below) — 409 `partial_package_in_current_box`.
- `POST /verify-tasks/:id/close-box` — closes the current box early (optional
  "this box is done, start a new one without filling it"); runs the per-box
  guards (labels/carton/weights per step config) against just this box.
- `POST /verify-tasks/:id/complete` — allowed only when every package has
  `rescanned_qty >= qty`; closes the current box and every box of the
  session, then marks the task completed. Replaces the box-keyed completion
  path for order-keyed tasks. Guards mirror `completeVerifyTask`
  (`packages_not_all_rescanned`, `labels_not_all_verified`) aggregated over
  the session's boxes.

Package integrity rule: a `picking_packages` row has a single
`shipping_box_id`, so a package may not straddle two boxes. v1 keeps it
simple: **New box is refused while the current box contains a package with
`0 < rescanned_qty < qty`**; the operator finishes crediting that package
first. (A later iteration could split packages, but the split rows would
complicate the aggregate FIFO credit model for little operator value.)

### Measuring interplay

- `measuring` step disabled (the target configuration): weights/box size are
  optional on `close-box`/`complete`, same as the measuring-off box close
  today.
- `measuring` step enabled + packingStage=verify: weights/box size are
  entered on the verify session per box at close time (the separate
  measuring list is not used for verify-packing orders). This combination is
  supported but secondary; the HK target config is measuring-off.

### Labeling / carton labels

- Item labels: unchanged — printed by the labeling stage before verify; the
  label-mode package verification (scan printed label first, then items)
  works identically because it is keyed on packages, not boxes.
- Carton labels: a box only exists from "New box" onward, so the carton
  label for a box is printed **when the box is closed** (close-box or at
  complete). `carton_label_verified` is scanned right after printing, before
  the box may leave the session — enforced by the existing per-box close
  guards when label rules match the order.

### PDA UI

- `pages/picking/unified/[id].vue`: hide boxes section when
  `packingStage === "verify"`; Finish button enabled on all-picked.
- Verify flow gets a packing session page (new `pages/verify/pack/[id].vue`
  or rework of the existing verify detail): running item totals, current box
  card, **New box** and **Close box** buttons, per-box packed history,
  complete button. Reuses `MeasureBox.vue`-style sections and
  `useScanMatchers` aggregate matching.
- Verify list: order-keyed tasks show order no + progress instead of box id
  (`PDA_VIEW` verify template gains order-keyed rendering).

### Admin

- Admin packing/box views: boxes created at verify still appear as usual
  (`shipping_boxes` is the same table); nothing to change except that an
  order can be `picking_finished` with zero boxes for a while.
- Packaging queue (derived from `picking_orders.packaged_at`) — verify-mode
  completion stamps `packaged_at` at session complete. Confirm the packaging
  flow's expectations during implementation.

## Downsides / accepted trade-offs

1. **Schema + API rework** — verify tasks become polymorphic (box or order);
   every consumer of `verify_tasks.shipping_box_id` must handle NULL.
2. **Carton label printing moves later** — printed at box close instead of
   pre-picked packing; operators lose the ability to pre-print carton labels.
3. **Labeling gate ordering unchanged but box-dependent steps shift** —
   anything that assumed "box exists right after picking" (admin views,
   reports on packed qty) sees a delay for verify-mode warehouses.
4. **Package-straddle rule** — an operator must finish a partially-credited
   package before starting a new box (v1 constraint).
5. **Fallback requirement** — warehouses with the verify step disabled cannot
   use packingStage=verify (no packing happens anywhere); the config UI
   should reject that combination.
6. **Cross-order packing** — v1 sessions are single-order; a box belongs to
   one order's session (the existing cross-order pick-time packing remains
   available in picking-stage mode).

## Out of scope

- Splitting a package across boxes.
- Camera/OCR changes, label template changes.
- Reworking the goods-verify or ad-hoc put-away flows.

## References

- Box-scoped verify: `docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`
- Picking box operations: `docs/superpowers/specs/2026-11-01-picking-box-operations-design.md`
- Label-aware verify: `docs/superpowers/specs/2026-10-30-label-source-and-label-verify-design.md`
- Aggregate re-scan: `docs/superpowers/specs/2026-10-03-picking-scan-truth-and-aggregate-verify-design.md`
