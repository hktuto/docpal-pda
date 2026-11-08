# Backend API Design

> **Note (2026-07-21):** this is the original design doc. Field names shown
> below predate the org_id redesign (`ref_no`→`batch_no`/`order_no`,
> `part_id`→`part_no`, no `warehouse_code`/section/sub-inventory) and the
> 2026-07-29 system-fields/supplier-code refactor
> (`createdAt`→`createdDate`/`lastUpdateDate`, `supplierId`→`supplierCode`,
> `parts.supplier_code`→`parts.brand`) — the
> current schema contract is `schema-tables.md`, and auth is now JWT (see the
> Auth section below and `README.md`).

The endorsed HTTP API for `apps/backend` (the `apps/api` replacement). Derived
from the old-API review (`api-review-old-api.md`): keep what worked (list +
status filter, detail / detail-picking split, ingest upserts), fix what didn't
(response shapes, verb-RPC drift, dead routes). Business rules referenced here
live in `concepts.md`; tables in `schema.md`.

## Conventions

1. **camelCase DTOs everywhere.** No snake_case SQL passthrough — the server
   shapes every response; clients never remap field names.
2. **Resource paths, kebab-case, one canonical route per operation.** No
   nested + flat twins: mutations address resources **by their own id**
   (`/packages/:id`, `/shipping-boxes/:id`) — clients never need parent ids
   they don't have. Sub-paths only for true sub-resources
   (`/shipping-boxes/:id/packages/:packageId`).
3. **Complete reads.** GET responses are nested DTOs containing everything the
   consumer needs — no flat parallel arrays or keyed maps to join client-side,
   no follow-up call to make a response usable. Server computes counts.
4. **Reads are GET only.** Never POST-for-reads. List endpoints support a
   `?status=` server-side filter.
5. **Mutations.**
   - `PATCH /resource/:id` — field edits (partial body).
   - `POST /resource/:id/<action>` — state transitions with side effects
     (`confirm-arrival`, `finish`, `close`, `verify`, `cancel`).
   - `DELETE /resource/:id` — removal.
   - **`actorId` is taken from the JWT** (auth middleware) — mutation bodies
     no longer carry it.
6. **Errors:** proper HTTP status (400 invalid, 404 missing, 409 conflict) +
   plain-text snake_code message body (e.g. `receiving_order_not_found`).

## Health

Tokenless liveness probes (`apps/backend/src/routes/health.ts`) — both exempt
from the JWT middleware (see §Auth).

| Endpoint | Body → Response | Note |
|---|---|---|
| `GET /health` | — → `{ok, db: "ok"\|"error"}` | 200 when a `SELECT 1` succeeds, 500 when the DB is down; polled by the PDA watchdog (`useServerHealth.ts` → `ServerDownOverlay`) |
| `GET /latency-ping` | — → `{ok: true, serverTime}` | tiny echo of the server clock for the admin + PDA latency-test pages (round trip = client-measured fetch time) |

## Auth (implemented)

| Endpoint | Body → Response | Note |
|---|---|---|
| `POST /auth/login` | `{username, password}` → 200 `{user{id, username, displayName, groupCodes}, token}` / 401 / 403 / 500 | DocPal-verified, auto-provisioned; 403 `user has no WMS access` when no group maps; 500 when `DOCPAL_URL` is not configured |
| `POST /auth/login-token` | `{accessToken}` → same as `/auth/login` | DocPal access-token exchange (sign-in links); validated via DocPal `users/application`, then the same provision+sign path |
| `POST /auth/logout` | — → `{ok: true}` | no-op (client discards the token) |
| `GET /auth/me` | — → AuthUser / 401 | session restore from the bearer token |
| `GET /auth/users/:id` | — → AuthUser / 404 | |
| `GET /auth/me/profile` | — → `{username, subInventoryScopes: [{orgId, code}]}` | caller's per-user sub-inventory scope (NULL/[] = unrestricted) |
| `PUT /auth/me/profile` | `{subInventoryScopes: [{orgId, code}]}` → the saved profile | upsert by the actor's username; every pair validated against `org_info` (400 `unknown_sub_inventory` with the bad pairs listed) |

### Admin: user profiles

| Endpoint | Body → Response | Note |
|---|---|---|
| `GET /admin/user-profiles` | — → `[{id, username, displayName, groupCodes, subInventoryScopes}]` | users LEFT JOIN profiles |
| `PUT /admin/user-profiles/:username` | `{subInventoryScopes: [{orgId, code}]}` → the saved profile | same validation as the self-service PUT (400 `unknown_sub_inventory`); username need not exist in `users` yet (pre-provisioning) |
| `GET /admin/docpal-url` | — → `{url: string | null}` | `DOCPAL_URL` base for the admin console's "Open DocPal" popover link; null when unconfigured |

### Admin: task assignments

Optional PDA task assignee (spec
`docs/superpowers/specs/2026-11-01-task-assignee-design.md`): an `assignee`
username on the PDA-queue rows (`receiving_orders_cn`, `picking_orders`,
`put_away_tasks`, `put_away_tasks_cn`, `shipping_boxes`, `verify_tasks`,
`put_back_tasks` — no FK); the `labeling` / `label-printing` flows are the
exception — their assignee is stored as `picking_tasks` step rows keyed by
`(picking_order_id, step)`, independent of `picking_orders.assignee` (CR-048).
NULL = visible to every PDA user, set = only that user sees the task in
the PDA list + detail reads (detail 404s). Managed here; there is no self-claim.

| Endpoint | Body → Response | Note |
|---|---|---|
| `GET /admin/task-assignments?flow=` | — → `[{id, label, status, assignee}]` (+ flow-specific keys, e.g. `batchNo`/`orderNo`/`boxId`) | open tasks of one flow (`receiving-cn` \| `picking` \| `label-printing` \| `labeling` \| `put-away` \| `put-away-cn` \| `measuring` \| `verify` \| `put-back` — `TASK_ASSIGNMENT_FLOWS` in `src/db/taskAssignments.ts`) for the picker UI; includes every assignee regardless of the caller |
| `PATCH /admin/task-assignment` | `{flow, id, assignee}` → `{ok, flow, id, assignee}` | set one task's assignee; `null`/empty clears. The username is NOT validated against `users` (an assignment may pre-exist the user row, same as `user_profiles`). 400 `unknown_flow: must be one of …`/`id must be a non-empty string`/`assignee must be a string or null`, 404 `task_not_found`; writes a `transaction_logs` audit row (from/to = the old/new assignee) |

### Admin: manual allocation

