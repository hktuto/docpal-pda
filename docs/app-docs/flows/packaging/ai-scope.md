# Packaging — AI Scope and Remarks

## In scope

- Packaging queue (打包) — order-keyed, **fully derived** (no task table, no
  `*_pending` flag): `listPackagingOrders` (`apps/backend/src/db/packaging.ts`)
  behind `GET /packaging-orders?status=pending|completed`
  (`apps/backend/src/routes/packaging.ts`); pending rows require the
  `packagingPendingWhere()` predicate — `status IN ('picking_finished',
  'measuring_finished')`, no `labeling_pending`/`label_printing_pending`,
  `packaged_at IS NULL`, no unboxed package, every box
  `closed` (+ every box's verify task `completed` when the `verify` step is
  enabled — mirroring `readyToShipWhere` in `src/db/shipping.ts`). Rows carry
  the auto `boxCount`, `packageCount`, `grossWeightHint` (Σ box gross — display
  only), and `packaged_*` fields. Org/user partition via the shared
  `pickingOrderOrgFilter` (exported from `src/db/picking.ts`) + assignee
  visibility via `assigneeFilter` (`src/db/user-scope.ts`) over the
  `picking_tasks` step row, like the labeling queue.
- Confirm — `confirmPackaging` (same file) behind `POST
  /packaging-orders/:orderId/confirm` `{weight, palletCount?}`: re-checks the
  pending predicate in-tx (404 `packaging_order_not_found`, 409
  `packaging_not_ready` — also covers double-confirm), validates weight
  (`invalid_weight`) / pallet count (`invalid_pallet_count`), **recomputes the
  box count server-side**, stamps `picking_orders.packaged_at`/`packaged_by`/
  `packed_weight`/`packed_box_count`/`packed_pallet_count`, writes a
  `transaction_logs` row (`packaging_pending → packaged`), emits SSE
  `picking.packaged` (topics `/packaging-orders`, `/picking-orders`,
  `/shipping-orders`). Order `status` is NOT extended. No stock movement.
- Ship gate — `readyToShipWhere()` (`src/db/shipping.ts`) gains the packaging
  clause while the step is on: a box ships only when every
  **non-cancelled** order holding its packages has `packaged_at`. The feed row
  also carries `packaged` (data truth regardless of the step) and the box
  detail's order rows carry the `packagedAt`/`packed*` fields for the admin
  review + copy summary.
- Reopen interaction — no guard needed: `reopenShippingBox` requires a
  *pending* verify task, which packaged orders never have (their boxes'
  verify tasks are all `completed`). Recorded in a comment there.
- Admin order reset (`resetPickingOrderProgress`) clears the `packaged_*`
  columns alongside the shipped/labeling columns, so a reset order re-queues
  packaging cleanly.
- Assignee — `picking_tasks` side rows `step='packaging'` (labeling/CR-048
  pattern; the `chk_picking_tasks_step` CHECK widened in migration 0063);
  task-assignment flow `packaging` (`FLOW_TABLES` + list case in
  `src/db/taskAssignments.ts`, `routes/admin/taskAssignments.ts`).
- Flow step — `packaging` in `FLOW_STEPS` (`src/config.ts`), **default
  disabled** (opt-in like `receiving-cn`; warehouses flip it on via
  `PUT /admin/flow-config`; seed configs untouched). `shipping` step is
  default-on and gates the admin `/shipping` nav link only
  (`NAV_STEP_GATES` in `apps/admin/app.vue`).
- PDA list rendering — `pdaViewConfig.lists.packaging` (chip catalog
  `none`/`boxCount`/`packageCount`, default `{title:"[order_no]",
  meta:["[customer_code] · [ship_to]"], chip:"boxCount"}`; mirrors in
  `apps/pda/utils/viewConfig.ts` + `apps/pda/utils/listRowTemplate.ts` + admin
  mirrors + `apps/admin/pages/pda-view-config.vue` sample maps).

## Out of scope

- No PDA 寄出 surface — shipping stays admin-only.
- No per-order bulk ship ("ship all boxes of the order") — the admin ships
  per box as before; packaging only gates readiness.
- No carrier/delivery-provider integration — the admin review page only
  prepares copyable text.
- No enforcement that `packed_weight` matches the summed box gross weights
  (hint displayed, operator's scale reading wins).
- No re-clear path for `packaged_at` outside the admin order reset.

## Key files

- `apps/backend/src/db/packaging.ts` — queue/detail/confirm + the shared
  `packagingPendingWhere()` predicate.
- `apps/backend/src/routes/packaging.ts` — the three endpoints (registered in
  `src/index.ts`).
- `apps/backend/src/db/shipping.ts` — packaging clause in
  `readyToShipWhere`, `packaged` on the feed row, packaged fields on the box
  detail orders.
- `apps/backend/src/db/schema/picking.ts` — `picking_orders` `packaged_*`
  columns (migration 0063) + `picking_tasks` step check.
- `apps/pda/pages/packaging/index.vue` + `[orderId].vue` — queue + confirm
  form (no scanning; weight + boxes/pallets toggle + `window.confirm`).
- `apps/pda/utils/packaging.ts` — `isPackagingNotReady` (409 → already-done,
  `isLabelingNotPending` convention).
- `apps/pda/services/adapters/backendWarehouse.ts` —
  `getPackagingOrders/getPackagingOrder/confirmPackaging`.
- `apps/admin/pages/packaging/{index,[id]}.vue` — admin twin (bespoke table +
  form); `apps/admin/pages/shipping/[id].vue` — packaged cell + copy-summary
  textarea.
- `apps/admin/utils/flowApi.ts` — `listPackagingOrders/getPackagingOrder/
  confirmPackagingOrder` + `packaged` fields on the shipping types.

## Known limitations

- Packaging is per picking order — a truck consolidating several orders is
  confirmed per order (cross-order shared boxes wait for every order).
- Old PDA app builds predate the queue; the page only shows when the step is
  on, so no compatibility path was needed.

## Related specs/plans

- `docs/superpowers/specs/2026-11-10-packaging-shipping-steps-design.md`
- `docs/superpowers/plans/2026-11-10-packaging-shipping-steps.md`
- `docs/backend/api-design.md` §Packaging + §Flow-step config + shipping feed
- [Verify AI scope](../verify/ai-scope.md) — the stage whose completion queues packaging
- [Labeling AI scope](../labeling/ai-scope.md) — the `picking_tasks` assignee pattern reused here
