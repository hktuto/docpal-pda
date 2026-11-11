# Packaging (打包) + Shipping (寄出) steps — CN flow

Date: 2026-11-10 · Status: draft · Apps: backend, pda, admin
Warehouse scope: CN instances (non-HK). Config-only — no code branches; HK keeps today's behavior.

## 1. Goal

Insert two steps after `verify` in the outbound chain:

1. **packaging (打包)** — enabled on both PDA and admin. When an order's goods are fully
   boxed + verified, the operator records the shipment's **total weight** and either the
   **box count (auto-counted from the order's closed boxes)** or a **pallet count**, and
   simply confirms. One confirmation per picking order.
2. **shipping (寄出)** — admin-only. A review page showing the packaged content (order,
   ship-to, weight, box/pallet count, boxes, packages) so the clerk can **copy it into the
   delivery provider's form** and mark the boxes shipped.

Chain today: picking finish → (labeling) → measuring closes box → verify task completes →
order flips `picking_finished → measuring_finished` → admin box feed `/shipping-orders`
ships per box → order derives `shipped`.

New chain (CN): … → verify → **packaging (order-level)** → **shipping (admin review + ship)**.

## 2. Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Packaging unit | **picking order** | "box count (auto count)" only makes sense as an aggregation of the order's boxes; confirm happens once per outbound order. Mirrors the labeling stage, which is also a flag-stage on `picking_orders`. |
| D2 | Packaging queue | **derived SQL, no new `*_pending` flag and no creation hook** | Same as the admin measuring-assignment queue (`db/taskAssignments.ts` "measuring" case): readiness is computable from boxes + verify tasks + order status. Touches no existing transaction. |
| D3 | Packaging state storage | nullable columns on `picking_orders` (below). Order `status` is **not** extended — `packaged_at IS NOT NULL` is the packaged truth | `measuring_finished → shipped` lifecycle stays intact; 9 consumer queries on status stay untouched. |
| D4 | Ship granularity | shipping stays **per box** (`shipShippingBox` unchanged core); packaging only *gates* readiness | Cross-order packing exists in the model; per-box ship + per-order packaging compose cleanly. |
| D5 | `shipping` step semantics | gates the admin `/shipping` nav link only (like `put-back` gates its tile). **Default enabled** so existing warehouses keep the link | The ship endpoint + page already exist; the step makes the CN flow explicit and switchable. |
| D6 | `packaging` step default | **disabled** in `defaultFlowConfig()` (like `receiving-cn`); no seed change — each warehouse enables it via `PUT /admin/flow-config` (operator-managed) | Behavior-neutral everywhere; matches the "existing `warehouse_config` rows keep what they have" precedent. |
| D7 | Assignee scoping | reuse the labeling **`picking_tasks` side-row** pattern (`step = 'packaging'`) | `picking_orders` is upstream-synced; labeling already proved this path (CR-048). Admin task-assignments + PDA per-user queue come free. |
| D8 | Admin shipping review page | **extend the existing** `apps/admin/pages/shipping/` list+detail with packaged fields + a copyable summary block | New bespoke page = duplicate of a page that already lists, selects and ships the same boxes. |
| D9 | Box/pallet mode | confirm payload takes `weight` + optional `palletCount`; **box count is always recomputed server-side** (auto count is guaranteed); when `palletCount` is set the order ships on pallets (displayed mode = pallets) | Client cannot skew the count; both numbers stored for the delivery-provider copy. |

## 3. Backend

### 3.1 Flow config (`src/config.ts`)

- `FLOW_STEPS += "packaging", "shipping"` (after `verify`).
- `defaultFlowConfig()`: `steps["packaging"] = { enabled: false }`; `shipping` default-enabled.
- Boot validation, `GET /config` `flowSteps`, admin `flow-config.vue` `STEPS` list pick the keys up automatically
  (`parseFlowConfig` validates against `FLOW_STEPS`).
- **No seed change**: `HK_FLOW_CONFIG`/`SZ_FLOW_CONFIG` untouched — they merge over `defaultFlowConfig()`,
  so both warehouses start with `packaging` off; the CN step enablement is done by the operator on the
  admin flow-config page (a partial JSON that omits a step keeps the default).

### 3.2 Schema (migration via `db:generate`, next number 0063)

`picking_orders` new columns (all NULL, additive, no backfill):

| column | type | meaning |
| --- | --- | --- |
| packaged_at | timestamp | confirm time; NULL = not packaged |
| packaged_by | text FK → users(id) | confirming actor |
| packed_weight | real | total weight, kg, ≤3 dp (same unit convention as `shipping_boxes.gross_weight`) |
| packed_box_count | integer | server-recomputed count of closed boxes holding the order's packages at confirm |
| packed_pallet_count | integer | pallet mode (NULL = boxes mode) |

### 3.3 Domain `src/db/packaging.ts`

**Queue — `listPackagingOrders(status?)`** — orders where
`status IN ('picking_finished','measuring_finished')` AND NOT `labeling_pending`/`label_printing_pending`
AND all packages boxed AND every box holding the order's packages is `closed` (+ its verify task
`completed` when the verify step is enabled) AND `packaged_at IS NULL` (`status='pending'`) —
or the packaged set for the completed/history view (`packaged_at IS NOT NULL`, optional date window).
Apply `assigneeFilter` (`src/db/user-scope.ts`) + `pickingOrderOrgFilter` like the other queues.
Row: `orderId, orderNo, shipTo, customerCode, poNo, boxCount, packageCount, grossWeightHint`
(sum of the boxes' `gross_weight` — display hint only, never written).

**Detail — `getPackagingOrderDetail(orderId)`**: the queue row + the order's boxes (id, closedAt,
gross/net weight, destination, packageCount) + packages (part identity) — read-only review data.