| Endpoint | Body → Response | Note |
|---|---|---|
| `POST /admin/allocation/snapshot` | — → `{batchId, snapshotDate, capturedAt, allocations}` | captures a snapshot of ALL picking `allocations` into `allocation_snapshot_batches`/`allocation_snapshot_rows` right now (`captureAllocationSnapshot` in `apps/backend/src/db/allocationSnapshot.ts`); one batch per backend-local date — a same-day recapture replaces the earlier batch. Part of the UAT allocation snapshot/restore safety net, spec `docs/superpowers/specs/2026-10-26-uat-allocation-snapshot-restore-design.md` |
| `POST /admin/allocation/restore` | — → `{batchId, snapshotDate, restoredAt, total, restored, existing, skipped, releasedRows, releasedQty, manualConflicts, rows[]}` | restores the LATEST snapshot batch (`restoreLatestAllocationSnapshot`, routed through the serialized allocation runner): per row — re-resolve the picking item (original ids, then order_no/line-id/line-number/part fallbacks) and the source (original id, then full natural-lot / receiving business keys), skip non-`pending`/`picking`/`allocated` or work-locked orders, validate open qty + source availability, release conflicting AUTOMATIC allocations (RESERVE-release ledger `"snapshot restore: release"`; manual pins are never stolen — reported as `manual_conflict`), re-insert with the ORIGINAL allocation UUID (retries idempotent, existing rows report `existing`); afterwards set-wise reconciles ALL `inventory_lots.allocated_qty` / `picking_items.allocated_qty` counters from current allocation rows and refreshes order allocation statuses; does NOT run `allocateAll`. 404 `allocation_snapshot_not_found` when no batch exists. The summary is persisted on the batch (`report`, `restored_at`); emits `allocation.computed` (only on net change) + `allocation.finished` with `scope: "snapshot-restore"`. Same spec |
| `POST /admin/picking-orders/:id/reallocate` | — → `{allocation}` (scoped summary incl. `partKeys`) | recompute scoped to the order's part keys (`allocateForPickingOrder`); 404 `picking_order_not_found`, 409 `order_not_open` unless pending/picking/allocated (an `allocated` order is force-included as a demand — the explicit repair path for a stale lock), 409 `lock_held` with `{error, holderId, holderName}` when a live PDA work lock is held. Spec `docs/superpowers/specs/2026-09-14-admin-allocation-buttons-design.md` |
| `POST /admin/receiving-orders/:id/reallocate` | — → `{allocation}` (`null` on background fallback) | recompute scoped to the order's part keys (`allocateForReceivingOrder`, same core as confirm-arrival); 404 `receiving_order_not_found`, 409 `order_not_in_hand` unless the order is `in_hand`. Spec `docs/superpowers/specs/2026-09-14-admin-receiving-shipper-download-design.md` |
| `DELETE /admin/picking-orders/:id/items/:itemId/allocations/:allocationId` | — → `{removed: 1, qty}` | deletes ONE allocation row (`removePickingAllocation`): releases the lot's `allocated_qty`, RESERVE-release ledger row, audit log, `allocation.computed` event; 404 `picking_order_not_found` / `picking_item_not_found` / `allocation_not_found`, 409 `lock_held`; **no order-status check**. Transient — the next recompute may re-allocate the item. Spec `docs/superpowers/specs/2026-09-15-admin-picking-item-actions-design.md` |
| `POST /admin/picking-orders/:id/items/:itemId/allocations` | `{qty, inventoryLotId}` or `{qty, receivingInvoiceItemId}`, optional `override: true` → `{allocationId, qty}` | pins a MANUAL allocation (`allocations.manual = true`, any location) from the availability modal; the engine preserves pinned rows and auto-allocates only the remaining open demand. 400 `invalid_qty`/`source_required`, 404 `inventory_lot_not_found`/`receiving_invoice_item_not_found`, 409 `lock_held`/`insufficient_available`/`over_allocation` (Σ allocations may not exceed open qty). No order-status check. With `override: true` a qty above the source's availability reclaims the shortfall from OTHER items' **non-manual** allocations on that source (oldest first; locked victim orders skipped, manual pins never stolen) — per-victim RESERVE-release ledger (`txn_reason: "admin: override steal"`), victim-order audit (`action: "allocation_stolen"`) + `allocation.computed` SSE event. Same spec + `docs/superpowers/specs/2026-10-06-admin-availability-dialog-improvements-design.md` |
| `POST /admin/picking-orders/:id/items/:itemId/allocate-form` | `{rows: [{inventoryLotId? \| receivingInvoiceItemId?, qty, override?}]}` → `{pickingItemId, openQty, allocated, changed}` | ONE Confirm for the whole availability modal (`allocatePickingItemFromSources` in `apps/backend/src/db/pickingAllocateForm.ts`): applies every row of the picking item's allocate form in a single all-or-nothing transaction. Each `qty` is the DESIRED FINAL total from that source (0 releases it); sources ABSENT from the body keep their current value, so the dialog's date-code / `matched` filters can never silently release stock the admin can't see. Releases run before growth, and the per-item guard is checked once against the final total (`allocated <= openQty = qty − Σ packages`). Growing a row AMENDS its existing allocation line (forced `manual = true`) rather than inserting a second one — one picking item + one source stays one line. 400 `invalid_qty`/`source_required`/`duplicate_source`, 404 `picking_order_not_found`/`picking_item_not_found`/`inventory_lot_not_found`/`receiving_invoice_item_not_found`, 409 `lock_held`/`over_allocation` (`{openQty, allocated}`)/`allocate_rejected` (`{rows: [{key, reason}]}` where `key` is `l:<lotId>` \| `r:<receivingItemId>` and reason is `insufficient_available`). `override: true` on a row reclaims the shortfall above the source's availability from other orders' non-manual allocations via the shared `stealAllocationsOnSource` helper; its reachability is pre-validated so an impossible row is rejected with a per-row reason instead of failing mid-apply. No order-status check; no engine recompute scheduled (the pins survive one). Spec `2026-10-12-admin-receiving-reallocate-form-design.md` § picking-side form |
| `PATCH /admin/picking-orders/:id/status` | `{status, reason?}` → `{id, orderNo, status, previousStatus, changed}` | admin status override (`overridePickingOrderStatus`) to any of `pending`/`allocated`/`skip`/`picking`/`issue`/`picking_finished`/`measuring_finished`/`shipped`/`cancelled` — all 9 `PICKING_ORDER_STATUSES` (spec `docs/superpowers/specs/2026-10-22-picking-status-split-design.md`, `cancelled` added by `docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md`) — no transition guards; a live PDA work lock is force-cleared; leaving an allocation-holding status (`pending`/`picking`/`allocated`) for a non-holding one releases ALL the order's leftover allocations with RESERVE-release ledger rows (moving between holding statuses — e.g. `pending → allocated`, the lock action — preserves them); leaving `shipped` clears `shipped_at`/`shipped_by` (entering stamps them), leaving `issue` clears the issue fields. any picking status override also clears `labeling_pending` (the labeling-stage escape hatch; `labeling_done_at/by` stay as audit — spec 2026-10-28). 400 `invalid_status`, 404 `picking_order_not_found`; `changed: false` no-op when already the target. On change: audit transition log, `picking_order.updated` SSE event, background recompute scheduled. The list page's batch action loops this route per id. Specs `docs/superpowers/specs/2026-09-17-admin-picking-status-override-design.md`, `docs/superpowers/specs/2026-09-22-picking-allocated-skip-status-design.md` |
| `POST /admin/picking-orders/:id/reset` | — → `{id, orderNo, status, previousStatus, packagesRemoved, boxesRemoved}` | admin "Reset order" (`resetPickingOrderProgress`) for re-testing the flow: every `picking_packages` row is reversed through the unguarded `reverseScannedPackageTx` core of `removeScannedPackage` (source qty restored — `inventory_lots.total_qty` / `receiving_invoice_items.picked_qty`, allocation bumped back via `bumpAllocation`, reverse PICK ledger rows with `txn_reason: "admin order reset"`) and deleted; the order's `shipping_boxes` (+ cascading `verify_tasks`, + `shipping_box_items`) are deleted after unboxing any foreign packages; `picking_items.picked_qty` zeroed while `allocated_qty` and allocation rows are KEPT; order → `pending` with work lock, labeling/label-printing flags and done stamps, shipped stamps and issue fields cleared. 404 `picking_order_not_found`, 409 `picking_order_shipped`. Audit transition log (`metadata {reset: true, packagesRemoved, boxesRemoved}`) + `picking_order.updated` SSE. Spec `docs/superpowers/specs/2026-11-07-admin-order-reset-design.md` |
| `GET /admin/part-availability?partNo=&wclItemNo=&orgId=&subInventoryCode=` | — → `{stock: [{lotId, orgId, subInventoryCode, shelfCode, shelfDisplayName, boxId, partNo, wclItemNo, dateCode, lotCode, coo, cow, totalQty, allocatedQty, availableQty, matched}], receiving: [{receivingOrderId, batchNo, supplierCode, status, invoiceNo, receivingInvoiceItemId, lineQty, receivedQty, putAwayQty, pickedQty, orgId, subInventoryCode, ctnNo, dateCode, matched}], dockStockAllowed}` | exact part_no / wcl_item_no match across ALL org/sub-inventory locations (rows are never filtered — the dialogs hide the non-applicable ones); powers the admin picking-detail per-item availability modal and the receiving-detail search modal; 400 `part_no_required`. Optional `orgId`+`subInventoryCode` context marks each row `matched` with the allocation engine's own location rule (same org, and the same sub-inventory or a sibling in the same `sub_inventory_share_members` group); no context → every row matches. `receiving` is empty and `dockStockAllowed: false` when `steps.picking.allocation.allowDockStock` is off (dock stock is not allocatable). Same spec |
| `GET /admin/part-demand?partNo=&wclItemNo=&orgId=&subInventoryCode=&fromReceivingItemId=` | — → `{demand: [{pickingOrderId, orderNo, orderStatus, deliveryDate, orgId, subInventoryCode, pickingItemId, partNo, qty, pickedQty, allocatedQty, remainingQty, matched, fromItemQty, locked, workingByName}]}` | open (pending/picking/allocated) picking items needing the part with uncovered qty > 0; powers the receiving-detail re-allocate form; 400 `part_no_required`. Same optional context pair / `matched` flag as part-availability. `fromReceivingItemId` adds the per-row qty held from that receiving item (the final-state form needs the current value to diff against); `locked`/`workingByName` flag rows the form must not edit. Spec `2026-10-12-admin-receiving-reallocate-form-design.md` |
| `GET /admin/part-allocations?partNo=&wclItemNo=` | — → `{allocations: [{allocationId, pickingOrderId, orderNo, orderStatus, pickingItemId, partNo, wclItemNo, qty, manual, sourceType: "lot" \| "receiving-item" \| "receiving-order", inventoryLotId?, receivingInvoiceItemId?, receivingOrderId?, orgId, subInventoryCode, shelfCode?, shelfDisplayName?, boxId?, dateCode?, lotCode?, locked, workingByName}]}` | per-order breakdown of EVERY allocation row holding a part, across all picking orders and statuses — the availability dialogs' "allocated" counter expands to this list so an admin can act on a specific order's row in place; 400 `part_no_required`. `locked`/`workingByName` reuse the part-demand work-lock rule (`working_by` set and `working_at` unexpired). Spec `docs/superpowers/specs/2026-10-14-admin-cross-order-allocation-control-design.md` |
| `POST /admin/picking-orders/:id/items/:itemId/allocations/transfer` | `{allocationId, qty?}` → `{pickingItemId, allocationId, qty}` | moves qty (default: the source row's full qty) from ANOTHER item's allocation onto this item as a MANUAL pin, in one transaction (`transferPickingAllocation`): shrink-or-delete the source row + RESERVE-release ledger (`txn_reason: "admin: transfer out"`, shelf nulled when missing from `shelves`), `recomputeLot`, `recomputePickingItem`, source-order audit `allocation_transferred_out`; amend-or-insert ONE manual row on the target (one picking item + one source = one allocation line) + RESERVE ledger (`"admin: transfer in"`), `recomputePickingItem`, target-order audit `allocation_transferred_in`; `allocation.computed` SSE on `/picking-orders`. 404 `picking_order_not_found`/`picking_item_not_found`/`allocation_not_found`, 409 `same_item` (the row already belongs to the target item)/`lock_held` (either order, holder info included)/`location_mismatch` (source outside the order's org/sub-inventory partition, share-group siblings included — the `locationMatches` rule)/`over_allocation` (Σ target allocations on the same source + qty would exceed open qty), 400 `invalid_qty`. **No recompute** — the pin survives every wipe/rebuild; the source item's residual demand is deliberately left for the next engine run (same as the remove action). Manual source rows are transferable. Same spec |
| `POST /admin/receiving-orders/:id/items/:itemId/reallocate-demand` | `{rows: [{pickingItemId, qty}]}` → `{itemId, available, fromItemQty, changed: [{pickingItemId, orderNo, from, to}]}` | Redistribute one receiving item's dock stock across open picking demand in ONE all-or-nothing transaction. `qty` is the **desired final total** from this receiving item (0 releases the row); rows absent from the body keep their current value. Releases the shrinking rows before growing the others, so the per-item over-allocation guard can't be hit and the pool self-balances. Growing a row **amends** its existing allocation line (forced `manual = true`) rather than inserting a second row — one picking item + one receiving item stays one allocation line. 400 `invalid_qty`/`duplicate_picking_item`, 404 `receiving_invoice_item_not_found`, 409 `reallocate_rejected` (JSON body `rows: [{pickingItemId, orderNo, reason}]` for `order_not_open`/`lock_held`/`over_allocation`/`picking_item_not_found`) / `insufficient_available` (JSON body `plannedTotal`, `available`). Awaiting `allocateForReceivingOrder` afterwards — the pins are `manual` so the wipe/rebuild keeps them, but **any pool left unplaced is handed back out by the engine by priority**, so the form moves stock rather than withholding it. Spec `2026-10-12-admin-receiving-reallocate-form-design.md` |

### Admin: audit (order logs + lot history)

| Endpoint | Body → Response | Note |
|---|---|---|
| `GET /admin/receiving-orders/:id/logs` | — → `transaction_logs` rows for the order + its invoice items, newest first (actor name joined; optional `?page&pageSize&q&sort&dir` — sort whitelist `createdDate`/`actorName`/`toState` — switches to `{rows, total}`). The paged response additionally carries `putAway[]`: the order's PUT_AWAY ledger rows (`qty_type 'on_hand'` — the dock −qty pair row is omitted) as `{id, itemId, partNo, wclItemNo, qty, shelfCode, boxId, lotId, actorId, actorName, createdDate}`, oldest first — the item → shelf/box → actor put-away audit the transition log doesn't cover. 404 `receiving_order_not_found`. |
| `GET /admin/picking-orders/:id/logs` | — → `transaction_logs` rows for the order + its items + packages + shipping boxes, newest first; same optional paging/search/sort. 404 `picking_order_not_found`. |
| `GET /admin/inventory-lots/:id/history` | — → `{lot, sources[], movements[]}`: the lot's identity/batch/location/qty; `sources[]` = its `inventory_lot_sources` joined to the origin receiving orders (`{receivingInvoiceItemId, receivingOrderId, batchNo, partNo, qty, createdDate}`); `movements[]` = its `inventory_transactions` ledger rows, oldest first, with actor name and read-side-resolved references — `pickingOrderId`/`pickingOrderNo` (via the picking item, also for `'allocation'`-referenced rows), `shippingBoxId` (the earliest `picking_packages` row on the same lot + item carrying a box — packages may box after the pick, so this is the box they ended up in), `receivingBatchNo` (for `'receiving_order'`-referenced rows). 404 `lot_not_found`. Known limitation: rows nulled by a lot merge are only visible under the surviving lot's id; recompute-engine rows have no actor (background job). Spec `docs/superpowers/specs/2026-10-06-admin-audit-trail-enrichment-design.md` |

### Admin: outdated date-code scan warnings

Supplier outdated date-code warnings (spec
`docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md`):
a picking / put-away scan whose label date code (label format — WWYY for
`dateCodeFormat=wwyy` warehouses; canonicalized to YYWW before the age
check) is older than the supplier's
`supplier_profiles.outdated_limit_months` still succeeds, records an
`outdated_scan_warnings` row, and returns `outdatedWarning` on the scan
response; order completion is blocked (the explicit picking finish 409s
`unresolved_outdated_warnings` — boxing never finishes an order since
2026-10-16, spec `docs/superpowers/specs/2026-10-16-picking-boxing-manual-finish-coo-design.md`;
receiving auto-clear held) until an admin resolves the order's warnings here.

| Endpoint | Body → Response | Note |
|---|---|---|
| `GET /admin/outdated-warnings?resolved=&orderKind=` | — → `[{id, orderKind, orderId, orderNo, orderItemId, packageId, supplierCode, supplierName, wclItemNo, partNo, dateCode, limitMonths, qty, scannedBy, scannedByName, scannedAt, resolvedAt, resolvedBy, resolvedByName, resolutionNote}]` | newest first; `orderNo` = the picking order's `order_no` / receiving order's `batch_no`; `resolved=true|false` (absent = all) and `orderKind=picking|putaway` filters, 400 `invalid_resolved_param` / `invalid_order_kind` otherwise |
| `POST /admin/outdated-warnings/resolve-order` | `{orderKind, orderId, note?}` → `{resolved: n}` | whole-order resolution: stamps `resolved_at/resolved_by/resolution_note` on every unresolved row of the order (one tx) + `outdated.warning.resolved` SSE event. Idempotent — `{resolved: 0}` when nothing is pending (no event). When `n > 0` the route also re-runs the held receiving auto-clear (`retryReceivingOrderClear` — the order clears + its put-away task completes); picking has no auto-finish since 2026-10-16 — after resolving, the operator's explicit finish succeeds. 400 `invalid_order_kind` / `actor_not_found` |

### Admin: label print rules

Rules that decide which print template a picking label of a given type
uses under which conditions (spec
`docs/superpowers/specs/2026-09-16-label-print-rules-design.md`). Standard
CRUD over the `label_print_rules` table; `conditions` is a JSON object
`{combinator: "and"|"or", conditions: [{field: "org_id"|"sub_inventory"|"supplier"|"order_no"|"order_type"|"customer", operator: "eq"|"match", value: string}]}`
(min 1 condition; `org_id` value numeric; `eq` exact case-sensitive,
`match` glob with `*` — plain string = exact). 400 on an invalid
`labelType`/`conditions`.

| Endpoint | Body → Response | Note |
|---|---|---|
| `GET /admin/label-print-rules` | — → `[rule]` | sorted `priority` asc, then `created_date` asc |
| `GET /admin/label-print-rules/:id` | — → rule / 404 | |
| `POST /admin/label-print-rules` | `{name, labelType, conditions, printTemplateId, priority?, active?, remark?}` → rule | `labelType` ∈ `carton|item_box|item`; `priority` default 100, `active` default true |
| `PATCH /admin/label-print-rules/:id` | partial rule → rule / 404 | used by the admin Activate/Deactivate row action (`{active}`) |
| `DELETE /admin/label-print-rules/:id` | — → `{deleted: 1}` / 404 | |
| `POST /admin/label-print-rules/test-match` | `{conditions, keyword?, limit?}` → `{rows: [{id, orderNo, poNo, customerCode, orgId, subInventoryCode, pickingOrderType, status}], total}` | evaluates DRAFT conditions against `picking_orders` for the edit-page match preview (`testLabelPrintRuleMatch` in `src/db/labelPrint.ts`); `keyword` ILIKEs `order_no`/`po_no`; rows ordered by `priority_seq`, `limit` default 50 cap 200, `total` = count of all matches; `supplier` condition = EXISTS over `picking_items` JOIN `parts` on `wcl_item_no` (ANY item's brand matches); 400 on invalid conditions |

### Admin: inventory labels

Per-warehouse sub-inventory display labels (spec
`docs/superpowers/specs/2026-10-10-inventory-labels-design.md`). Standard CRUD
over the `inventory_labels` table. Each warehouse is a separate
instance/database, so no `warehouse_id` column.

| Endpoint | Body → Response | Note |
|---|---|---|
| `GET /admin/inventory-labels` | — → `[label]` | sorted `sort_order` asc, then `org_id` asc, then `sub_inventory_code` asc |
| `GET /admin/inventory-labels/:id` | — → label / 404 | |
| `POST /admin/inventory-labels` | `{orgId, subInventoryCode, label, sortOrder?, isActive?, remark?}` → label | `sortOrder` default 0, `isActive` default true |
| `PATCH /admin/inventory-labels/:id` | partial label → label / 404 | |
| `DELETE /admin/inventory-labels/:id` | — → `{deleted: 1}` / 404 | |

### Admin: customer receiving upload (CN)

Customer receiving order upload for CN warehouses (spec
`docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md`): the
admin uploads a customer receiving Excel (收貨確認及付款通知書), the console
parses/verifies it client-side, and the backend forwards the original file +
verified JSON to DocPal — file upload (document id), then a DocPal workflow
kick (`src/docpalWorkflow.ts`, Bearer `DOCPAL_WORKFLOW_TOKEN`, upstream

**Config gate:** every `/admin/receiving-cn*` route 404s (`not_found`) while
the flow-config `receiving-cn` step is off (the default) — the API stays
invisible until the admin enables the step, matching the PDA `/put-away-cn/*`
gating.
failure → 502 `docpal_workflow: ...`; kick-start failure after the upload
deletes the attachment). One tracking row per upload in
`receiving_cn_workflows`; a status cron (`src/jobs/receivingCnSync.ts`,
kill-switch `RECEIVING_CN_SYNC=off`, interval `RECEIVING_CN_SYNC_INTERVAL_SEC`
default 120; no-ops while the `receiving-cn` step is off) polls
`workflow_running` rows and, on workflow completion,
`finalizeCnOrder` reads the `receiving_orders_cn` trio (written by the
external upstream-sync service, matched by the workflow's generated
`batch_no` — `CN-<YYYYMMDD>-<6 alnum>`, injected into the DocPal
`excel_result_data` payload; legacy rows without one fall back to the CN 編號
`invoice_no`), flips
the order `in_hand` + stamps `arrived_at`, and creates the dedicated CN
put-away task (idempotent via the unique index on
`put_away_tasks_cn.receiving_order_cn_id`) + `receiving_cn.completed` SSE on
`/admin/receiving-cn`. Phase 2 (PDF upload + workflow kick) is implemented —
`POST /admin/receiving-cn/pdf` (row below); the DocPal OCR-result read
(`getOcrResult` in `src/docpalWorkflow.ts`) still throws
`ocr_result_not_implemented` and is unused (the data arrives through the
external upstream sync, not polled back from DocPal).

| Endpoint | Body → Response | Note |
|---|---|---|
| `GET /admin/receiving-cn?status=&page=&pageSize=` | — → `{rows, total}` | tracking list, newest first; `status` filter is repeatable (any-of), `page` default 1 / `pageSize` default 20 |
| `GET /admin/receiving-cn/orders?page=&pageSize=&search=` | — → `{rows, total, pending}` | order-centric list: paged `receiving_orders_cn` rows newest first (kind `order`; put-away task status + the matched workflow's `docpalBusinessKey`/`invoiceNo`/`supplier` joined on the generated `batch_no`, legacy fallback `invoice_no`; `arrivedByName` = users join on `arrived_by`), plus `pending` placeholders — workflows (any status) whose correlation key matches no order yet, newest first, not paged, `status: "processing"`. `search` ILIKE-filters BOTH sections (order `batch_no` / matched-workflow `invoice_no` / `supplier`; pending `batch_no`/`invoice_no`/`supplier`); `total` reflects the filter |
| `GET /admin/receiving-cn/orders/:batchNo` | — → `{order, invoices, items, putAway}` / 404 | one CN order by `batch_no` (`order` carries `arrivedByName` — the users display name of `arrivedBy`): items carry their invoice's `invoiceNo`, `additionalData`/`orderData` jsonb passthrough, `putAwayLocations` (per shelf/box summed qty from the order's CN PUT_AWAY ledger rows; empty until put-away), and `suggestedShelf` — the `additional_data.suggestedShelf` override when set, else the computed advisory suggestion (same helper as the CN task detail); the GET first runs the pending-order prepare (`prepareCnOrderDetail`) — item `org_id`/`sub_inventory_code` re-derived from `po_no` via the prefix rules (pairs missing from `org_info` are skipped) + NULL `arrived_at`/`arrived_by` stamped (no-op for non-pending orders); 404 `receiving_cn_order_not_found` (a pending-only workflow has no order) |
| `POST /admin/receiving-cn/orders/:batchNo/confirm` | — → `{id, batchNo, putAwayTaskId}` / 404 / 409 | admin confirm of a PENDING CN order (`confirmCnOrder` — the pdf path's receipt moment, since the DocPal OCR workflow never finalizes): re-runs the po_no cleanup, fills `received_qty` from `line_qty`, stamps the order `in_hand` + arrived, inserts the `put_away_tasks_cn` task (uniform item pair, org fallback = order org), audit rows + `receiving_cn.completed` SSE on `/admin/receiving-cn` + `/put-away-tasks`; 409 `order_not_pending` otherwise; shares `receiveCnOrderTx` with the cron `finalizeCnOrder` |
| `POST /admin/receiving-cn/orders/:batchNo/reset` | — → `{id, batchNo, previousStatus}` / 404 / 409 | admin "Reset order" (`resetCnOrder`) for re-testing the flow: every invoice item's scan columns go back to unresolved (same shape as the per-item `scan_reset`) with `received_qty`/`picked_qty`/`put_away_qty` zeroed; the order's `receiving_cn_scan_events` and its CN put-away task are deleted; the order returns to `pending` with `arrived_at`/`arrived_by` cleared. 404 `receiving_cn_order_not_found`, 409 `order_already_clear` when `clear` (stock already in `inventory_lots` — out of scope). Audit transition log (`metadata {reset: true}`) + `receiving_cn.updated` SSE on `/admin/receiving-cn` + `/receiving-cn-scan-tasks` + `/put-away-tasks`. Spec `docs/superpowers/specs/2026-11-07-admin-order-reset-design.md` |
| `GET /admin/receiving-cn/orders/:batchNo/logs` | — → log rows or `{rows, total}` / 404 | audit trail, mirroring `GET /admin/receiving-orders/:id/logs`: order rows (`receiving_order_cn`) + the order's item rows (`receiving_invoice_item_cn`, `partNo` = the item's part no) + the finalize task/workflow rows referencing the order (`metadata.receivingOrderCnId`); `?page/?pageSize` (default 50/max 200) switch to `{rows, total}`, `?q=` ILIKE over actor/from/to/entity/metadata, sort whitelist `createdDate`/`actorName`/`toState`; 404 `receiving_cn_order_not_found` |
| `PATCH /admin/receiving-cn/items/:id` | `{partNo?, wclItemNo?, poNo?, lineQty?, dateCode?, lotCode?, coo?, cow?, ctnNo?, subInventory?, suggestedShelf?}` → updated item row / 404 | editable CN item fields, mirroring `PATCH /admin/receiving-invoice-items/:id`: string values trim, `null`/`""` clears, absent keys unchanged, zero keys 400; `lineQty` must be a positive integer (400 otherwise; `received_qty` follows while still 0); a `wclItemNo` change wins over `partNo` — a unique parts-master match supplies the canonical `wcl_item_no` and applies its `part_no` alongside (unknown wcl stores as typed, part_no untouched); a bare `partNo` change re-resolves `wcl_item_no` from `parts` (NULL when no unique match); a non-null `subInventory` must exist in `org_info` for the item's org (composite pair) — 400 `invalid_sub_inventory`; `suggestedShelf` read-modify-writes the `additional_data.suggestedShelf` override (`null`/`""` clears it back to the computed suggestion; free-text, advisory) — the detail's `suggestedShelf` prefers the override; one tx + one `transaction_logs` row per changed field (entityType `receiving_invoice_item_cn`, to_state `admin_edit`, metadata field/from/to); 404 `receiving_cn_item_not_found` |
| `GET /admin/receiving-cn/:id` | — → tracking row incl. the verified `payload` items / 404 | |
| `POST /admin/receiving-cn/excel` | JSON `{files: [{filename, brand?, payload}]}` → 201 `{orders: [{id, batchNo}]}` | local excel-decode upload (spec `docs/superpowers/specs/2026-11-08-receiving-cn-excel-local-upload-design.md`): the admin browser decodes the customer receiving confirmation sheet(s) and posts the verified payloads; one tx per upload creates per file a PENDING CN order — order + one invoice + items (`line_qty` = sheet qty, `received_qty` 0, `ctn_no` = 箱號, org/sub from the `po_no` prefix rules, `po_line` = sheet row index, parts-master backfill) + a `completed` tracking row (`phase: "excel"`, `invoice_no` = sheet 編號, docpal ids NULL so the status cron ignores it). `payload` validation as before (header strings, non-empty `items`, `partNo`/`poNo` non-empty, positive-integer `qty`); optional `brand` override (must match `^[A-Z][A-Z0-9]{1,9}$` after uppercasing) drives `batch_no = invoice_no = [brand]-yyyymmdd-seq` in the shared `nextCnBrandedNo` namespace — blank derives the brand from the first item's parts-master `brand` (400 when no unique match). The admin confirm → PDA 收貨掃描 chain then runs as on the pdf path — 400 `invalid_payload: ...` |
| `POST /admin/parts-lookup` | JSON `{keys: string[]}` (max 2000) → `{matches: [{key, found, brand}]}` | batch parts-master existence/brand check for the CN excel upload — the verify table mounts one combobox per item row so per-row `GET /admin/parts` sweeps stall the submit (client batches + caches via `apps/admin/composables/usePartsBrandCheck.ts`). Keys match either `parts` column after the canonical normalize/unwrap (same rule as `resolvePartByKey`); `found=false` for unknown or ambiguous (>1 group) keys; echoes input keys in order — 400 `invalid_payload` (`src/db/partsLookup.ts` `lookupPartKeys`) |
| `POST /admin/receiving-cn/pdf` | multipart `file` (PDF only; repeat the field for multiple PDFs — one upload = one workflow carrying all of them) → 201 `{id}` | phase 2: same upload + kick + tracking row but the kick sends the file entries under `variables.pdfFiles` (no `excel_result_data` — DocPal OCR extracts the data inside the workflow; verification happens on the synced order's detail page, not in DocPal); tracking row `phase: "pdf"`, `invoiceNo`/`supplier` NULL, `payload: {}`, `filename` = ", "-joined names, `docpal_document_id` = first file's document id; `batch_no` = `TE-yyyymmdd-[seq]` (`nextCnBrandedNo` — the shared brand namespace with manual receipts, max suffix across `receiving_invoices_cn.invoice_no` / `receiving_orders_cn.batch_no` / `receiving_cn_workflows.batch_no`) and is sent for the order ↔ workflow join — 400 `file_required` / `invalid_file_type`, 500 `docpal_workflow_definition_not_configured` (`DOCPAL_CN_PDF_WORKFLOW_ID`) / `docpal_workflow_token_not_configured`, 502 `docpal_workflow: ...` |

JWT bearer (HS256, `hono/jwt`, secret from `AUTH_SECRET`, 12 h TTL) required on
all routes except `/health`, `GET /latency-ping`, `POST /auth/login`,
`POST /auth/login-token`, and `/dev/lab*` (`isOpenPath` in
`src/auth/middleware.ts`); `GET /events`
also accepts `?token=` (EventSource can't set headers). Users belong to groups
via `user_group_members` (many-to-many); `users.role` is gone. Login is always
delegated to the DocPal API (`DOCPAL_URL` required) and local users are
auto-provisioned (spec `docs/superpowers/specs/2026-08-13-docpal-auth-design.md`).

**Per-user sub-inventory scope** (spec
`docs/superpowers/specs/2026-09-11-user-subinventory-scope-design.md`): the
scope set via `/auth/me/profile` / `/admin/user-profiles` filters the
receiving and picking list + detail reads server-side, resolved per request
from the JWT actor's username. A row carrying `(org_id, sub_inventory_code)`
passes when `sub_inventory_code` IS NULL or the pair is in the scope;
empty/absent scope = unrestricted; composes with `allowedOrgIds` by AND.
Reads only — mutations, stock search, put-away, goods verify and SSE events
are unaffected.

`GET /allocation/status` → in-memory status of the allocation runner
(only snapshot restores queue there now — recompute runs are synchronous and
never appear here): `{running, queued, trigger, startedAt, lastRun | null}` where
`lastRun` = `{demands, fullyAllocated, partiallyAllocated, allocationsCreated,
allocationsRemoved, skippedReceivingSources, finishedAt, durationMs, trigger}`.
Pair with the `allocation.started` / `allocation.finished` SSE events
(`GET /events`) for live "allocation running" indicators.

## Admin: master-data & misc catalog

Generic CRUD (`createCrudRouter`, `src/routes/admin/crud.ts`) — every resource
below serves **5 CRUD** = `GET /admin/<res>` (whole array, or `{rows, total}`
with `?page=&pageSize=&q=&sort=&dir=` where the router declares `search` —
`parts`, `net-weight-formulas`), `GET /admin/<res>/:id` (404 `not found`),
`POST /admin/<res>` → 201 row (optional client-supplied `id`),
`PATCH /admin/<res>/:id` → row (400 `no fields to update`),
`DELETE /admin/<res>/:id` → `{ok: true}`. DB errors map to 409 `duplicate` /
`in use or invalid reference` and 400 `missing required field`. Admin-group
membership is required on `/admin/*` except the three PDA reference reads
(`GET /admin/shelves` / `suppliers` / `countries`). Manual allocation, audit,
outdated warnings, task assignments, label print rules, inventory labels, user
profiles and CN admin have their own sections above; shipper + picking-list
downloads, cancel records, ad-hoc put-away and bug reports are documented in
their flow sections below.

| Resource (`/admin/…`) | Methods | Note |
|---|---|---|
| `shelves` | 5 CRUD + `POST /shelves/batch-import` | **pk = `code`**; `code`/`displayName`/`zone`/`warning`/`subInventoryScopes` (`[]`/null = shared shelf); batch-import `{shelves:[…]}` → `{created, updated, skipped, errors}` — creates-or-updates by code in one tx, a null text field on an existing row means unchanged |
| `suppliers` | 5 CRUD (pk `id`) | `code` + `name` required, `shortName?` |
| `supplier-profiles` | 5 CRUD (pk `id`) | scan-template lookup + label-decode source (`qrTemplate`/`qrTemplateConfig`/`qtyEncoding`/`dateCodeEncoding`/`barcodeTypes`, `outdatedLimitMonths` default 12); writes invalidate the decode cache |
| `parts` | 5 CRUD (pk `id`, list sorted `partNo`) | ~100k upstream-synced rows — `part_no` NOT unique (`wcl_item_no` is the business key); paged list (`q` ILIKEs part_no/wcl_item_no/description/brand, single-value `?brand=` ILIKE filter); `brand`/`partNo`/`wclItemNo` required |
| `countries` | 5 CRUD (**pk = `code`**) | `country_list` COO/COW master; create `code`+`name` (`shortCode?`), PATCH edits only `name`/`shortCode` |
| `box-sizes` | 5 CRUD (**pk = `code`**) | `box_size_list`; PATCH edits only `description` |
| `date-code-periods` | 5 CRUD (pk `id`) | `date_code_counter_periods` month-counter cycles (`encoding`, `direction` `forward\|backward`, `counterFrom`/`counterTo`, `periodStart` `YYYY-MM-01`); writes invalidate the decode cache; public read = `GET /date-code-periods` (§Scan support) |
| `net-weight-formulas` | 5 CRUD (pk `id`) | per-`partNo` `qty`→`weight` pairs (all required); paged/searchable list (`q` ILIKEs `part_no`) |
| `shelf-boxes` | GET · GET `/:id` · POST · PATCH `/:id` · DELETE `/:id` | custom admin editor over `shelf_boxes` (list carries `itemCount`/`totalQty`; status `open\|closed\|verified`) — the PDA put-away box routes are the un-prefixed `/shelf-boxes*` (§Put-away) |
| `sub-inventories` | GET · GET `/:id` · POST · PATCH `/:id` · DELETE `/:id` | `org_info` store rows addressed **`orgId:code`** (the composite business key, not the id PK); POST needs `orgId`+`code`, PATCH edits `subinvDescription`/`officeCode`/`organizationId` |
| `sub-inventory-share-groups` | GET · PUT `/:id` · DELETE `/:id` | `sub_inventory_share_members`, id = **`orgId:code`**; PUT upserts a membership (empty/null `shareGroup` removes it instead) |
| `customer-profiles` | 5 CRUD (**pk = `code`**) + `PUT /:code/customers` | jsonb `customers` array = party names — one name may live in ONE profile (app-level 409 `customer_already_assigned: <name>`); the PUT atomically edits membership `{add?, remove?}` |
| `customer-accounts` | GET | upstream-synced `customer_accounts` read-only list; `?q=` ILIKEs party_name/account_number, `?partyName=` exact |
| `users` | GET | `[{id, username, displayName, groupCodes}]` for the badge-printing page — never passwords (user/group management lives in DocPal) |
| `picking-orders/test-create` | POST | `{orderNo, orgId, subInventoryCode, customerCode?, shipTo?, poNo?, deliveryDate?, prioritySeq?, pickingOrderType?, remark?, items:[{partNo, qty, lineNumber?}]}` → `{id, orderNo, items[]}`; `[TEST]` remark prefix, order `pending`, then a synchronous scoped allocate (failure leaves it unallocated). 400 empty items / bad org+sub-inventory pair |
| `picking-orders/:id/export` · `picking-orders/:id/test` | GET · DELETE | export the order + items as a JSON template / delete a test order (only with the `[TEST]` remark prefix; cascades items → packages → allocations) |
| `flow-config` | GET · PUT | read the resolved flow config; PUT validates + writes the `warehouse_config` row `"flow"` + emits SSE `config.updated` (topic `/config`); `FLOW_CONFIG` env override wins at boot (spec `docs/superpowers/specs/2026-08-12-admin-flow-config-design.md`) |
| `picking-orders/:id` · `receiving-orders/:id` · `receiving-invoice-items/:id` | PATCH | admin header/field edits (`src/routes/admin/flowEdits.ts`): order fields, the 4-value receiving status override (`/receiving-orders/:id/status` sets `arrived_at/by`, no stock/allocation write), item batch-field edits |
| `receiving-mismatches` | GET | the admin open-mismatch queue across orders (`src/routes/admin/issues.ts`), feeds `apps/admin/pages/issues/receiving.vue` |
| `receiving-invoice-items/:id` | DELETE | remove an un-worked receiving item (409 `item_work_started` once scanned) |
| `part-ledger` | GET | cross-order allocation + movement ledger for a part (`src/routes/admin/partLedger.ts` → `src/db/partLedger.ts`), feeds `apps/admin/pages/item-ledger.vue` |
| `app-download` · `app-download/regions` · `app-download/file` | GET | APK distribution: version metadata + region list + the signed release APK (`apps/backend/public/apk`, gitignored), consumed by `apps/admin/pages/app-download.vue` |

## Receiving

Implemented: `GET /receiving-orders`, `GET /receiving-orders/:id`,
`GET /receiving-orders/:id/picking`, `POST /receiving-orders/:id/confirm-arrival`
(accepts `pending` + `provisional_received`), `POST /receiving-orders/:id/scan`,
`GET /receiving-invoice-items/:id/mismatch`,
`POST /receiving-invoice-items/:id/mismatch`,
`PATCH /receiving-invoice-items/:id/mismatch`,
`POST /receiving-invoice-items/:id/mismatch/confirm`,
`POST /receiving-invoice-items/:id/mismatch/cancel` (see
`apps/backend/src/routes/receiving.ts` + `src/db/receiving.ts` +
`src/decode/codecs.ts`; confirm-arrival applies full receipt + date-code
fallback, scan applies QR-template-parsed partial receipts moving the order to
`provisional_received`, both write RECEIVE_TO_DOCK ledger rows + transition
logs (confirm-arrival then awaits its scoped recompute — see below; scan
triggers no recompute); scans carrying a serial (`serialNo`
template group or explicit body field) are deduped per order + part via
`receiving_scan_labels` — a repeat of the same part's serial is 409 `label_already_scanned`).

| Endpoint | Description |
|---|---|
| `GET /receiving-orders?status=&search=&hasInvoices=&limit=&offset=&sort=&dir=` | Paged list → `{rows, total}`. Rows: `{id, refNo, status, deliveryDate, dateCode, supplierCode, supplierName, warehouseCode, warehouseSectionCode, subInventoryCode, invoiceCount, itemCount, remainingItems, pendingPickingOrders}`. `remainingItems` = items with `put_away_qty < qty`; `pendingPickingOrders` = distinct pending/picking/allocated orders allocated to this RO (via `allocations.receiving_order_id` or via receiving item). `?status=` accepts a comma-separated list, matching any of the listed statuses (`?status=pending` still works); `search` = case-insensitive substring on `batchNo`/`supplierCode`/`supplierName`/`invoice_no`; `hasInvoices=1` hides orders with no invoices (upstream placeholders — the admin list always passes it); `limit`/`offset` page the result (omit `limit` for all rows); `total` = full match count. `sort` is a whitelist of the admin receiving-list column keys (`batchNo`, `status`, `orgCode`, `supplier`, `deliveryDate`, `invoiceCount`, `invoiceNos`, `itemCount`, `remainingItems`, `pendingPickingOrders`, `createdDate`, `lastUpdateDate`) with `dir` `asc`/`desc`; unknown keys fall back to the default newest-first order, which is also the tiebreaker tail. Rows also carry `invoiceNos` (comma-joined distinct invoice numbers) and `displayName` (the order name per the `receivingOrderNameTemplate` flow-config template, §Flow config). Per-user sub-inventory scope (see §Auth): when the caller has a scope set, an order stays visible only when it has no items or any item in scope — exact `(org_id, sub_inventory_code)` pair, or a NULL `sub_inventory_code` item whose org is covered by the scope (NULL acts as every sub-inventory of its org; list aggregates still computed over all items). |
| `GET /receiving-orders/:id` | Detail: `{order..., displayName (order name per the `receivingOrderNameTemplate` flow-config template, §Flow config), supplier{...profile fields}, invoices[{..., items[{..., part, allocatedQty, mismatch}]}]}` — nested; `allocatedQty` embedded per item (no `allocated_by_item` map). Per-user scope: 404 when the order is out of the caller's scope; the returned items are additionally filtered the same way (exact pair, or NULL-sub item in a scope-covered org). |
| `GET /receiving-orders/:id/picking` | Picking section: `pickingOrders[{id, refNo, status, shipTo, customerCode, items[{id, partId, partNo, qty, pickedQty, allocatedQty, requiredDateCode, allocations[{id, qty, lot{shelfCode, shelfWarning, boxId, dateCode, lotCode, coo, cow}, receivingInvoiceItemId, boxId}], packages[{id, qty, dateCode, lotCode, verified, shippingBoxId}], transitionLogs[{fromState, toState, actorId, createdDate}]}], boxes[{id, status, boxSize, grossWeight, netWeight}]}]`. `lot.shelfWarning` = `shelves.warning` of the lot's shelf (null when none). |
| `POST /receiving-orders/:id/confirm-arrival` | `{}` → order with `status: "in_hand"` + `allocation` (scoped recompute summary `{demands, fullyAllocated, partiallyAllocated, allocationsCreated, allocationsRemoved, skippedReceivingSources, partKeys, changed, durationMs}`, or `null` when the scoped recompute failed — demand stays stale until the next Re-allocate); applies receipt, writes txns, then awaits `allocateForReceivingOrder` (same rules as `allocateAll`, restricted to the order's part keys — parts never compete, so other parts are provably untouched). |
| `POST /receiving-orders/:id/scan` | `{raw}` (or parsed fields, incl. `serialNo`) → server-side parse/match/apply; single match auto-applies, else candidates. A parsed/explicit `serialNo` (S-key) is recorded in `receiving_scan_labels` (unique per order + part) — a repeat serial for the same part → 409 `label_already_scanned`; scans without a serial skip dedup. Supersedes `scan-candidates` (client no longer mirrors matching logic). |
| `GET /receiving-invoice-items/:id/mismatch` | Active mismatch or `null` (item-keyed, on the new flat mismatch columns). |
| `POST /receiving-invoice-items/:id/mismatch` | `{reason, mismatchQty?, wrongPartNo?, note?}` → item. |
| `PATCH /receiving-invoice-items/:id/mismatch` | Edit pending mismatch. |
| `POST /receiving-invoice-items/:id/mismatch/confirm` · `/cancel` | `{}` → item. |
| `GET /admin/receiving-orders/:id/shipper` | Admin console: shipper `.xlsx` attachment — receipts grouped by part, each group one merged block (one bottom-aligned `invoice_no ctn_no` item row per carton; live mode: one slot column per distinct picking order — all customers on the block's first row, all order refs on the second, each carton's allocation qty in its order's column on its own row, repeat same-order allocations summed; finished mode overlays customers/refs/qtys on the block's last three rows) with per-block allocation slots; the group header cell shows the related-order allocated breakdown by source lot (`[shelf]-[date_code]/[qty]` entries, date_code omitted when NULL; Σ allocations of the part on the picking orders tracing back to this receiving order, SHELF STOCK only — receiving/dock sources are excluded, which also covers the own-order exclusion since those are already the block's slot columns; stock lots stay even when lot-traced to this batch — spec `docs/superpowers/specs/2026-09-16-admin-receiving-shipper-related-allocated-design.md`, stock-only scope + format refined by the split spec); Total/Balance per group; whole-order (no `ctn_no`) allocations close each group on an `(order-level)` block. Read-only — no in-request recompute (use `POST /admin/receiving-orders/:id/reallocate` first if stale). `?mode=finished` (for `clear` orders): same layout, slots from actual `picking_packages` (direct receiving-item picks + lot-traced via `inventory_lot_sources`) instead of live allocations, no group header cell. Split by location is the only mode: one xlsx per section of the order's items — items whose `(org_id, sub_inventory_code)` is a `sub_inventory_share_members` member merge into one section keyed by the `share_group` string (mirroring allocate.ts, case-insensitive code match; the section keeps the lowest member pair for naming/ordering), ungrouped pairs and NULL `sub_inventory_code` stay their own sections — a zip (`shipper-<batchNo>.zip`, members `shipper-<batchNo>-org<orgId>-<subInventoryCode|no-subinventory>.xlsx`) when the order spans >1 section, the plain xlsx under the renderer's file name when it spans one (an itemless order falls back to the combined document); whole-order/package slots attribute by the picking order's `(org_id, sub_inventory_code)` pair, related rows by the source lot's own pair, both widened to share-group equivalence and falling back to the part's first section (spec `docs/superpowers/specs/2026-09-21-shipper-split-by-location-design.md` + `docs/superpowers/specs/2026-09-30-shipper-group-by-share-group-design.md`). Spec `docs/superpowers/specs/2026-09-14-admin-receiving-shipper-download-design.md`. |
| `GET /admin/picking-orders/:id/picking-list` | Admin console: picking-list `.xlsx` attachment (`picking-list-{orderNo}.xlsx`, sheet `Picking List`) — title + order-info block, then one flat row per allocation sorted by shelf/box: lot sources render shelf / box / date code / lot code / COO-COW / source org+sub-inventory; dock sources render `Receiving {batchNo}` + `(dock)`; `UNALLOCATED` shortfall row when an item is partially allocated, `(no allocation)` row when not at all. Items sharing a part number are merged into ONE block (summed Item/Allocated/Picked Qty, allocation rows from all lines, one blank separator between part blocks), and allocations from the same location + date code + COO merge into one row with a summed Alloc Qty. Read-only — no in-request recompute (use `POST /admin/picking-orders/:id/reallocate` first if stale). Spec `docs/superpowers/specs/2026-09-14-admin-picking-list-download-design.md`. |
| `GET /admin/picking-orders/:id/picking-list-document` | Same picking-list content as the `.xlsx` above but as the raw `PickingListDocument` JSON (`head` / `generatedAt` / `groups`) — consumed by the admin client-side PNG print renderer so the grouping/merge logic stays single-source server-side. Same read-only/no-recompute contract, same 404 `picking_order_not_found`. Spec `docs/superpowers/specs/2026-11-06-admin-document-png-print-design.md` (CR-049). |

Changes vs old: `/picking` returns nested DTOs with logs embedded per item —
`POST /picking-items/transition-logs` dies; scan-candidates dies (server-side
matching); confirm-arrival records the actor; mismatch runs on the new flat
item columns (no separate mismatch table).

## Scan support

Implemented: `GET /scan-templates` + `GET /date-code-periods` (see
`apps/backend/src/routes/scantemplates.ts` + `src/db/scantemplates.ts` +
`src/db/dateCodePeriods.ts`), `POST /scan/decode` (see `src/routes/decode.ts` +
`src/decode/`, spec
`docs/superpowers/specs/2026-11-03-backend-scan-decode-design.md`) and the
cross-flow `GET /boxes` lookup (`src/routes/boxes.ts`).
Receiving scans parse server-side, and since the 2026-11-03 cutover picking /
put-away / measuring / shelf-exchange scans decode through `POST /scan/decode`
(`utils/labelDecode.ts`) — `GET /scan-templates` now mainly feeds the hardware
scanner symbology whitelist (`barcodeTypes`) and the admin supplier editor. `POST /scan/decode` is the new DB-backed decode authority
(templates + `date_code_counter_periods` + flow-config `dateCodeFormat`); the
client-side copies retire when the PDA/admin cutover lands.

| Endpoint | Description |
|---|---|
| `GET /scan-templates` | → `[{supplierCode, qrTemplate, qtyEncoding, dateCodeEncoding, barcodeTypes, brands}]`, every profile ordered by `supplier_code`; `qrTemplate` null when the supplier has none (clients filter). `brands` = parts.brand values the supplier covers — clients try brand-matching templates first. `dateCodeEncoding` (e.g. `koa_month_counter`) decodes the template's dateCode group. |
| `GET /date-code-periods` | → `[{encoding, direction, counterFrom, counterTo, periodStart}]`, every `date_code_counter_periods` row ordered by `period_start` — public read of the label month-counter cycles so the PDA decodes rolling counters (`decodeKoaDateCode`) identically to the server; admin edits go through `/admin/date-code-periods` (`src/routes/scantemplates.ts`). |
| `GET /boxes?q=` | → `[{kind: "shipping"\|"shelf", id, status, createdDate, orderNo}]` — cross-flow box lookup by id substring over `shipping_boxes` + `shelf_boxes` (a bare seq like `7` / `0007` matches), newest first, capped at 50; blank/absent `q` = the latest 50 boxes. Read-only, no filters beyond `q` (`src/routes/boxes.ts` + `src/db/boxes.ts`). |
| `POST /scan/decode` | Server-side decode of a raw label value: body `{raw, targets?, supplierCode?, brands?}` → PDA `OcrParseResult` shape minus `raw` (`{matched, parsed, options, supplier?}`); templates, month-counter periods and `dateCodeFormat` are read from the DB/config (see `src/decode/`, spec `docs/superpowers/specs/2026-11-03-backend-scan-decode-design.md`). `matched:false` when no template hits — the client's OCR-text heuristics then take over. NCC drawing codes (the numeric itemId on Chemi-Con labels) are resolved to `wcl_item_no` via `wcl_part_drawno` when the label otherwise can't match — including past the targets gate (spec `docs/superpowers/specs/2026-11-03-ncc-drawno-part-lookup-design.md`). `resolveMaster:true` no longer exists — identity translation is BUILT into the decode: matched TE-brand labels print a truncated MPN, so `decodeScan` resolves the real `part_no`/`wcl_item_no` from the parts master (normalized equality on `idx_parts_norm_*`, then `ILIKE '%…%'` on the `pg_trgm` GIN indexes; unique hit, or unique hit among `targets`, replaces the parsed identity; one part_no stored under several wcl keys (the TE-/TE+ dupes) resolves to a stored key, preferring the `AMP(...)`-wrapped row (business tie, 2026-11-04) — the fake derived wcl never survives; sibling-part collisions without a target match keep the label values. |

## Label printing

Implemented: `GET /labels-data` (see `apps/backend/src/routes/labels.ts` +
`src/db/labels.ts`). One aggregate read behind the web `/print-labels` page:
shelf boxes (with current lot contents), distinct shelf codes, every
open receiving order's invoices/items, current shelf-stock lots, and
`pickLabels` — one label per open-order allocation with the exact share qty
(a lot/carton split across orders gets one label per share). Part-label
`qrValue`s are built per the supplier QR template (`encodeKoaQty` /
`buildKoaLabelRaw` in `src/decode/codecs.ts`; null for template-less
suppliers); receiving items and lots carry `pickingOrderRefs` for page
filtering. Read-only.

| Endpoint | Description |
|---|---|
| `GET /labels-data` | → `{generatedAt, shelfBoxes, shelfCodes, receivingOrders, shelfLots, pickLabels}`. |
| `GET /parts` | `?search=` (ILIKE on part_no/wcl_item_no/description) `&brand=` (ILIKE) → `{parts: [{partNo, brand, description}]}` — parts master search capped at 50 rows (the full table is ~100k, never shipped whole); one row per non-unique `part_no` (`min()` collapse), ordered; feeds the PDA `/print-product-label` type-to-search fields (`searchLabelPrintParts`, `src/db/labels.ts`). |

## Printing proxy

Implemented: `GET /print/printers`, `POST /print/dynamic`, `POST /print/files`,
`GET /print/jobs/:jobId` (see `apps/backend/src/routes/print.ts` + thin upstream
client `src/print.ts`). Pass-through to the label-printing-center print service
(base URL from `PRINT_API_BASE_URL`, default `http://localhost:9003`) so
clients never call it directly; upstream errors come back as 502 with the
upstream message. `POST /print/dynamic` validates `templateId` + non-empty
`printingParams` before forwarding. No preview endpoints. Upstream API doc:
`docs/backend/print-service.md`.

| Endpoint | Description |
|---|---|
| `GET /print/printers` | Agent printers: upstream `GET /api/v1/usb/agent-printers`, keeping only `isActive` entries, flattened per service with `serviceId` + `deviceKey` (for the `POST /picking-orders/:id/label-print` picker). |
| `POST /print/dynamic` | Print a template by `{templateId, printingParams, printerName?, copies?, mode?, orientation?}` → upstream `data` incl. `jobs[]`. |
| `POST /print/files` | Direct file print — multipart upload or JSON forwarded verbatim → job object. |
| `GET /print/jobs/:jobId` | Current status of one print job. |

## Put-away

Implemented: `GET /put-away/candidates`,
`GET /receiving-orders/:id/put-away`,
`POST /receiving-orders/:id/put-away-scans`, `DELETE /put-away-scans/:scanId`,
`POST /receiving-orders/:id/put-away-commit`,
`POST /shelf-boxes`,
`DELETE /shelf-boxes/:id`, `POST /shelf-boxes/:id/scans`,
`DELETE /shelf-boxes/:id/scans/:scanId`,
`POST /shelf-boxes/:id/add-all-unboxed`, `POST /shelf-boxes/:id/close` (see
`apps/backend/src/routes/putaway.ts` + `src/db/putaway.ts`; staging-box model —
scans are `shelf_box_items` rows in the per-order `shelf_code IS NULL` box,
assign materializes the inventory lot stamped with the shelf's
warehouse/section/sub-inventory + `inventory_lot_sources` + `put_away_qty` and
writes two PUT_AWAY ledger rows (dock −qty / on_hand +qty), remove reverses,
assign/remove/add-all trigger no recompute (manual-only), in-hand orders auto-clear
when nothing remains). Shelf-direct flow (spec
`docs/superpowers/specs/2026-10-06-put-away-shelf-direct-design.md`): the PDA
no longer names boxes — `put-away-scans` accepts `shelfCode` (mutually
exclusive with `shelfBoxId`, 400 `both_shelf_box_and_shelf_code`) and commits
straight onto that shelf, the order's box there found-or-created invisibly
(`ensureOrderShelfBoxTx`: reuse the open box holding this order's items →
adopt an empty open box on the shelf → create, order pair); the new
`put-away-commit` assigns every pending scan of the order (optionally
`scanIds`-filtered) onto the shelf in ONE transaction, returning `{count,
qty}` (`count: 0` = valid empty result). Task mode (spec
`docs/superpowers/specs/2026-08-10-put-away-tasks-design.md`): when flow
config `steps.put-away.autoCreateTasks` is on, confirming an arrival
creates a `put_away_tasks` row (one per order, `pending`, unique per order) in
the same tx; the auto-clear completes it. The PDA then works from the task
queue instead of the derived candidates list.

| Endpoint | Description |
|---|---|
| `GET /put-away/candidates` | List of receivable orders with per-order received/unboxed counts; rows also carry `displayName` (receivingOrderNameTemplate), `invoiceNos`, `deliveryDate`, `dateCode` for the PDA list-row templates, and `outdatedWarningCount` (unresolved outdated date-code scan warnings, spec 2026-10-07). Rows also carry `assignee` (LEFT JOIN `put_away_tasks`) and are filtered by it — an order whose task is assigned to another user is hidden (spec 2026-11-01). |
| `GET /put-away-tasks?status=` | Task queue (task mode), oldest first: `{id, status, receivingOrderId, batchNo, displayName, supplierCode, supplierName, invoiceNos, deliveryDate, dateCode, orgId, subInventoryCode, receivedItems, unboxedItems, outdatedWarningCount, createdDate}`. `displayName` = the order name per the `receivingOrderNameTemplate` flow-config template; `outdatedWarningCount` = unresolved outdated scan warnings on the order (spec 2026-10-07). Rows carry `assignee`; the list (and the detail below) are filtered by it — NULL visible to all, set = only that username (spec 2026-11-01). |
| `GET /put-away-tasks/:id` | The per-order put-away aggregate + `{task}`; 404 `put_away_task_not_found` (also when the task is assigned to another user). |
| `GET /receiving-orders/:id/put-away` | One aggregate: `{order, items[], lots[], scans[], boxes[{..., items[]}], outdatedWarningCount}` for the put-away detail screen. `items[]` = the order's expected (receivable) invoice items `{id, partId, partNo, qty, receivedQty, pickedQty, putAwayQty, allocatedQty, remainingQty, dateCode, lotCode, coo, cow}` with `remainingQty = received − picked − put_away − allocated − staged` (the candidates-list formula), each carrying the advisory per-item `suggestedShelfCode`/`suggestedBoxId`/`suggestionReason` (existing-stock strategy unless `steps.put-away.suggestShelf=off`). `scans[]` = ALL of the order's scans, pending first: pending scans carry `shelfCode`/`boxId` null, committed scans carry the shelf + (invisible) box they landed in. `outdatedWarningCount` = unresolved outdated date-code scan warnings on the order (spec 2026-10-07). |
| `POST /receiving-orders/:id/put-away-scans` | `{receivingInvoiceItemId, qty, dateCode?, lotCode?, coo?, cow?, shelfBoxId?|shelfCode?}` → complete scan row (no fix-up query) + `outdatedWarning` (`{supplierCode, dateCode, limitMonths} | null` — set when the label's date code is older than the order supplier's `outdated_limit_months`; the scan still succeeds and a warning row is recorded, spec 2026-10-07). With `shelfCode`/`shelfBoxId` the scan commits straight onto the shelf/box in the same tx (lot + ledger); without it the scan stays pending (staging). 409 `scanned_qty_exceeds_remaining` when over the remaining qty. |
| `POST /receiving-orders/:id/put-away-commit` | `{shelfCode, scanIds?}` → assign every pending scan of the order (or just the given `scanIds`) onto the shelf in one tx → `{count, qty}`; `count: 0` is a valid empty result. NOT blocked by outdated warnings — operators keep working; instead the auto-clear (`tryMarkReceivingOrderClear`, which also completes the put-away task) is HELD while the order has unresolved outdated scan warnings, until an admin resolves them (`POST /admin/outdated-warnings/resolve-order` re-runs the clear). |
| `DELETE /put-away-scans/:scanId` | `{}` → hard-delete a staged scan (mis-scan correction); 409 `scan_not_in_staging_box` for boxed scans (use remove-from-box). |
| `POST /shelf-boxes` | `{receivingOrderId, shelfCode?}` → box. Kept for admin/debug — the shelf-direct PDA flow no longer calls it (boxes are found-or-created invisibly via `shelfCode`). |
| `POST /shelf-boxes/:id/scans {scanId}` · `DELETE /shelf-boxes/:id/scans/:scanId` | Assign / remove one scan (admin/debug; also the reversal path for committed stock). |
| `POST /shelf-boxes/:id/add-all-unboxed` | `{}` → `{count}`. (Admin/debug — the PDA commits via `put-away-commit`.) |
| `POST /shelf-boxes/:id/close` · `DELETE /shelf-boxes/:id` | Close / cancel (cancel body `{}`). |

Changes vs old: one aggregate read replaces the 3-call stitch; the actor comes
from the JWT, never the body; verbs reduced to membership + lifecycle actions; put-away
materializes inventory lots (concept: lot + `inventory_lot_sources` +
`inventory_transactions` PUT_AWAY rows).

### Put-back tasks (`put-back` flow step)

Cancel-invoice queue (spec `docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md`):
stock already picked for an upstream-cancelled order/line returns to a shelf. Tasks
are created by the `jobs/cancelInvoiceSync.ts` cron (watches the externally-managed
`cancel_invoice` / `cancel_invoice_tn` tables; `CANCEL_INVOICE_SYNC=off`,
`CANCEL_INVOICE_SYNC_INTERVAL_SEC` default 120) — never by an API. Outcomes land in
`cancel_records` (admin read below); the cron never writes back to the upstream tables.

| Route | Description |
|---|---|
| `GET /put-back-tasks?status=` | Queue rows `{id, status, pickingOrderId, orderNo, totalQty, itemCount, createdDate, assignee}`; `assigneeFilter` scoped (NULL visible to all). |
| `GET /put-back-tasks/:id` | Detail + `items[]` (one row per picked `picking_packages` row: part/qty/batch + source `shelfCode` — null for dock-sourced picks). 404 `put_back_task_not_found` (also when assigned to another user). |
| `POST /put-back-tasks/:id/complete` | Body `{shelfCode?}` — fallback shelf for items without a source shelf. One tx: status claim (2nd call → 409 `put_back_task_not_pending`), missing shelf → 409 `put_back_shelf_required`; credits each item onto its source shelf (or the fallback) via the shared `creditLotTx` lot find-or-create + `ADJUST on_hand +qty` ledger (`txnReason "cancel put-back"`), invalidates any shelf-box verification touched, stamps items `put_back`. No allocation recompute (manual-only). |
| `GET /admin/cancel-records?source=&outcome=` | Ingest log rows `{id, source, sourceId, invoiceNum, tnLineId, orderNo, pickingOrderId, outcome, message, status, sourceTs, createdDate, lastUpdateDate, putBackTasks}` (newest first, max 500; single-value filters). Outcome `no_match` rows are hidden — cron audit only. Outcomes shown: `cancelled | cancelled_with_putback | ignored | error`. |

`/admin/task-assignment` accepts `flow=put-back`. SSE: `put_back_task.created` /
`put_back_task.completed` on `/put-back-tasks`, `cancel_record.processed` on
`/cancel-records`, plus `picking_order.updated` when an order closes.

### CN put-away (`receiving-cn` flow step)

Customer-receiving (CN) put-away variant (spec
`docs/superpowers/specs/2026-10-16-customer-receiving-upload-design.md`; see
`apps/backend/src/routes/putawayCn.ts` + `src/db/putawayCn.ts`): parallel
endpoints over the dedicated `put_away_tasks_cn` table (created by the CN
finalize cron, never the standard arrival confirm). Invisible unless the
`receiving-cn` flow step is enabled (CN warehouses disable the standard
`receiving` step) — every route 404s `not_found` when off (a warehouse runs
one flow or the other); the step backs the `cnReceiving` boolean on
`GET /config`. Completion
writes a single PUT_AWAY `on_hand` ledger row per item (no dock row — no
RECEIVE_TO_DOCK ledger in the CN path, accepted v1 difference) and no
`inventory_lot_sources` row (the CN item id lives in the ledger metadata,
`reference_type 'receiving_order_cn'`); fully putting the order away flips it
`clear`; CN stock only
appears in allocation once put-away completes.

| Endpoint | Description |
|---|---|
| `GET /put-away-cn/tasks?status=` | CN task queue (oldest first), `?status=` filters. 404 when `cnReceiving` is off. Rows carry `assignee`; the list (and detail) are filtered by it — NULL visible to all, set = only that username (spec 2026-11-01). |
| `GET /put-away-cn/tasks/:id` | CN task detail: order + expected items (remaining qty + shelf suggestions) + the on-hand lots this order's put-away created. 404 `put_away_task_cn_not_found` / when off (also 404 when assigned to another user). |
| `POST /put-away-cn/tasks/:id/complete` | `{items: [{itemId, qty, shelfCode, boxId?}]}` → `{taskCompleted}` — per-item `put_away_qty` updates + on-hand lot upserts + PUT_AWAY `on_hand` ledger rows in one tx; the task completes when every item is fully put away. 404 when off. |

## CN manual receiving (手動收貨)

PDA-driven CN receiving (spec
`docs/superpowers/specs/2026-10-27-manual-receiving-pda-design.md`): the PDA
stages the task locally (order numbers + label-scan items) and commits it in
one call — no DocPal workflow, no upstream sync. A task is single-brand (the
PDA locks the brand from the first label whose supplier template matches). The
tx writes the same `_cn` world the phase-1 finalize produced:
`receiving_orders_cn` (`status: "in_hand"` + arrived stamp, `delivery_date` =
creation date) + ONE `receiving_invoices_cn` with `invoice_no` =
`[brand]-yyyymmdd-[seq]` (per-brand-per-day sequence, 2-digit) which is also
the order's `batch_no`, `total_qty` = Σ items, and items at
`line_qty` = `received_qty` = scanned qty with `po_no` = the user-typed order
no and `org_id`/`sub_inventory_code` derived from the po_no prefix
(`deriveCnManualOrgSub`: 319/317 → 7/SZSZ1, 329/327 → 14/GZSZ, 339/337 →
5/SHSZ, 349/347 → 12/BJSZ, else 7/STORE1 — the pairs must exist in `org_info`;
order `org_id` = the first order no's derived org). `wcl_item_no` = the
client's label parse, else resolved from `parts` on a unique space-insensitive
match; raw label + `supplierCode` + `scannedBy` in `additional_data`. Plus the
`put_away_tasks_cn` task (uniform item pair, org fallback = order org). Audit
rows + `receiving_cn.completed` SSE on `/admin/receiving-cn` +
`/put-away-tasks`.

| Endpoint | Description |
|---|---|
| `POST /receiving-cn/manual-receipts` | `{orders: [{orderNo, items: [{partNo, qty, wclItemNo?, brand?, dateCode?, lotCode?, coo?, cow?, ctnNo?, supplierCode?, raw?}]}]}` → 201 `{id, batchNo, putAwayTaskId}`. Validation: orders non-empty, orderNo non-empty + unique space/case-insensitive, ≥1 item per order, partNo non-empty, qty positive integer, brand on ≥1 item — 400 `invalid_payload`; 404 `not_found` when `cnReceiving` is off. Route `src/routes/receivingCn.ts`, domain `createCnManualReceipt`/`validateCnManualReceipt`/`deriveCnManualOrgSub` in `src/db/receivingCn.ts`. |

## CN receiving scan tasks (收貨掃描)

The PDF path's physical-verification step (specs
`docs/superpowers/specs/2026-11-01-cn-receiving-scan-design.md` and
`docs/superpowers/specs/2026-11-04-cn-receiving-scan-grouping-design.md`):
admin confirm moves a CN order to `scanning`; the PDA scans physical labels
and the server credits the matching open items FIFO (aggregate matching — no
per-line picking), and finalize is the receipt moment (non-error lines with a
scan credit get `received_qty = min(scan_qty, line_qty)` and become put-away
work).

| Endpoint | Description |
|---|---|
| `GET /receiving-cn/scan-tasks` | Orders at `scanning` with `itemCount`/`resolvedCount` progress. Rows carry `assignee` (the `receiving_orders_cn` column); the list (and detail) are filtered by it — NULL visible to all, set = only that username (spec `docs/superpowers/specs/2026-11-01-task-assignee-design.md`). |
| `GET /receiving-cn/scan-tasks/:id` | Order + items with scan state; 404 `receiving_cn_scan_task_not_found` unless scanning (also 404 when assigned to another user). |
| `POST /receiving-cn/scan-tasks/:id/scan-aggregate` | `{itemId?, wclItemNo?, partNo?, qty, dateCode?, lotCode?, coo?, cow?, raw?}` — server-side aggregate match (part-key equality only; the OCR batch fields never filter, spec `2026-11-05-cn-receiving-part-only-scan-matching-design.md`) + FIFO credit across the open lines; scanned batch fields overwrite the credited lines' columns. Over-scan → `warning`/`qty_mismatch` on the last credited line. → the full task detail (same shape as GET) + `lastScan: {overQty}`. 404 `no_matching_item`, 400 `invalid_payload` (bad qty / no part identity). |
| `POST /receiving-cn/scan-tasks/:id/items/:itemId/flag` · `.../reset` · `POST /receiving-cn/scan-tasks/:id/finalize` | Per-item flag/reset (group actions loop them client-side; reset also clears a partial `scan_qty`) + finalize (`{unresolvedAs?: 'missing'}`; 409 `unresolved_items`) — see the design spec. |
| `POST /receiving-cn/scan-tasks/:id/scan-events/:eventId/remove` | Undo one physical scan (CR-046): each scan writes a `receiving_cn_scan_events` row with its per-line FIFO `takes`; removal reverses the credits. Does NOT restore the batch fields the scan overwrote (in-code `shortcut:`). |

## Ad-hoc put-away

Implemented: `GET /ad-hoc-put-away/locations`,
`POST /ad-hoc-put-away` (see
`apps/backend/src/routes/adhocPutaway.ts` + `src/db/adhocPutaway.ts`;
items with no receiving order — old store stock, write-out returns — put
away directly to a shelf in one confirmation. The PDA holds the in-progress
scan list in local state; the backend only sees the confirmed batch. Single
transaction: validate shelf + parts, find-or-create `inventory_lots` rows
(keyed by `part_no + shelf_code + date_code + lot_code + coo + cow + org_id
+ sub_inventory_code`), increment `total_qty`, write `inventory_transactions`
ledger rows (`ADJUST` / `on_hand` / positive delta), insert an
`ad_hoc_put_aways` audit row.

| Endpoint | Description |
|---|---|
| `GET /ad-hoc-put-away/locations` | Valid `(org_id, sub_inventory_code)` pairs from `org_info` for the PDA location selector. Response: `{locations: [{orgId, subInventoryCode}]}`. |
| `GET /ad-hoc-put-away/brands` | Distinct `parts.brand` values for the PDA brand dropdown. |
| `GET /ad-hoc-put-away/part-lookup?partNo=` | Resolve a scanned identity against the master (normalized `part_no`/`wcl_item_no`), so the PDA shows master values right after the scan; 404 `part_not_found` when unknown. |
| `POST /ad-hoc-put-away` | `{brand, shelfCode, items[{partNo, wclItemNo, qty, dateCode, lotCode, coo, cow, serialNo, orgId, subInventoryCode}]}` → `{id, itemCount, totalQty, shelfCode}`, 201. The scanned identity is matched against `parts` (normalized `part_no`/`wcl_item_no`) and replaced by the master values. 404 `shelf_not_found` / `part_not_found`; 400 on empty items or invalid fields. |

### Admin — ad-hoc put-away view

Read-only admin console endpoints (spec `2026-10-08-ad-hoc-put-away-admin-design.md`).

| Endpoint | Description |
|---|---|
| `GET /admin/ad-hoc-put-aways` | List batches with pagination + filters. Query: `page`, `pageSize`, **`brand`**, `shelfCode`, `from`, `to` (the admin page still sends `supplierCode`, which the route ignores — BUG-049). Response: `{rows: [{id, brand, shelfCode, orgId, subInventoryCode, totalQty, itemCount, actorId, createdDate}], total}`. |
| `GET /admin/ad-hoc-put-aways/:id` | Batch detail with full item list. Response: same fields as a list row plus `items: [{partNo, wclItemNo, qty, dateCode, lotCode, coo, cow, serialNo}]`. 404 if not found. |

## Shelf exchange

Implemented: `POST /shelf-exchange/preview`, `POST /shelf-exchange` (see
`apps/backend/src/routes/shelfExchange.ts` + `src/db/shelfExchange.ts`;
spec `2026-10-12-shelf-exchange-design.md`). Scan-driven shelf→shelf stock
move on the PDA: scan source shelf → item label (qty comes from the label,
no manual entry) → target shelf → confirm. Preview resolves the lot on the
source shelf (space-insensitive part-key match over `itemId`/`wclItemNo`,
label batch fields must match, FIFO by `date_code`, capped at available =
`total_qty − allocated_qty`) so mismatches surface before the target scan.
Commit re-validates in a tx (`FOR UPDATE` on the source lot), decrements the
source lot (deleted at zero), find-or-creates the target lot on the unique
lot index key (`part_no + date_code + coo + cow + shelf_code + box_id NULL +
org_id + sub_inventory_code` — merged lot keeps the target's `lot_code`),
writes two `MOVE` `inventory_transactions` rows (−qty source, +qty target,
`reference_type: "shelf_exchange"`) plus a `shelf_exchanges` audit row.
The lot keeps its org/sub-inventory pair; any existing shelf is a valid
target. Allocated stock is not movable (409 `insufficient_available_qty`).

| Endpoint | Description |
|---|---|
| `POST /shelf-exchange/preview` | `{sourceShelfCode, partNo?, wclItemNo?, qty, dateCode?, lotCode?, coo?, cow?}` → `{lotId, partNo, wclItemNo, dateCode, lotCode, coo, cow, totalQty, availableQty, qty}`, 200. 404 `shelf_not_found`; 409 `no_stock_at_location` (no lot on the source shelf matches the label); 409 `insufficient_available_qty` (matched lot's available < label qty). |
| `POST /shelf-exchange` | `{sourceShelfCode, targetShelfCode, lotId, qty}` → `{id, sourceShelfCode, targetShelfCode, partNo, qty, sourceRemaining, targetTotal}`, 201. 400 `same_shelf`; 404 `shelf_not_found` (either shelf); 409 `no_stock_at_location` / `insufficient_available_qty` (re-validated under lock). |

## Picking

Implemented: `GET /picking-orders`, `GET /picking-orders/:id`,
`POST /picking-items/:id/scan`, `DELETE /packages/:id`,
`POST /picking-orders/:id/claim-shelf-box`,
`POST /packages/:id/verify`, `POST /picking-orders/:id/boxes`,
`POST /picking-orders/:id/box-each-unboxed`,
`GET /shipping-boxes`,
`PATCH /shipping-boxes/:id`, `POST /shipping-boxes/:id/packages`,
`DELETE /shipping-boxes/:id/packages/:packageId`,
`POST /shipping-boxes/:id/add-all-unboxed`,
`POST /shipping-boxes/:id/scan`,
`POST /shipping-boxes/:id/cancel`, `POST /shipping-boxes/:id/close`,
`POST /shipping-boxes/:id/reopen`,
`POST /picking-orders/:id/finish`,
`POST /picking-orders/:id/labeling-finish`, `GET /labeling-orders`,
`POST /picking-orders/report-issues` (see
`apps/backend/src/routes/picking.ts` + `src/db/picking.ts`; scan consumes the
allocation's source — lot `total_qty`/`allocated_qty`, receiving
`picked_qty`, or FIFO distribution across an order-level receiving source —
into `picking_packages` + two PICK ledger rows (reserved −qty / on_hand −qty)
per portion, removal reverses; `picked_qty` tracks boxed packages — boxing
NEVER finishes the order since 2026-10-16 (the operator's explicit
`POST /picking-orders/:id/finish` is the only finisher; one COO per box:
add-to-box / scan-into-box reject a mismatched non-null COO with 409
`box_coo_mismatch`, add-all is exempt and the PDA flags mixed-COO boxes) —
no next-step task is created (box-scoped design; see "Measuring"/"Verify"
below); scan/removal consume the reserved rows in-tx — no recompute (manual-only)).

| Endpoint | Description |
|---|---|
| `GET /picking-orders?status=&allocation=&type=&search=&limit=&offset=&sort=&dir=` | Paged list → `{rows, total}`. Rows: `{id, refNo, status, allocationStatus, allocatedQty, poNo, shipTo, customerCode, destinationCountry, deliveryDate, warehouseCode, warehouseSectionCode, subInventoryCode, itemCount, totalQty, pickedQty, outdatedWarningCount}`. `allocationStatus` is the persisted order-level summary (`unallocated`/`partial`/`allocated`, recomputed by `allocateAll`); `allocatedQty` = Σ item `allocated_qty`; `outdatedWarningCount` = unresolved `outdated_scan_warnings` rows on the order (see §Admin: outdated warnings). `?status=`, `?allocation=` and `?type=` accept comma-separated lists (`?status=shipped` still works); `type` filters `picking_order_type` (e.g. `invoice,tn`); `search` = case-insensitive substring on `orderNo`/`poNo`/`customerCode`/`shipTo`; `limit`/`offset` page the result (omit `limit` for all rows); `total` = full match count. `sort` is a whitelist of the admin picking-list column keys (`orderNo`, `status`, `pickingOrderType`, `customerCode`, `poNo`, `shipTo`, `deliveryDate`, `itemCount`, `pickedRatio`, `allocation`, `workingByName`, `remark`, `prioritySeq`, `createdDate`, `lastUpdateDate`) with `dir` `asc`/`desc`; unknown keys fall back to the default priority order, which is also the tiebreaker tail. Per-user sub-inventory scope (see §Auth): when the caller has a scope set, only orders whose `(org_id, sub_inventory_code)` pair is in scope are returned — a NULL `sub_inventory_code` acts as every sub-inventory of the order's org (visible when the scope covers any sub-inventory of that org). Rows also carry `assignee`; the list (and `GET /picking-orders/:id`) are filtered by it — NULL visible to all, set = only that username, out-of-assignee detail = 404 (spec `docs/superpowers/specs/2026-11-01-task-assignee-design.md`). |
| `GET /picking-orders/:id` | Nested detail: `{order..., labelingPending, labelingDoneAt, labelingDoneBy, labelingDoneByName, outdatedWarningCount, items[{..., allocations[{..., lot|receivingItem, boxId}], packages[]}], boxes[{..., packageCount}], suggestedBox}`. No parallel arrays. The `labeling*` fields describe the labeling stage (spec 2026-10-28, see the finish row below): `labelingPending` while the order waits in the labeling queue, `labelingDoneAt/By(+Name)` the audit of who cleared it. Allocation `lot` carries `shelfWarning` (`shelves.warning` of the lot's shelf, null when none) — advisory ⚠ for operators (spec 2026-09-17-shelf-warning-design.md). `outdatedWarningCount` = unresolved outdated date-code scan warnings on the order (spec 2026-10-07). Per-user scope: 404 when the order's `(org_id, sub_inventory_code)` pair is out of the caller's scope. `suggestedBox` (null when none or the order is not active) is the whole-box claim hint: a fully-claimable shelf box whose current `inventory_lots` contents exactly equal the order's remaining demand `{id, shelfCode, orgId, subInventoryCode, contents[{partNo, qty}]}`. |
| `POST /picking-orders/:id/claim-shelf-box` | `{shelfBoxId}` (actor from the token) → `{shippingBoxId, packageIds}`, 201. Whole-box exact-match claim (spec `docs/superpowers/specs/2026-07-29-whole-box-picking-claim-design.md`): the shelf box's current contents must exactly equal the order's full remaining open demand (409 `box_not_exact_match`) with no other order reserving any piece (409 `box_not_fully_available`). The carton is reused as the shipping box — created prefilled with `box_size`/`net_weight`/`gross_weight` summed from the source receiving lines' `additional_data` (g→kg via `weightUnit`, default kg), `source_shelf_box_id` recorded — with one boxed package per (item, lot) portion and the order's allocations released. Boxing never finishes the order (2026-10-16) — the operator confirms with the explicit finish. |
| `POST /picking-items/:id/scan` | `{allocationId|source, qty, raw?}` → `{packageIds, outdatedWarning}`. The one canonical scan-to-pick route; OCR/receiving-source picking folds in here (old `ocr-pick` path dies). `outdatedWarning` = `{supplierCode, dateCode, limitMonths} | null` — set when the scanned label's date code is older than the supplier's `outdated_limit_months` (the scan still succeeds and a warning row is recorded; spec 2026-10-07, see §Admin: outdated warnings). |
| `DELETE /packages/:id` | `{}` → removes an unboxed (unverified) package. |
| `POST /packages/:id/verify` | `{qty?}` — package must be boxed (409 `package_not_in_box`). Credits `qty` (default: the package's remaining) onto `rescanned_qty`, capped at `qty` (400 `qty_must_be_positive_integer`; 409 `package_already_verified` when fully credited). Measuring pass: the box is **open** and the measuring step is enabled (or no verify task exists yet), sets `verified` on first credit. Verify pass: pending verify task + (box **closed**, or box open when the measuring step is disabled — the finish spawned the task; 409 `no_pending_measure_or_verify_task` without a task), sets `verified` + `verify_verified` on first credit. |
| `POST /picking-orders/:id/boxes` | `{}` → box. |
| `POST /picking-orders/:id/box-each-unboxed` | `{}` → `{created, boxIds}`, 201. One new open box per scanned-but-unboxed package of the order, each packed with its package in one tx (spec 2026-11-01-picking-box-operations-design.md). `{created: 0}` when nothing is unboxed. |
| `GET /shipping-boxes` | → `{boxes}`: every `status = 'open'` shipping box, oldest first, each `{id, orderId, orderNo, packageCount, boxSize, netWeight, grossWeight, destinationCountry, createdDate}` — `orderId`/`orderNo` are the creator order's (`picking_order_id` is informational; a box may hold packages from any open picking order). Powers the PDA picking page's choose-box dialog (cross-order scan-into-box). |
| `PATCH /shipping-boxes/:id` | `{boxSize?, netWeightKg?, grossWeightKg?, destinationCountry?}` (kilograms, one unit everywhere — decimals allowed, rounded to 3 dp; 400 `invalid_net_weight_kg` / `invalid_gross_weight_kg`). |
| `POST /shipping-boxes/:id/packages {packageId}` · `DELETE /shipping-boxes/:id/packages/:packageId` | Box membership. Cross-order packing: any open picking order's unboxed package may be added to the box (the old 409 `different_picking_orders` guard is gone; `shipping_boxes.picking_order_id` stays as the informational "created for" order only). One COO per box (2026-10-16): adding a package whose non-null COO differs from the box's existing non-null COO set is rejected with 409 `box_coo_mismatch`; a null COO never conflicts. |
| `POST /shipping-boxes/:id/scan` | `{barcode, qty?, dateCode?}` → `{packageIds, outdatedWarning}`, 201. Scan-to-box across orders: resolves the barcode to the one open picking item it could mean across **all** orders (part_no or `wcl_item_no` match on an item of a pending/picking/allocated order with open qty and a remaining allocation; 404 `no_matching_picking_item`, 409 `ambiguous_picking_item`), then picks it straight into this box via the scan path (default qty = the item's open qty capped by the allocation's remaining). The optional `dateCode` (the label's decoded code, label format — WWYY for `dateCodeFormat=wwyy`; canonicalized to YYWW for the check) feeds the outdated date-code check — same `outdatedWarning` response field as `POST /picking-items/:id/scan`. |
| `POST /shipping-boxes/:id/add-all-unboxed` | `{}` → `{packed}`. Stays scoped to the box's creator order. |
| `POST /shipping-boxes/:id/cancel` · `/close` | `{}`. Close guards: non-empty; with the measuring step **enabled** also every package fully rescanned (`rescanned_qty >= qty`), box size and positive weights (gross ≥ net); with measuring **disabled** those guards are skipped (there is no measuring re-scan — the measuring-off verify completion closes boxes the same way, `verify.ts` completeVerifyTask) so the PDA picking page can close a freshly packed box directly (spec 2026-11-01-picking-box-operations-design.md). The destination falls back to the creator order's ship_to in both modes. Closing IS the measuring completion — and, when the verify step is enabled, spawns the box's pending verify task in the same tx (`ON CONFLICT DO NOTHING`, idempotent on re-close) and resets the packages' rescanned credit for the verify pass. |
| `POST /shipping-boxes/:id/reopen` | `{}` — verify-step re-measure, box-scoped: the box's own pending verify task is required (409 `verify_task_not_pending`); closed box → `open` + packages un-verified (both `verified` and `verify_verified`, and `rescanned_qty` reset; 409 `shipping_box_not_closed`). |
| `POST /picking-orders/:id/finish` | `{}` → `{id, status, labelPrintingPending, labelingPending}` — the ONLY way an order finishes since 2026-10-16 (boxing/claim/close never auto-finish): flips the order to `picking_finished` from pending/picking/allocated (409 `picking_order_could_not_be_finished` from other writable states), releasing the work lock; 409 `not_all_items_fully_boxed` until every item is fully picked/boxed. 409 `unresolved_outdated_warnings` with a JSON body `{"error":"unresolved_outdated_warnings","count":N}` while the order has unresolved outdated date-code scan warnings (spec 2026-10-07) — after an admin resolves the warnings the operator re-runs this finish. Label stages (specs 2026-11-02-label-printing-step-design.md, 2026-10-28-picking-labeling-step-design.md): matches are resolved once against the active `label_print_rules` (`resolveLabelPrintRulesForOrder`, first match per label type). When the `label-printing` flow step is enabled and ≥ 1 match has `labelSource = "internal"`, the finish sets `label_printing_pending = true` (+ a `label_printing_pending` transition log with the matched internal rule ids), returns `labelPrintingPending: true`, and DEFERS the measuring-off verify-task spawn until the label-printing finish. Else, when the `labeling` flow step is enabled and ≥ 1 match of any source exists, the finish sets `labeling_pending = true` (+ a `labeling_pending` transition log with the matched rule ids), returns `labelingPending: true`, and defers the progression to the labeling finish. Next-step task: with the measuring step enabled none — closing a box is the measuring completion, and the box's verify task comes from `closeShippingBox` (a label-stage-pending order's boxes are excluded from `GET /measuring-boxes` until the stage clears). With measuring **disabled** and verify enabled, the finish itself spawns the pending verify task on each of the order's still-open boxes (a cross-order box waits until every order in it is finished AND has cleared both label stages — the same gate as `GET /measuring-boxes`) and resets the packages' rescanned credit; the verify pass then runs on the open box and completing it closes the box. |
| `POST /picking-orders/:id/label-printing-finish` | `{}` → `{id, status: "picking_finished", labelPrintingPending: false, labelingPending}` — clears the order's label-printing stage (spec 2026-11-02): 404 `picking_order_not_found`, 409 `label_printing_not_pending` unless `status = picking_finished AND label_printing_pending` (the PDA treats that 409 as already-done). Clears `label_printing_pending`, stamps `label_printing_done_at/by` + a `label_printing_done` transition log, then with the `labeling` step enabled hands the order to the labeling queue (`labeling_pending = true` + a `labeling_pending` transition log with the live matched rule ids — entry guaranteed by the finish-time internal-match snapshot), otherwise runs the deferred post-finish progression. Emits SSE `picking.label_printing_finished` (topics `/picking-orders` + `/label-printing-orders` + `/labeling-orders`). |
| `POST /picking-orders/:id/labeling-finish` | `{}` → `{id, status: "picking_finished", labelingPending: false}` — clears the order's labeling stage (spec 2026-10-28): 404 `picking_order_not_found`, 409 `labeling_not_pending` unless `status = picking_finished AND labeling_pending` (the PDA treats that 409 as already-done). Clears `labeling_pending`, stamps `labeling_done_at/by` + a `labeling_done` transition log, then runs the deferred post-finish progression (the measuring-off verify-task spawn, cross-order gate included). Emits SSE `picking.labeling_finished` (topics `/picking-orders` + `/labeling-orders`). |
| `GET /label-printing-orders?search=&limit=&offset=` | The label-printing queue → `{rows, total}`: orders with `status = picking_finished AND label_printing_pending`, org-scoped + user-scoped like `GET /picking-orders` (assignee-filtered on `picking_tasks(step='label-printing').assignee`, CR-048), ordered `last_update_date` DESC. Rows identical to `GET /labeling-orders` (`labelMatches` = live matches). Same 50-row load-more convention. |
| `GET /labeling-orders?search=&limit=&offset=` | The labeling queue → `{rows, total}`: orders with `status = picking_finished AND labeling_pending`, org-scoped + user-scoped like `GET /picking-orders` (assignee-filtered on `picking_tasks(step='labeling').assignee`, CR-048 — not `picking_orders.assignee`), ordered `last_update_date` DESC. Rows: `{id, orderNo, pickingOrderType, customerCode, shipTo, deliveryDate, itemCount, totalQty, labelMatches, lastUpdateDate}` — `labelMatches` = the LIVE `resolveLabelPrintRulesForOrder` result per row (the queue membership itself was snapshotted at finish; rules edited since may resolve to zero). Same 50-row load-more convention as the picking list. |
| `POST /picking-orders/report-issues` | `{entries: [{pickingOrderId, reason, qty?, packSize?, note?, remark?}]}` → `{reported[], skipped[]}`. Per-order entries — no `"; "`-joined remark hack. |
| `POST /picking-orders/:id/resolve-issue` | `{resolutionNote?}` → the order — admin resolve of an open issue: back to `pending` (issue fields cleared); the order re-enters allocation demand at the next Re-allocate. |
| `POST /picking-orders/reorder` | `{orderIds}` in new priority order → `priority_seq 1..n`. No recompute — the new priority applies at the next Re-allocate. Registered before `/picking-orders/:id` (route order). |
| `POST /picking-orders/:id/work-lock` · `DELETE /picking-orders/:id/work-lock` | Page-driven work lock: acquire/refresh while the order page is open (PDA refreshes every 3 min, server expiry 10 min; 409 `lock_held` + holder info when another user holds a fresh lock) / best-effort release on leave (`sendBeacon`, no body). While held, allocation runs skip the order; single-order Re-allocate 409s `lock_held`. |
| `GET /picking-shelf-stock?partNo=&wclItemNo=&shelfCode=&boxId=&orderId=` | Shelf/box stock lookup for the Pick-from-box dialog (server-side scoped from the order + item, transfer-aware; `orgId`/`subInventoryCode` are legacy client-supplied scope params). |
| `GET /picking-orders/:id/label-print-rules` | → `{matches: [{ruleId, name, labelType, printTemplateId, labelCount}]}` — the order resolved against the active `label_print_rules` (JS evaluation of the admin preview's condition semantics in `src/db/labelPrint.ts`; first active rule by ascending priority per `label_type`, so ≤ 3 matches; 404 `picking_order_not_found`). `labelCount` = the converted param-row count per match, computed in the route handler only (`labelCountForMatch` in `src/db/labelPrintParams.ts`) — `listLabelingOrders` calls `resolveLabelPrintRulesForOrder` directly so the labeling list never pays converter cost. Drives the PDA picking-finish print prompt + the detail-page reprint (spec 2026-10-27). |
| `POST /picking-orders/:id/label-print` | `{ruleId, serviceId?, deviceKey?}` → `{jobs, labelCount}` — server-side label print (spec 2026-10-29): loads the rule (404 `label_print_rule_not_found`, 409 `label_print_rule_inactive`), re-validates it against the order's live matches (409 `label_rule_no_longer_matches`; 404 `picking_order_not_found` via the resolver), loads the order detail with the caller's user scope, converts to `printingParams` (per-`print_template_id` converter registry in `src/db/labelPrintParams.ts`, default superset builder keyed by `label_type`; 400 `printing_params_required` on empty), then `dynamicPrint({templateId, printingParams, copies: 1, mode: "auto"})` via `src/print.ts` (upstream failure → 502). `serviceId`/`deviceKey` are the caller-picked agent printer from `GET /print/printers` (both-or-neither, 400 `printer_incomplete`; also forwarded as `printerName = deviceKey`) — absent = the template's default printer. `jobs` = the print-service job list; the PDA polls `GET /print/jobs/:jobId`. |

Changes vs old: flat-by-id mutations only (nested twins die); polymorphic
`DELETE /packages/:id` split into remove vs box-membership `DELETE`; one
weight unit (kilograms); nested detail kills client joins.

## Measuring

Implemented: `GET /measuring-boxes`, `GET /measuring-boxes/:id` (see
`apps/backend/src/routes/measuring.ts` + `src/db/measuring.ts`; spec
`docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`).
`measuring_tasks` is gone: closing a shipping box already requires non-empty
contents, every package `verified`, a destination, a box size and positive
weights (gross ≥ net) — closing *is* the measuring completion, so no pending
measuring task exists. The measuring work list is therefore the open shipping
boxes that contain packages **whose picking orders are all picking-complete**
(status `picking_finished`/`measuring_finished`/`shipped` — the order's explicit Finish plus the measuring pass, spec
`docs/superpowers/specs/2026-10-20-measuring-post-picking-list-design.md`);
a box may hold packages from several picking orders (cross-order packing), so
order numbers are aggregated per box and the list is grouped by picking order.
Box measurement itself reuses the picking routes: `PATCH /shipping-boxes/:id`,
`POST /packages/:id/verify`, `POST /shipping-boxes/:id/close`.

| Endpoint | Description |
|---|---|
| `GET /measuring-boxes` | The work list, grouped by picking order (a cross-order box appears under each of its orders), newest box first — `[{orderId, orderNo, boxes: [{boxId, status, orderNos[], packageCount, verifiedCount, createdDate}]}]`. Only open boxes with at least one package whose every related picking order is `picking_finished`/`measuring_finished`/`shipped` AND has cleared both label stages (`labeling_pending = false` AND `label_printing_pending = false` — a pending order keeps its boxes off this list, specs 2026-10-28, 2026-11-02). Rows carry `assignee` (`shipping_boxes.assignee`); the list (and detail) are filtered by it — NULL visible to all, set = only that username (spec 2026-11-01). |
| `GET /measuring-boxes/:id` | Box detail: `{boxId, pickingOrderId, status, boxSize, grossWeight, netWeight, destinationCountry, shippedAt, createdDate, suggestedNetWeightKg, packages[{..., partNo, wclItemNo, verified, verifyVerified}]}` (404 `shipping_box_not_found` — also when the box is assigned to another user). `suggestedNetWeightKg` = Σ over the box's packages of `(formula.weight / formula.qty) × pkg.qty` grams from `net_weight_formula`, in kg (3 dp; parts without a formula contribute 0, `null` when none have one). |

Changes vs old: `GET /measuring-tasks*` and
`POST /measuring-tasks/:id/complete` are deleted — the box-keyed read
supersedes the consolidated task detail (packages carry `partNo`/`wclItemNo`
— no second request, no client-side matching).

## Verify

Implemented: `GET /verify-tasks`, `GET /verify-tasks/:id`,
`GET /verify-tasks/lookup-by-label`, `POST /verify-tasks/:id/scan-label`,
`POST /verify-tasks/:id/complete` (see `apps/backend/src/routes/verify.ts` +
`src/db/verify.ts`; spec
`docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`).
Verify tasks are keyed on the shipping box (`verify_tasks.shipping_box_id`,
unique — one task per box), created when the verify step is enabled either by
`closeShippingBox` (measuring step on; `ON CONFLICT DO NOTHING` keeps a
re-close idempotent) or by `POST /picking-orders/:id/finish` on the still-open
box (measuring step off — the box never goes through the measuring close).
Verify is a second full re-scan pass over that one box: the worker re-scans
every package (`rescanned_qty` credit — reset to zero by the close/finish that
spawned the task; scanning works on the closed box — checking
contents against the sealed box is the normal pass, and on the open box when
measuring is disabled), then completes.
Completion guards: pending task → (box closed when the measuring step is on)
→ every package fully re-scanned (`rescanned_qty >= qty`) →
`completed` + transition log; when measuring is disabled and the box is still
open the completion also closes the box (no weights/size required, destination
resolved from the creator order's ship_to like `closeShippingBox`) so it can
enter the shipping feed, then flips every `picking_finished` order with packages in the box to `measuring_finished` when no other pending verify task remains for it (spec `2026-10-22-picking-status-split-design.md`); no stock movement. Box re-work reuses the
picking verbs, including the verify-only `POST /shipping-boxes/:id/reopen`
(returns a closed box to `open` with its packages un-verified on both flags
and the credit reset,
requires the box's pending verify task).

| Endpoint | Description |
|---|---|
| `GET /verify-tasks?status=` | List: `{taskId, status, shippingBoxId, boxStatus, orderNos[], destinationCountry, packageCount, verifyVerifiedCount, createdDate}`. Rows carry `assignee` (`verify_tasks.assignee`); the list (and detail) are filtered by it — NULL visible to all, set = only that username (spec 2026-11-01). |
| `GET /verify-tasks/:id` | Detail: `{task{id, status, shippingBoxId, createdDate}, box{..., suggestedNetWeightKg}, packages[{..., partNo, wclItemNo, verified, verifyVerified}]}` (404 `verify_task_not_found` — also when the task is assigned to another user). Same per-box shape as the measuring detail. |
| `GET /verify-tasks/lookup-by-label?raw=` | Carton-label box entry: the raw scan matched against recorded carton `label_prints` rows for a pending task's box → `{taskId, shippingBoxId}` + stamps `carton_label_verified`; 400 `raw_required`, 404 `label_print_not_found`. Registered BEFORE `GET /verify-tasks/:id` (route order). |
| `POST /verify-tasks/:id/scan-label` | `{raw}` — label-mode verify: carton print rows match first (stamp `carton_label_verified`), then item/item_box rows (mark the package `label_verified`, return its expectations for the server-side hard compare); 404 `label_print_not_found`, 400 `raw_required` (spec 2026-10-30-label-source-and-label-verify-design.md). |
| `POST /verify-tasks/:id/complete` | `{}` — 404 `verify_task_not_found`, 409 `verify_task_not_pending`, 409 `shipping_box_not_closed` (only when the measuring step is enabled — with measuring off the open box is closed by the completion), 409 `packages_not_all_rescanned` until every package is fully re-scanned (`rescanned_qty >= qty`), 409 `labels_not_all_verified` when label-mode rows exist without their label scans (see `docs/backend/verify-measuring.md`). |

## Flow-step config + shipping feed

Implemented: `GET /config`, `GET /shipping-orders`,
`GET /shipping-orders/:boxId`,
`POST /shipping-orders/:boxId/ship` (see
`apps/backend/src/routes/config.ts`, `src/routes/shipping.ts` +
`src/db/shipping.ts`, `src/config.ts`). The flow config — the
`warehouse_config` row key `"flow"` (JSON merged over defaults and validated
at boot; the `FLOW_CONFIG` env var overrides the row when set; legacy
`FLOW_STEPS_DISABLED` comma-separated step keys still map onto step
enablement on top, deprecated) toggles the 13 flow steps (`receiving`,
`receiving-cn`, `put-away`, `picking`, `label-printing`, `labeling`,
`goods-verify`, `measuring`, `verify`, `put-back`, `stock-search`,
`ad-hoc-put-away`, `shelf-exchange` — `FLOW_STEPS` in `src/config.ts`) and
carries behavior
flags; `GET /config` → `{flowSteps, pickingAllocation, putAway}` exposes the
result to clients (the PDA hides disabled home tiles; changes need a backend
restart). The behavior-changing keys: `verify` wires the close chain
(closing a box spawns its pending verify task, and the shipping feed is
gated on completed verify tasks), `goods-verify` makes task generation
(manual + nightly job) a no-op,
`steps.picking.allocation.allowDockStock=false` makes put-away a hard gate
for allocation, and `steps.put-away.autoCreateTasks`/`suggestShelf` switch
put-away to task mode with shelf suggestions; `receiving-cn` gates the CN
receiving + `/put-away-cn/*` routes (§CN), `label-printing`/`labeling` gate
the post-finish label stages (§Picking), and `measuring` and the remaining
steps only toggle PDA home tiles (there is no measuring task to gate).
The top-level `allowedOrgIds: number[]` key (spec
`2026-09-01-flow-config-allowed-org-ids-design.md`; [] = all orgs) scopes
PDA-facing queries to the listed org partitions: the picking/receiving order
lists + details (detail 404s out of scope), stock search, put-away tasks +
candidates hide rows with another (or NULL)
`org_id`; the verify/measuring/shipping box queues, the goods-verify queue, and `allocateAll` are
unaffected.
The top-level `dateCodeDisplayTemplate: string` key (spec
`2026-09-17-date-code-display-template-design.md`, default `"[date_code][coo]"`)
is an admin-display-only policy: placeholders `[date_code]` `[lot_code]` `[coo]`
`[cow]` render a lot's fields joined (empty field → empty, no dangling
separator), plus `[coo_short]` `[cow_short]` rendering the single char from
`country_list.short_code` (spec `2026-09-22-coo-cow-short-code-design.md`;
unmapped/NULL short code falls back to the raw code),
applied client-side in the admin receiving order detail and
picking order detail allocation cells; edited via the admin display-config
page through `GET/PUT /admin/flow-config`.
The top-level `receivingOrderNameTemplate: string` key (spec
`2026-09-21-receiving-order-name-template-design.md`, default `"[batch_no]"`)
sets the receiving order NAME: placeholders `[batch_no]` `[invoice_no]`
(comma-joined invoice numbers) `[invoice_no_first]` (first invoice only)
`[supplier_code]` `[supplier_name]`
`[delivery_date]` (YYYY-MM-DD) `[date_code]` are rendered by the backend into
a `displayName` field on the `GET /receiving-orders` rows and the
`GET /receiving-orders/:id` detail (all-empty render falls back to batch_no);
the PDA receiving list/detail titles and the admin receiving list/detail
render `displayName`, so a runtime `PUT /admin/flow-config` applies
immediately.
The top-level `pdaListTemplates` key (spec
`2026-09-21-pda-list-row-templates-design.md`) sets per-PDA-list `{title,
meta}` templates for the six PDA list pages (`receiving`, `picking`,
`put-away`, `goods-verify`, `verify`, `measuring`); missing lists/fields keep
the built-in defaults (= today's hardcoded rows). The resolved value is served
on `GET /config` as `listTemplates` and applied client-side in the PDA
(`apps/pda/utils/listRowTemplate.ts` + `composables/useListTemplates.ts`):
receiving and put-away `[name]` is the backend `displayName` (the put-away
candidates/tasks queries carry it from the receiving order); an all-empty
title falls back
to the default title then the raw primary id, an all-empty meta hides the meta
line ("empty" = no letters/digits in the render). Edited on the admin
display-config page via `PUT /admin/flow-config`.
The top-level `pdaViewConfig` key (spec
`2026-10-04-pda-app-rewrite-design.md`) is the new PDA app view config:
`lists` covers the six list pages plus `stock-search` with per-list `{title,
meta[1–2], chip}` (chip validated against that list's chip catalog), and
`receivingDetail`/`pickingDetail`/`putAwayDetail` carry `itemFields` +
`expandedFields` allow-lists (validated against per-page field catalogs) plus
`defaultGrouping` (`invoice`/`carton`/`part-no`, receiving only). It
supersedes the deprecated `pdaListTemplates`: when a list has no
`pdaViewConfig.lists` entry, a customized legacy `pdaListTemplates` value
migrates into the resolved view; otherwise defaults apply. The fully-resolved
value is served on `GET /config` as `viewConfig`; edited via
`PUT /admin/flow-config`.
The top-level `cnReceiving: boolean` key (spec
`2026-10-16-customer-receiving-upload-design.md`, default false) switches a
CN warehouse to the customer-receiving world: the PDA put-away flow reads the
dedicated CN tables via the `/put-away-cn/*` routes (404 while off — a
warehouse runs one flow or the other). It is backed by the `receiving-cn`
flow step (default disabled; a CN warehouse disables the standard `receiving`
step and enables `receiving-cn`) and edited via
`GET/PUT /admin/flow-config`.
The top-level `dateCodeFormat: "wwyy" (default) | "yyww"` key (spec
`docs/superpowers/specs/2026-10-22-datecode-format-config-design.md`)
describes the label/upstream date-code format — the format of the receiving
enclave (`receiving_orders.date_code`, `receiving_invoice_items.date_code`,
scan-decode output). The canonical stored format everywhere downstream of
receiving (`inventory_lots`, `picking_packages`, all rank/sort/filter logic)
is always YYWW, so plain lexicographic order is chronological; the backend
converts at the enclave boundaries (`toCanonicalDateCode`/`toLabelDateCode`
in `src/db/dateCode.ts`) and clients still POST label-format scanned codes.
Validated at boot, admin-editable on the flow-config page via
`GET/PUT /admin/flow-config`, served on `GET /config`.
The shipping feed is per-box: the list reads closed, unshipped boxes — gated
on the box's completed verify task when the verify step is enabled
("measured" ≡ closed). Shipping is a pure workflow transition (stock already
left inventory at pick-scan time): `POST /shipping-orders/:boxId/ship` stamps
the box `shipped_at`/`shipped_by` + transition log and then derives order
`shipped` for every order in the box (source orders are in
`picking_finished` or `measuring_finished`) whose items are all boxed, has nothing
unboxed, and has every box holding its packages shipped. The ship event is
`shipping_box.shipped` (topics `/shipping-orders` + `/picking-orders`).
Shipped boxes drop out of the feed; shipped orders stay visible via
`GET /picking-orders?status=shipped`.

| Endpoint | Description |
|---|---|
| `GET /config` | `{flowSteps: Record<FlowStep, boolean>, pickingAllocation: {allowDockStock: boolean}, putAway: {autoCreateTasks: boolean, suggestShelf: "existing-stock"\|"off", skipScan: boolean}, allowedOrgIds: number[], cnReceiving: boolean, pickingShelfScan: "off"\|"require-match"\|"require-any", dateCodeFormat: "wwyy"\|"yyww", listTemplates: Record<PdaListKey, {title, meta}>, viewConfig: PdaViewConfig, warehouseCode: string}` — the resolved flow config (`warehouse_config` row `"flow"`, `FLOW_CONFIG` env override; legacy `FLOW_STEPS_DISABLED` maps onto `flowSteps` on top, deprecated). `pickingAllocation.allowDockStock=false` = put-away is a hard gate for allocation; `putAway` drives the put-away task mode + shelf suggestions; `allowedOrgIds` ([] = all orgs) scopes picking/receiving/stock/put-away/goods-verify queries to the listed org partitions server-side; `cnReceiving` (spec `2026-10-16-customer-receiving-upload-design.md`, default false) switches the PDA put-away flow to the dedicated CN tables (the `/put-away-cn/*` routes 404 while off); `pickingShelfScan` is the picking shelf-scan mode (spec `2026-10-02-picking-shelf-scan-config-design.md`); `listTemplates` (spec `2026-09-21-pda-list-row-templates-design.md`, deprecated) carries the per-PDA-list row display templates applied client-side; `viewConfig` (spec `2026-10-04-pda-app-rewrite-design.md`) is the fully-resolved PDA view config (`lists` incl. stock-search `{title, meta[1–2], chip}` + receiving/picking/put-away detail field lists and receiving `defaultGrouping`; legacy `pdaListTemplates` customizations migrate in for lists without a `pdaViewConfig.lists` entry); `warehouseCode` is the instance's `WAREHOUSE_CODE` env selector lower-cased (`""` when unset) — the admin console picks warehouse-specific layouts from it. |
| `GET /shipping-orders` | Box rows: `{boxId, orderNos[], shipTos[], destinationCountry, boxSize, grossWeight, netWeight, packageCount, closedAt}` — closed, unshipped boxes (verify-gated when the verify step is on). |
| `GET /shipping-orders/:boxId` | Box detail: `{box{..., shippedAt, shippedBy}, packages[{..., partNo, wclItemNo, verified}], orders[{id, orderNo, status, shipTo, customerCode, poNo}]}` (404 `shipping_box_not_found`). |
| `POST /shipping-orders/:boxId/ship` | `{}` → `{id, status, shippedOrderIds}`. Re-checks the feed predicate (closed, unshipped, verify-gated; 409 `box_not_ready_to_ship` otherwise, including already-shipped boxes), stamps the box, derives order `shipped`, emits `shipping_box.shipped`. |

## Goods verify (task-based, concept 7)

Implemented: `POST /goods-verify-tasks/generate`, `GET /goods-verify-tasks`,
`GET /goods-verify-tasks/:id`, `POST /goods-verify-tasks/:id/verify` (see
`apps/backend/src/routes/goodsverify.ts` + `src/db/goodsverify.ts`). **Per-shelf
daily movement summary** (redesigned 2026-10-17, spec
`docs/superpowers/specs/2026-10-17-goods-verify-shelf-summary-redesign.md`):
generation is one set-based `INSERT … SELECT … ON CONFLICT DO NOTHING` off the
day's shelves with net non-zero `on_hand` movement (`qty_type='on_hand'`,
`shelf_code IS NOT NULL`, `HAVING SUM(qty_delta) != 0`); `date` defaults to the
DB server's `CURRENT_DATE` (`txn_at` holds UTC wall-clock), `actorId` optional
(system job). The task carries a `movements` jsonb snapshot —
`[{partNo, wclItemNo, description, qtyChange, currentTotal}]` — aggregated by
shelf+part, `currentTotal` = the shelf's total across all its lots for that
part. Generation emits SSE `goods_verify.tasks_created` (topic
`/goods-verify-tasks`); the whole step is a no-op when `goods-verify` is
disabled in the flow config. Verify is **pure confirmation** (no counted-qty,
no ADJUST, no box `closed→verified` — those were removed).

| Endpoint | Description |
|---|---|
| `POST /goods-verify-tasks/generate` | `{date?, actorId?}` → `{created, date}`. Day-end generation: shelves with net non-zero `on_hand` movement in `inventory_transactions` that day → one task per `(task_date, shelf_code)` (unique index `goods_verify_tasks_shelf_day_unique` = idempotent). `date` (`YYYY-MM-DD`, else 400 `invalid_date`) defaults to the DB server's `CURRENT_DATE`. |
| `GET /goods-verify-tasks?date=&status=&shelfCode=` | The work queue: `{id, taskDate, shelfCode, status, movementsCount, verifiedBy, verifiedAt}[]`, ordered by shelf code. No org filter (see below). |
| `GET /goods-verify-tasks/:id` | `{task}` only — all fields + `movements` jsonb + `verifiedBy/At`/`createdDate`. 404 `goods_verify_task_not_found`. |
| `POST /goods-verify-tasks/:id/verify` | `{}` (actor from JWT) → the updated queue row. Pure `pending → verified` confirmation + `verified_by/at` + a `transaction_logs` transition row; **no stock/lot movement**. 400 `actor_not_found`, 404 `goods_verify_task_not_found`, 409 `goods_verify_task_not_pending`. |

Changes vs old: the old browse endpoints (`/shelves/with-box-counts`,
`/shelves/:code/boxes`, box detail) are superseded by the task queue; the
2026-10 redesign also dropped the per-lot `countedQty`/ADJUST verify and the
box `closed→verified` transition. `allowedOrgIds` does **not** scope this queue
(`goodsverify.ts` uses no org filter); the status vocabulary declares `skipped`
but nothing writes it.

## Stock search

Implemented: `GET /stock-search` (see `apps/backend/src/routes/stocksearch.ts`
+ `src/db/stocksearch.ts`; read-only — no actorId, no mutations). One query
returns the matching lots (part identity embedded), and the distinct `parts`
list with `onHandQty = Σ total_qty` over those lots is stitched in TS. All
filters optional and ANDed: `partNo` is a case-insensitive substring on
`parts.part_no` **or** `parts.wcl_item_no`, normalized like scan matching
(uppercase + whitespace stripped, both sides); `drawingNo` is the same
normalized-substring match on `inventory_lots.drawing_no`; `shelfCode`, `brand`
(parts.brand), `zone` (the shelf's zone via the shelves join), `orgId` and
`subInventoryCode` are
multi-value any-of filters (repeat the query param); `supplierCode` (also
multi-value) traces the lot via
`inventory_lot_sources` → invoice items → invoices →
`receiving_orders.supplier_code` (the old join). Lot rows also carry the
part's `description`/`brand` and the shelf's `zone`. Zero-qty lots are returned,
mirroring the old `/stock-search/parts/lots` (its >0 rule was only the
suppliers-stats CTE and a client-side toggle). Order: `part_no`, `date_code
NULLS LAST`, `shelf_code`, `box_id`.

| Endpoint | Description |
|---|---|
| `GET /stock-search?supplierCode=&partNo=&drawingNo=&shelfCode=&zone=&brand=&orgId=&subInventoryCode=&location=&dateCodeFrom=&dateCodeTo=` | One call → `{parts[{id, partNo, wclItemNo, description, onHandQty}], lots[{lotId, partNo, wclItemNo, description, brand, dateCode, lotCode, coo, cow, drawingNo, shelfCode, zone, boxId, orgId, subInventoryCode, totalQty, allocatedQty, availableQty}]}` (`drawingNo` = `inventory_lots.drawing_no`; `lotId` = the lot PK, surfaced for the admin lot-history drill-down §Admin audit). Multi-value filters repeat the query param. `location` is the combined location filter — repeated `"orgId:subInventoryCode"` values matched as EXACT `(org_id, sub_inventory_code)` pairs (no org × code cross-product), used by the admin's combined location dropdown; `orgId`/`subInventoryCode` remain as independent any-of dimensions for backwards compatibility. `drawingNo` is a normalized case-insensitive substring on `il.drawing_no` (same uppercase + whitespace-stripped semantics as `partNo`). `dateCodeFrom`/`dateCodeTo` are canonical YYWW string-range bounds (lexicographic = chronological); lots with NULL/invalid date codes never match once a bound is set. **Opt-in paging:** adding `?page=` (1-based; optional `pageSize` default 50 max 200, `sort`, `dir=asc|desc`) switches the response to `{rows, total}` (lot rows only — no `parts` aggregate); `sort` is a key whitelist (the admin lots-table column keys: `partNo`, `description`, `brand`, `drawingNo`, `dateCode`, `lotCode`, `shelfCode`, `zone`, `boxId`, `orgSubInventory`, `totalQty`, `allocatedQty`, `availableQty`; unknown keys fall back to the default order, which is always appended as tiebreakers). Without `page` the legacy full `{parts, lots}` response is returned unchanged (the PDA uses that). |
| `GET /stock-search/options` | Filter values for the dropdowns → `{brands[], zones[], shelves[{code, zone}], locations[{orgId, subInventoryCode, description, officeCode}]}`: brands/zones/shelves are distinct values present in the current stock; `locations` is every `org_info` pair within the allowed orgs (stocked or not), so the location filter covers the full master — and it is limited to the caller's `user_profiles` sub-inventory scope when one is set (no scope row / empty scope = unrestricted; NULL-coded `org_info` rows stay visible). The admin shows one combined location dropdown labeled `office_code / code — description` and grouped by org (same allowed-org scope). |
| `GET /stock-search/summary` | Overall (unfiltered) totals for the admin summary header → `{partCount, lotCount, totalQty, allocatedQty, availableQty, shelfCount, lastUpdateDate, outdatedYears, outdatedPartCount, outdatedLotCount, outdatedQty}` — distinct parts in stock, Σ quantities, distinct shelves holding stock, the newest lot `last_update_date` (ISO string, null when empty), and outdated stats: lots whose canonical YYWW date code is older than flow config `outdatedStockYears` (default 2) (same allowed-org scope). |

Changes vs old: one query endpoint ends the 3-call cascade; location returned
as fields (client formats labels — no server-side `location_label` string).

## Upstream sync

**The server-to-server ingest HTTP API was retired 2026-08-18**, and the
ElectricSQL sync service was removed 2026-08-20. Upstream data no longer
arrives over HTTP, nor is it pulled by an embedded Electric consumer. Instead,
an external sync service is responsible for replicating master data and orders
into the warehouse backend.

The backend exposes one integration surface for that service:

1. **Outbound table-change feed** — the trigger-written `sync_events` table.
   The external service reads it directly (the `GET /sync-events?since=`
   poll endpoint was removed 2026-10) to learn what changed locally, using
   the monotonic `id` as its resume cursor. Only writes
   committed by the backend's own `warehouse` role are recorded; the service's
   own `warehouse_sync` role writes are skipped, breaking the circular-event
   loop. See `docs/backend/event-catalog.md` for the full contract.

Inbound writes are the service's own job: it writes the business tables
directly over SQL as the `warehouse_sync` role (idempotent upserts keyed by
the natural keys — `receiving_orders.batch_no`, the caller-supplied picking
`id`, `parts.wcl_item_no`), so its writes never echo back into the outbound
feed. `supplier_profiles` is NOT synced — it stays local-only.

There is no dedicated sync consumer in this repo anymore; the external service
brings its own transport. The `warehouse_sync` DB role (password from
`SYNC_DB_PASSWORD`, default `warehouse_sync`) is created idempotently for the
service to write into the business tables.

Known caveat: NULL `receiving_invoice_items.sub_inventory_code` is defaulted by
a rule Sean ships later.

### UAT allocation recovery

In dev/UAT the upstream service deletes and re-seeds inventory each night; the
`allocations` FKs cascade those deletes but nothing repairs the
`inventory_lots.allocated_qty` / `picking_items.allocated_qty` counters or the
order allocation summaries. With `UAT_ALLOCATION_RECOVERY=on` (default off) the
backend runs a daily job (`startAllocationSnapshotCron` in
`apps/backend/src/jobs/allocationSnapshot.ts`, started from `src/server.ts`):
snapshot all picking allocations at `ALLOCATE_BACKUP` (default `17:45:00+0800`),
restore the latest snapshot at `ALLOCATE_RECOVER` (default `08:00:00+0800`) after
the upstream refresh. Both settings use `HH:mm:ss±HHmm`, so scheduling is
independent of the server time zone. There is no boot
catch-up, so starting the backend after the upstream cleanup never overwrites a
useful snapshot with an empty one. The same operations are exposed manually via
`POST /admin/allocation/snapshot` / `POST /admin/allocation/restore`. Spec
`docs/superpowers/specs/2026-10-26-uat-allocation-snapshot-restore-design.md`.

## Bug reports

In-app "Report a bug" inbox (spec
`docs/superpowers/specs/2026-11-05-in-app-bug-report-design.md`): any
authenticated user submits the report from the current screen; the admin
triage queue folds rows into the UAT tracker via `uat_ref` (one-way sync —
the table is the inbox, `docs/uat` stays the ledger). No SSE topic; the admin
page refetches on mount. `BUG_REPORT_WEBHOOK` (optional) pings a chat
incoming-webhook fire-and-forget on insert.

| Endpoint | Description |
|---|---|
| `POST /bug-reports` | `{app, route, category, note, context, trail, photo?, photoMime?}` → `{id}` (201). Reporter + groups come from the JWT, never the body; `warehouse_code` column and `context.server` = `{warehouseCode, groupCodes, flow: {allowedOrgIds, dateCodeFormat, flowSteps}}` snapshot are stamped server-side at insert (debug context + future cross-warehouse upstream sync). 400 empty note / bad app / unknown category, 413 trail > 200 KB or photo > 5 MB (base64). Categories: `scan_failed` \| `date_code` \| `wrong_data` \| `missing_data` \| `duplicate` \| `label_print` \| `blocked` \| `slow` \| `ui_text` \| `login` \| `other` |
| `GET /admin/bug-reports?status=&category=` | Light list newest-first (no trail/note/photo; `hasPhoto` flag + `warehouseCode`), max 500 rows. |
| `GET /admin/bug-reports/:id` | Full row incl. note, context, trail, photo (base64). |
| `PATCH /admin/bug-reports/:id` | `{status?, uatRef?, category?}` — queue status `open` → `triaged` → `closed`. |
| `DELETE /admin/bug-reports/:id` | Remove a report. |
| `GET /admin/bug-reports/count` | Unread count (open + triaged) for the sidebar badge. |

## Dev

| Endpoint | Description |
|---|---|
| `POST /dev/allocate` | Fleet-wide allocation rebuild (dev/test only; bearer token required). |
| `GET /dev/lab` (+ `…/data`, `…/parts`, `…/label`, `…/barcode`) | Dev Lab: generate supplier-label barcodes for PDA testing — editable qty/date/lot/COO/serial per supplier template, round-trip verified against the real decoder. Build randomizes the serial field on every click. Spec `docs/superpowers/specs/2026-11-04-dev-lab-label-generator-design.md`. |
| `GET /dev/lab/receiving-cn` (+ `…/orders`, `…/orders/:batchNo/items`) | Dev Lab variant driven by a receiving CN order: pick the order by `batch_no`, then one of its items — label fields prefill from it (part/WCL item no, qty, lot, COO, drawing no). Read-only. |
| `GET /dev/lab/picking` (+ `…/orders`, `…/orders/:id/items`) | Dev Lab variant driven by a picking order: pick the order, then one of its items (brand + MPN resolved via `parts` on `wcl_item_no`) — label fields prefill from it. Read-only. |
