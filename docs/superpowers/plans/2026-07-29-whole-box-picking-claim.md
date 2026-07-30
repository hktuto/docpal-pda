# Whole-box (exact-match) picking claim + receiving carton weight/size passthrough

## Decisions (confirmed with user)

- Box size / net / gross weight from upstream stay in `receiving_invoice_items.additional_data` (jsonb, already exists since migration 0005; ingest already passes it through — **no schema change for storage**, only a documented key convention).
- A shelf box qualifies for one-scan claiming only on **exact match**: the box's *current* contents (from `inventory_lots`, not the `shelf_box_items` put-away manifest) per part_no exactly equal the order's full remaining open demand (qty − Σ picking_packages per item).
- On claim the physical carton is **reused as the shipping box**: a shipping box is created prefilled with box size / net / gross weight aggregated from the source receiving lines' `additional_data`.
- The picking detail page **shows a hint** when an exact-match box exists.

## Key facts established during exploration

- Current box contents = `inventory_lots` rows with `box_id = <box>` and `total_qty > 0`. `shelf_box_items` is the put-away manifest, NOT decremented by picks — do not use it for matching.
- Weights trace back: `inventory_lots` → `inventory_lot_sources.receiving_invoice_item_id` → `receiving_invoice_items.additional_data`.
- `recomputePickingItem` sets `picked_qty = Σ BOXED packages` (picking.ts:66) — so the claim tx must create the shipping box and stamp `picking_packages.shipping_box_id` in the same tx, then `maybeAutoFinishPickingOrder` fires the measuring/verify chain automatically.
- Ledger conventions: allocate.ts writes `RESERVE`/`reserved` (+ on reserve, − on release); scanPickingItem writes `PICK` `reserved −qty` + `on_hand −qty` per portion. Claim = release this order's allocations (RESERVE reserved −qty) + PICK on_hand −qty per portion.
- Work-locked orders are skipped by allocateAll, so the claim tx itself must delete the order's leftover allocations and `recomputeLot` the freed lots — cannot rely on self-healing.
- Org/sub-inventory + customer-segregation matching rules mirror allocate.ts: box pair must equal order pair when the order carries one; a customer-segregated sub-inventory (`sub_inventories.customer_code`) only serves that customer's orders.
- Shipping-box weights are kg end-to-end, REAL columns, 3 dp (`parseKg`, picking.ts:1151).

## additionalData key convention (documented, no code enforcement)

`{ "boxSize": "M", "netWeight": 1200, "grossWeight": 1350, "weightUnit": "g" }`
- `weightUnit`: `"g"` or `"kg"`, default `"kg"`; g values are converted ÷1000 and rounded to 3 dp at claim time.
- Missing keys → prefill stays NULL; measuring proceeds as today.

## Implementation steps

### 1. Design spec
- `docs/superpowers/specs/2026-07-29-whole-box-picking-claim-design.md` — matching rule, claim tx, weight prefill, ledger, errors, UI.

### 2. Schema — migration 0008
- `apps/backend/src/db/schema/picking.ts`: add `sourceShelfBoxId: text("source_shelf_box_id").references(() => shelfBoxes.id)` (nullable) to `shipping_boxes` — traceability of the reused carton (import shelfBoxes from inventory.ts).
- `pnpm --filter @warehouse/backend db:generate` → migration 0008. Apply with `db:migrate` (dev) — boot auto-applies in prod.

### 3. Backend domain — `apps/backend/src/db/picking.ts`
- `findExactMatchShelfBox(dbOrTx, order)` helper (shared by hint + claim):
  - open demand per part: `picking_items.qty − Σ picking_packages.qty` (> 0 only); empty → no match.
  - candidate boxes: aggregate `inventory_lots` (`box_id IS NOT NULL`, `total_qty > 0`) grouped by (box_id, part_no); join `shelf_boxes` (+ `sub_inventories` for customer filter); apply pair/customer rules.
  - exact multiset equality box-contents == open demand.
  - fully claimable: for every lot of the box, `available_qty + COALESCE(this order's allocation from that lot) = total_qty` (no other order reserves any piece of the box).
  - return first match (box id ASC) as `{ id, shelfCode, orgId, subInventoryCode, contents: [{partNo, qty}] }`.