**Confirm — `confirmPackaging(db, { orderId, weight, palletCount?, actorId })`** in one tx:
1. re-run the queue predicate on the order → 404 `packaging_order_not_found` / 409 `packaging_not_ready`
   (also covers double-confirm: `packaged_at IS NULL` is part of the predicate);
2. validate `weight > 0` (finite, ≤3 dp rounded) and `palletCount` null-or-integer ≥ 1 → 400 `invalid_payload`;
3. recompute box count, `UPDATE picking_orders SET packaged_at/by/packed_weight/packed_box_count/packed_pallet_count`;
4. `transaction_logs` row (entity `picking_order`, from/to = current status, metadata = the packaged numbers);
5. `emitEvent` `picking.packaged` topics `["/packaging-orders", "/picking-orders", "/shipping-orders"]`.

No inventory movement, no ledger — packaging is information-only.

**Reopen needs no extra guard** (implementation finding): `reopenShippingBox` — the only reopen
path — already 409s `verify_task_not_pending` unless the box has a pending verify task, while a
packaged order implies every verify task of its boxes is `completed`. Reopening after packaging is
therefore unreachable; no `order_already_packaged` code was added (a comment in `reopenShippingBox`
records this).

### 3.4 Ship gate — `src/db/shipping.ts`

`readyToShipWhere()` gains one clause (shared by feed + `shipShippingBox` re-check):

```sql
AND (${!isStepEnabled("packaging")} OR NOT EXISTS (
  SELECT 1 FROM picking_packages px
  JOIN picking_items ix ON ix.id = px.picking_item_id
  JOIN picking_orders ox ON ox.id = ix.picking_order_id
  WHERE px.shipping_box_id = sb.id
    AND ox.packaged_at IS NULL
    AND ox.status <> 'cancelled'))
```

A box shared across orders ships only when **every** non-cancelled order in it is packaged.
`cancelled` is excluded so a cancel can't wedge a shared box (its packages get removed by the
put-back flow anyway). New 409 stays `box_not_ready_to_ship`.

`listShippingOrders` row gains `packaged: boolean` (all its orders packaged) and the detail gains
each order's `packagedAt / packedWeight / packedBoxCount / packedPalletCount` on its order rows.

### 3.5 Routes — `src/routes/packaging.ts` (thin, actor via `actorFrom(c)`)

| verb/path | purpose |
| --- | --- |
| GET `/packaging-orders?status=pending\|completed` | queue / history |
| GET `/packaging-orders/:orderId` | detail |
| POST `/packaging-orders/:orderId/confirm` | `{ weight, palletCount? }` |

Registered in `src/index.ts` (import + `app.route`). 404/409 snake_code errors; no body actor.

### 3.6 Task assignments

`TaskAssignmentFlow += "packaging"`; `FLOW_TABLES.packaging = { table: picking_orders, entityType:
"picking_order", step: "packaging" }` (labeling's `picking_tasks` side-row upsert path); list case
mirrors §3.3 queue. Admin: `flowApi.ts` union + `task-assignments.vue` `FLOWS`.

### 3.7 PDA view config

`pdaViewConfig.lists` catalog += `packaging` (default `{title: "[order_no]", meta: ["[ship_to]", "[customer_code]"], chip: "none"}`,
field catalog: `order_no, ship_to, customer_code, po_no, box_count, package_count`); mirrored in
`config.ts`, `apps/pda/utils/viewConfig.ts`, `apps/admin/utils/viewConfig.ts` + `listRowTemplate.ts`.

## 4. PDA (`apps/pda`)

- `composables/useFlowSteps.ts` defaults + `services/types.ts` FlowStep union: `packaging`, `shipping`.
- Home tile `v-if="flowSteps.packaging"` → `/packaging` (icon: box), `$t('home.menu.packaging.*')`.
  No 寄出 tile (admin-only step).
- `pages/packaging/index.vue`: `AppListPage` + `:topics="['/packaging-orders', '/picking-orders', '/shipping-orders']"`
  (useVisibleReload via props), rows through `viewListRow/viewListChip("packaging", …)`; pending-only
  queue (packaged orders leave the list; the history view is admin-side `?status=completed`).
- `pages/packaging/[orderId].vue`: read-only order + box summary (`DetailRow`s, box count shown as the auto number),
  weight input (numeric keypad), boxes/pallets segmented toggle (pallet count input when 卡板), one confirm button
  with `confirm()` guard; completed orders show the recorded values instead of the form. No scanning
  (`打包` is manual figures) — no ScanFab/hardware-scanner wiring.
- Adapter `backendWarehouse.ts` + `services/warehouse.ts`: `getPackagingOrders(status)`,
  `getPackagingOrder(id)`, `confirmPackaging(id, weight, palletCount)`.
- i18n (`layers/i18n`): `packaging.*` page namespace + `home.menu.packaging.*` in en-US / zh-CN / zh-HK
  (打包 / Packaging).

## 5. Admin (`apps/admin`)

- `pages/flow-config.vue`: `STEPS` += `packaging`, `shipping` (labels 打包 / 寄出).
- `utils/entities.ts` nav: `admin.navLinks.packaging` → `/packaging` link added inside the existing
  Shipping section; `app.vue` `NAV_STEP_GATES`: `/packaging → packaging`, `/shipping → shipping`
  (shipping default-on ⇒ HK link unchanged; admin `useFlowSteps` defaults carry both).
- `pages/packaging/index.vue` + `[id].vue` — bespoke like `pages/shipping/` (`useAdminTable` +
  `DataTable` + `Pager` + `ChangeNotice(["picking.packaged", "picking_order.updated"])`):
  pending queue (row click → detail); detail = the PDA form's twin (weight, auto box count read-only,
  pallet toggle, confirm; packaged orders read back the recorded numbers) and links each box into the
  shipping box detail. `flowApi.ts`: `listPackagingOrders / getPackagingOrder / confirmPackagingOrder`.
- `pages/shipping/index.vue`: `packaged` column (✓ / —); `pages/shipping/[id].vue`: per-order
  packaged cell (weight / boxes / pallets) and a **copy summary** `<textarea>` + copy button
  (`order_no, ship_to, customer, boxes, weight kg, pallets`; `navigator.clipboard.writeText`,
  select-fallback on insecure origins) + `picking.packaged` SSE topic.

## 6. Errors & edge cases

| case | behavior |
| --- | --- |
| double confirm / confirm off a non-ready order | 409 `packaging_not_ready` |
| box shared by packaged + unpackaged order | box stays out of the ship feed (D4 clause) |
| cancelled order sharing a box | ignored by the ship gate |
| reopen verify/box after packaged | unreachable — reopen already requires a *pending* verify task, which packaging completion excludes (§3.3 note) |
| packaging step off | queue hidden everywhere, ship gate inert, today's flow unchanged |
| `packed_weight` vs summed `gross_weight` | independent — entered scale reading wins on the review page (hint shown, not enforced) |

## 7. Testing

- `config.test.ts`: defaults (packaging off, shipping on), parse round-trip for the two keys.
- `packaging.test.ts` (node:test, `test-fixtures` order+box+verify factory): queue derivation
  (open box / pending verify / labeling-pending / unboxed package all excluded; verify-off config
  path), confirm stores server-recomputed box count + pallet mode + ledger + event topics,
  double-confirm 409, assignee scoping.
- `shipping.test.ts`: feed/ship blocked until all orders in the box packaged; cancelled-order escape.
- `user-scope.test.ts` / task-assignments: `packaging` flow row set matches the queue.
- PDA vitest: adapter method URL/payload tests (mirror the labeling adapter tests) +
  `packaging` view-config row rendering.

## 8. Docs & tracking (delivery checklist)

- `docs/backend/api-design.md`: `/packaging-orders*`; `event-catalog.md`: `picking.packaged`;
  `schema-tables.md`: `picking_orders` new columns; `flow-config.md`: both steps.
- `apps/admin/TOC.md`: Packaging section + shipping review line + task-assignment flows line.
- `docs/app-docs/flows/packaging/` (new flow: overview/steps/ai-scope) + `ai/feature-registry.md` + `ai/code-map.md`;
  `docs/dev-guide-zh/flows/packaging.md`.
- `docs/uat/functions.json`: new `PDA-*` packaging + `ADM-*` packaging-review functions, then
  `node scripts/gen-uat-xlsx.mjs`; record the delivered feature/bugs after implementation.

## 9. Out of scope

- PDA 寄出 tile/page (admin-only per requirement); per-order bulk ship ("ship all boxes of order X")
  — press the existing per-box Ship; add later if the CN clerks ask.
- Delivery-provider API integration (the page only prepares copyable text).
- Carton-label printing of packaging figures, pallet labels, loaded-truck reconciliation.
- Measuring/verify changes; HK behavior changes of any kind.

## 10. Plan of record

Implementation order in `docs/superpowers/plans/2026-11-10-packaging-shipping-steps.md`.