- `getPickingOrderDetail`: add `suggestedBox` (null unless order status pending/picking) using the helper.
- `claimShelfBox(db, { orderId, shelfBoxId, actorId })` in one tx:
  1. `loadOrderForWrite` + `assertOrderWritable` + `assertActor`; load shelf box (404 `shelf_box_not_found`).
  2. Re-run exact match inside the tx → 409 `box_not_exact_match`; availability → 409 `box_not_fully_available`.
  3. Weight/size prefill: sum `netWeight`/`grossWeight` over the box's `inventory_lot_sources` → `receiving_invoice_items.additional_data` (g→kg via `weightUnit`, 3 dp), `boxSize` = first non-null.
  4. Create shipping box: `nextBoxId(tx, "S")`, status open, `source_shelf_box_id`, prefilled `box_size`/`net_weight`/`gross_weight`; logTransition.
  5. Per box lot (total_qty > 0): `total_qty → 0`; insert `picking_packages` (sourceType `inventory_lot`, batch attrs from lot, `shipping_box_id` = new box) mapped to the item of the same part_no; PICK `on_hand −qty` ledger rows.
  6. Delete ALL `allocations` of the order's items; RESERVE `reserved −qty` ledger rows per released row; `recomputeLot` every affected lot; `markShelfBoxStockChanged(boxId)`.
  7. `recomputePickingItem` per item → picked_qty full → `maybeAutoFinishPickingOrder` (order finished + measuring/verify task per FLOW_STEPS_DISABLED).
  8. Return `{ shippingBoxId, packageIds }`.
- Errors snake_case: `box_not_exact_match`, `box_not_fully_available`, existing guards reuse `picking_order_already_finished` / `picking_order_has_open_issue`.

### 4. Route — `apps/backend/src/routes/picking.ts`
- `POST /picking-orders/:id/claim-shelf-box`, body `{ shelfBoxId }`, actor from JWT (`actorFrom(c).id`), returns `{ shippingBoxId, packageIds }`.

### 5. Web client
- `apps/web/services/warehouse.ts`: `PickingOrderDetail.suggestedBox` type + `claimShelfBox(orderId, shelfBoxId)` on WarehouseService interface.
- `apps/web/services/adapters/backendWarehouse.ts`: map `suggestedBox` in the detail DTO; implement `claimShelfBox` (POST; add mutation invalidation for `/picking-orders` if not already covered).
- `apps/web/pages/picking/[id].vue`: hint banner above the items list when `order.suggestedBox` — "This order exactly matches shelf box … (shelf …)" + **Use whole box** button → confirm dialog → claim → toast with new shipping box id → reload detail. Hidden once order is finished.
- i18n keys `picking.detail.boxMatchHint` / `useWholeBox` / `boxMatchClaimed` (+ confirm text) in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`.

### 6. Tests — `apps/backend/src/db/picking.test.ts` (extend)
- Happy path: seed order whose open demand exactly equals a shelf box's lots → claim → packages boxed in a new BOX-S box, weights prefilled (incl. g→kg), lots total_qty 0, allocations gone, order finished + measuring task, `source_shelf_box_id` set.
- Non-exact box → 409 `box_not_exact_match`.
- Box partially reserved by another order → 409 `box_not_fully_available`.
- Detail DTO carries `suggestedBox` only when matched & order active.

### 7. Docs
- `docs/backend/schema-tables.md` (shipping_boxes.source_shelf_box_id), `docs/backend/api-design.md` (endpoint + additionalData key convention), `docs/backend/README.md` (route), `AGENTS.md` picking sentence, `docs/app-docs/flows/picking/{steps,ai-scope}.md`.

### 8. Verification
- `pnpm --filter @warehouse/backend test` (serial) + `build`.
- `pnpm --filter @warehouse/web test`.
- Browser check on :3000 (backend/web dev servers already running): picking detail of a seeded order, hint banner, claim, measuring prefill. Do NOT run `nuxt prepare`/`generate` while the web dev server is up.
- Restart backend dev server after migration (background task `bash-0083h9wn`).
