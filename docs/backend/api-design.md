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

## Auth (implemented)

| Endpoint | Body → Response | Note |
|---|---|---|
| `POST /auth/login` | `{username, password}` → 200 `{user{id, username, displayName, groupCodes}, token}` / 401 / 403 | when `DOCPAL_URL` is set: DocPal-verified, auto-provisioned, 403 `user has no WMS access` when no group maps; otherwise scrypt verify (+ lazy upgrade of legacy plain-text rows) |
| `POST /auth/logout` | — → `{ok: true}` | no-op (client discards the token) |
| `GET /auth/me` | — → AuthUser / 401 | session restore from the bearer token |
| `GET /auth/users/:id` | — → AuthUser / 404 | |

JWT bearer (HS256, `hono/jwt`, secret from `AUTH_SECRET`, 12 h TTL) required on
all routes except `/health`, `POST /auth/login`, and `/dev/*`; `GET /events`
also accepts `?token=` (EventSource can't set headers). Users belong to groups
via `user_group_members` (many-to-many); `users.role` is gone. When
`DOCPAL_URL` is set, login is delegated to the DocPal API and local users are
auto-provisioned (spec `docs/superpowers/specs/2026-08-13-docpal-auth-design.md`);
otherwise: `docs/superpowers/specs/2026-07-21-real-login-design.md`.

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
`src/db/scanParse.ts`; confirm-arrival applies full receipt + date-code
fallback, scan applies QR-template-parsed partial receipts moving the order to
`provisional_received`, both write RECEIVE_TO_DOCK ledger rows + transition
logs and run `allocateAll` best-effort; scans carrying a serial (`serialNo`
template group or explicit body field) are deduped per order via
`receiving_scan_labels` — a repeat is 409 `label_already_scanned`).

| Endpoint | Description |
|---|---|
| `GET /receiving-orders?status=` | List. Rows: `{id, refNo, status, deliveryDate, dateCode, supplierCode, supplierName, warehouseCode, warehouseSectionCode, subInventoryCode, invoiceCount, itemCount, remainingItems, pendingPickingOrders}`. `remainingItems` = items with `put_away_qty < qty`; `pendingPickingOrders` = distinct pending/picking orders allocated to this RO (via `allocations.receiving_order_id` or via receiving item). |
| `GET /receiving-orders/:id` | Detail: `{order..., supplier{...profile fields}, invoices[{..., items[{..., part, allocatedQty, mismatch}]}]}` — nested; `allocatedQty` embedded per item (no `allocated_by_item` map). |
| `GET /receiving-orders/:id/picking` | Picking section: `pickingOrders[{id, refNo, status, shipTo, customerCode, items[{id, partId, partNo, qty, pickedQty, allocatedQty, requiredDateCode, allocations[{id, qty, lot{shelfCode, boxId, dateCode, lotCode, coo, cow}, receivingInvoiceItemId, boxId}], packages[{id, qty, dateCode, lotCode, verified, shippingBoxId}], transitionLogs[{fromState, toState, actorId, createdDate}]}], boxes[{id, status, boxSize, grossWeight, netWeight}]}]`. |
| `POST /receiving-orders/:id/confirm-arrival` | `{actorId}` → order with `status: "in_hand"`; applies receipt, writes txns, recalculates allocations (concept 5). |
| `POST /receiving-orders/:id/scan` | `{actorId, raw}` (or parsed fields, incl. `serialNo`) → server-side parse/match/apply; single match auto-applies, else candidates. A parsed/explicit `serialNo` (S-key) is recorded in `receiving_scan_labels` (unique per order) — a repeat serial → 409 `label_already_scanned`; scans without a serial skip dedup. Supersedes `scan-candidates` (client no longer mirrors matching logic). |
| `GET /receiving-invoice-items/:id/mismatch` | Active mismatch or `null` (item-keyed, on the new flat mismatch columns). |
| `POST /receiving-invoice-items/:id/mismatch` | `{actorId, reason, mismatchQty?, wrongPartNo?, note?}` → item. |
| `PATCH /receiving-invoice-items/:id/mismatch` | Edit pending mismatch. |
| `POST /receiving-invoice-items/:id/mismatch/confirm` · `/cancel` | `{actorId}` → item. |

Changes vs old: `/picking` returns nested DTOs with logs embedded per item —
`POST /picking-items/transition-logs` dies; scan-candidates dies (server-side
matching); confirm-arrival records the actor; mismatch runs on the new flat
item columns (no separate mismatch table).

## Scan support

Implemented: `GET /scan-templates` (see
`apps/backend/src/routes/scantemplates.ts` + `src/db/scantemplates.ts`).
Receiving scans parse server-side, but picking / put-away / measuring scans
validate labels on the client — this public read hands the client every
supplier's QR template + qty encoding (from `supplier_profiles`) so it never
hardcodes templates.

| Endpoint | Description |
|---|---|
| `GET /scan-templates` | → `[{supplierCode, qrTemplate, qtyEncoding}]`, every profile ordered by `supplier_code`; `qrTemplate` null when the supplier has none (clients filter). |

## Label printing

Implemented: `GET /labels-data` (see `apps/backend/src/routes/labels.ts` +
`src/db/labels.ts`). One aggregate read behind the web `/print-labels` page:
shelf boxes (with current lot contents), distinct shelf codes, every
open receiving order's invoices/items, current shelf-stock lots, and
`pickLabels` — one label per open-order allocation with the exact share qty
(a lot/carton split across orders gets one label per share). Part-label
`qrValue`s are built per the supplier QR template (`encodeKoaQty` /
`buildKoaLabelRaw` in `src/db/scanParse.ts`; null for template-less
suppliers); receiving items and lots carry `pickingOrderRefs` for page
filtering. Read-only.

| Endpoint | Description |
|---|---|
| `GET /labels-data` | → `{generatedAt, shelfBoxes, shelfCodes, receivingOrders, shelfLots, pickLabels}`. |

## Put-away

Implemented: `GET /put-away/candidates`,
`GET /receiving-orders/:id/put-away`,
`POST /receiving-orders/:id/put-away-scans`, `DELETE /put-away-scans/:scanId`,
`POST /shelf-boxes`,
`DELETE /shelf-boxes/:id`, `POST /shelf-boxes/:id/scans`,
`DELETE /shelf-boxes/:id/scans/:scanId`,
`POST /shelf-boxes/:id/add-all-unboxed`, `POST /shelf-boxes/:id/close` (see
`apps/backend/src/routes/putaway.ts` + `src/db/putaway.ts`; staging-box model —
scans are `shelf_box_items` rows in the per-order `shelf_code IS NULL` box,
assign materializes the inventory lot stamped with the shelf's
warehouse/section/sub-inventory + `inventory_lot_sources` + `put_away_qty` and
writes two PUT_AWAY ledger rows (dock −qty / on_hand +qty), remove reverses,
assign/remove/add-all run `allocateAll` best-effort, in-hand orders auto-clear
when nothing remains). Task mode (spec
`docs/superpowers/specs/2026-08-10-put-away-tasks-design.md`): when flow
config `steps.put-away.autoCreateTasks` is on, confirming an arrival
creates a `put_away_tasks` row (one per order, `pending`, unique per order) in
the same tx; the auto-clear completes it. The PDA then works from the task
queue instead of the derived candidates list.

| Endpoint | Description |
|---|---|
| `GET /put-away/candidates` | List of receivable orders with per-order received/unboxed counts. |
| `GET /put-away-tasks?status=` | Task queue (task mode), oldest first: `{id, status, receivingOrderId, batchNo, supplierCode, supplierName, orgId, subInventoryCode, receivedItems, unboxedItems, createdDate}`. |
| `GET /put-away-tasks/:id` | The per-order put-away aggregate + `{task}`; 404 `put_away_task_not_found`. |
| `GET /receiving-orders/:id/put-away` | One aggregate: `{order, items[], lots[], scans[], boxes[{..., items[]}]}` for the put-away detail screen. `items[]` = the order's expected (receivable) invoice items `{id, partId, partNo, qty, receivedQty, pickedQty, putAwayQty, allocatedQty, remainingQty, dateCode, lotCode, coo, cow}` with `remainingQty = received − picked − put_away − allocated − staged` (the candidates-list formula), each carrying the advisory per-item `suggestedShelfCode`/`suggestedBoxId`/`suggestionReason` (existing-stock strategy unless `steps.put-away.suggestShelf=off`). |
| `POST /receiving-orders/:id/put-away-scans` | `{actorId, raw|fields, qty}` → complete scan row (no fix-up query). |
| `DELETE /put-away-scans/:scanId` | `{actorId}` → hard-delete a staged scan (mis-scan correction); 409 `scan_not_in_staging_box` for boxed scans (use remove-from-box). |
| `POST /shelf-boxes` | `{receivingOrderId, shelfCode?, actorId}` → box. |
| `POST /shelf-boxes/:id/scans {scanId, actorId}` · `DELETE /shelf-boxes/:id/scans/:scanId` | Assign / remove one scan. |
| `POST /shelf-boxes/:id/add-all-unboxed` | `{actorId}` → `{count}`. |
| `POST /shelf-boxes/:id/close` · `DELETE /shelf-boxes/:id` | Close / cancel (cancel body `{actorId}`). |

Changes vs old: one aggregate read replaces the 3-call stitch; uniform
`actorId` bodies; verbs reduced to membership + lifecycle actions; put-away
materializes inventory lots (concept: lot + `inventory_lot_sources` +
`inventory_transactions` PUT_AWAY rows).

## Picking

Implemented: `GET /picking-orders`, `GET /picking-orders/:id`,
`POST /picking-items/:id/scan`, `DELETE /packages/:id`,
`POST /picking-orders/:id/claim-shelf-box`,
`POST /packages/:id/verify`, `POST /picking-orders/:id/boxes`,
`PATCH /shipping-boxes/:id`, `POST /shipping-boxes/:id/packages`,
`DELETE /shipping-boxes/:id/packages/:packageId`,
`POST /shipping-boxes/:id/add-all-unboxed`,
`POST /shipping-boxes/:id/scan`,
`POST /shipping-boxes/:id/cancel`, `POST /shipping-boxes/:id/close`,
`POST /shipping-boxes/:id/reopen`,
`POST /picking-orders/:id/finish`, `POST /picking-orders/report-issues` (see
`apps/backend/src/routes/picking.ts` + `src/db/picking.ts`; scan consumes the
allocation's source — lot `total_qty`/`allocated_qty`, receiving
`picked_qty`, or FIFO distribution across an order-level receiving source —
into `picking_packages` + two PICK ledger rows (reserved −qty / on_hand −qty)
per portion, removal reverses; `picked_qty` tracks boxed packages so the last
box add auto-finishes the order — no next-step task is created (box-scoped
design; see "Measuring"/"Verify" below); scan/removal run `allocateAll`
best-effort).

| Endpoint | Description |
|---|---|
| `GET /picking-orders?status=` | List: `{id, refNo, status, allocationStatus, allocatedQty, poNo, shipTo, customerCode, destinationCountry, deliveryDate, warehouseCode, warehouseSectionCode, subInventoryCode, itemCount, totalQty, pickedQty}`. `allocationStatus` is the persisted order-level summary (`unallocated`/`partial`/`allocated`, recomputed by `allocateAll`); `allocatedQty` = Σ item `allocated_qty`. `?status=` accepts `shipped`. |
| `GET /picking-orders/:id` | Nested detail: `{order..., items[{..., allocations[{..., lot|receivingItem, boxId}], packages[]}], boxes[{..., packageCount}], suggestedBox}`. No parallel arrays. `suggestedBox` (null when none or the order is not active) is the whole-box claim hint: a fully-claimable shelf box whose current `inventory_lots` contents exactly equal the order's remaining demand `{id, shelfCode, orgId, subInventoryCode, contents[{partNo, qty}]}`. |
| `POST /picking-orders/:id/claim-shelf-box` | `{shelfBoxId}` (actor from the token) → `{shippingBoxId, packageIds}`, 201. Whole-box exact-match claim (spec `docs/superpowers/specs/2026-07-29-whole-box-picking-claim-design.md`): the shelf box's current contents must exactly equal the order's full remaining open demand (409 `box_not_exact_match`) with no other order reserving any piece (409 `box_not_fully_available`). The carton is reused as the shipping box — created prefilled with `box_size`/`net_weight`/`gross_weight` summed from the source receiving lines' `additional_data` (g→kg via `weightUnit`, default kg), `source_shelf_box_id` recorded — with one boxed package per (item, lot) portion, the order's allocations released, and the auto-finish chain run like the scan path. |
| `POST /picking-items/:id/scan` | `{actorId, allocationId|source, qty, raw?}` → `{packageIds}`. The one canonical scan-to-pick route; OCR/receiving-source picking folds in here (old `ocr-pick` path dies). |
| `DELETE /packages/:id` | `{actorId}` → removes an unboxed (unverified) package. |
| `POST /packages/:id/verify` | `{actorId}` — package must be boxed (409 `package_not_in_box`). Measuring pass: the box is **open**, sets `verified` (no task involved). Verify pass: the box is **closed** and must carry a pending verify task (409 `no_pending_measure_or_verify_task`), sets `verified` + `verify_verified` (409 `package_already_verified` per the applicable flag). |
| `POST /picking-orders/:id/boxes` | `{actorId}` → box. |
| `PATCH /shipping-boxes/:id` | `{boxSize?, netWeightKg?, grossWeightKg?, destinationCountry?, actorId}` (kilograms, one unit everywhere — decimals allowed, rounded to 3 dp; 400 `invalid_net_weight_kg` / `invalid_gross_weight_kg`). |
| `POST /shipping-boxes/:id/packages {packageId, actorId}` · `DELETE /shipping-boxes/:id/packages/:packageId` | Box membership. Cross-order packing: any open picking order's unboxed package may be added to the box (the old 409 `different_picking_orders` guard is gone; `shipping_boxes.picking_order_id` stays as the informational "created for" order only). |
| `POST /shipping-boxes/:id/scan` | `{barcode, qty?, actorId}` → `{packageIds}`, 201. Scan-to-box across orders: resolves the barcode to the one open picking item it could mean across **all** orders (part_no or `wcl_item_no` match on an item of a pending/picking order with open qty and a remaining allocation; 404 `no_matching_picking_item`, 409 `ambiguous_picking_item`), then picks it straight into this box via the scan path (default qty = the item's open qty capped by the allocation's remaining). |
| `POST /shipping-boxes/:id/add-all-unboxed` | `{actorId}` → `{packed}`. Stays scoped to the box's creator order. |
| `POST /shipping-boxes/:id/cancel` · `/close` | `{actorId}`. Close guards: non-empty, every package `verified`, destination (box → creator order's ship_to), box size, positive weights (gross ≥ net). Closing IS the measuring completion — and, when the verify step is enabled, spawns the box's pending verify task in the same tx (`ON CONFLICT DO NOTHING`, idempotent on re-close). |
| `POST /shipping-boxes/:id/reopen` | `{actorId}` — verify-step re-measure, box-scoped: the box's own pending verify task is required (409 `verify_task_not_pending`); closed box → `open` + packages un-verified (both `verified` and `verify_verified`; 409 `shipping_box_not_closed`). |
| `POST /picking-orders/:id/finish` | `{actorId}` → `{id, status}` — flips the order to `finished` (409 `not_all_items_fully_boxed` until every item is fully picked/boxed). No next-step task is created anymore: closing a box is the measuring completion, and the box's verify task comes from `closeShippingBox`. |
| `POST /picking-orders/report-issues` | `{actorId, entries: [{pickingOrderId, reason, qty?, packSize?, note?, remark?}]}` → `{reported[], skipped[]}`. Per-order entries — no `"; "`-joined remark hack. |

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
boxes that contain packages; a box may hold packages from several picking
orders (cross-order packing), so order numbers are aggregated per box. Box
measurement itself reuses the picking routes: `PATCH /shipping-boxes/:id`,
`POST /packages/:id/verify`, `POST /shipping-boxes/:id/close`.

| Endpoint | Description |
|---|---|
| `GET /measuring-boxes` | The work list: open boxes with at least one package, newest first — `{boxId, status, orderNos[], packageCount, verifiedCount, createdDate}`. |
| `GET /measuring-boxes/:id` | Box detail: `{boxId, pickingOrderId, status, boxSize, grossWeight, netWeight, destinationCountry, shippedAt, createdDate, suggestedNetWeightKg, packages[{..., partNo, wclItemNo, verified, verifyVerified}]}` (404 `shipping_box_not_found`). `suggestedNetWeightKg` = Σ over the box's packages of `(formula.weight / formula.qty) × pkg.qty` grams from `net_weight_formula`, in kg (3 dp; parts without a formula contribute 0, `null` when none have one). |

Changes vs old: `GET /measuring-tasks*` and
`POST /measuring-tasks/:id/complete` are deleted — the box-keyed read
supersedes the consolidated task detail (packages carry `partNo`/`wclItemNo`
— no second request, no client-side matching).

## Verify

Implemented: `GET /verify-tasks`, `GET /verify-tasks/:id`,
`POST /verify-tasks/:id/complete` (see `apps/backend/src/routes/verify.ts` +
`src/db/verify.ts`; spec
`docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`).
Verify tasks are keyed on the shipping box (`verify_tasks.shipping_box_id`,
unique — one task per box), created by `closeShippingBox` when the verify
step is enabled (`ON CONFLICT DO NOTHING` keeps a re-close idempotent).
Verify is a second full re-scan pass over that one box: the worker re-scans
every package (`verify_verified`; scanning works on the closed box — checking
contents against the sealed box is the normal pass), then completes.
Completion guards: pending task → box closed → every package re-scanned →
`completed` + transition log, no stock movement. Box re-work reuses the
picking verbs, including the verify-only `POST /shipping-boxes/:id/reopen`
(returns a closed box to `open` with its packages un-verified on both flags,
requires the box's pending verify task).

| Endpoint | Description |
|---|---|
| `GET /verify-tasks?status=` | List: `{taskId, status, shippingBoxId, boxStatus, orderNos[], destinationCountry, packageCount, verifyVerifiedCount, createdDate}`. |
| `GET /verify-tasks/:id` | Detail: `{task{id, status, shippingBoxId, createdDate}, box{..., suggestedNetWeightKg}, packages[{..., partNo, wclItemNo, verified, verifyVerified}]}` (404 `verify_task_not_found`). Same per-box shape as the measuring detail. |
| `POST /verify-tasks/:id/complete` | `{actorId}` — 404 `verify_task_not_found`, 409 `verify_task_not_pending`, 409 `shipping_box_not_closed`, 409 `packages_not_all_rescanned` until every package is re-scanned (`verify_verified`). |

## Flow-step config + shipping feed

Implemented: `GET /config`, `GET /shipping-orders`,
`GET /shipping-orders/:boxId`,
`POST /shipping-orders/:boxId/ship` (see
`apps/backend/src/routes/config.ts`, `src/routes/shipping.ts` +
`src/db/shipping.ts`, `src/config.ts`). The flow config — the
`warehouse_config` row key `"flow"` (JSON merged over defaults and validated
at boot; the `FLOW_CONFIG` env var overrides the row when set; legacy
`FLOW_STEPS_DISABLED` comma-separated step keys still map onto step
enablement on top, deprecated) toggles flow steps (`receiving`, `put-away`,
`picking`,
`goods-verify`, `measuring`, `verify`, `stock-search`) and carries behavior
flags; `GET /config` → `{flowSteps, pickingAllocation, putAway}` exposes the
result to clients (the PDA hides disabled home tiles; changes need a backend
restart). The behavior-changing keys: `verify` wires the close chain
(closing a box spawns its pending verify task, and the shipping feed is
gated on completed verify tasks), `goods-verify` makes task generation
(manual + nightly job) a no-op,
`steps.picking.allocation.allowDockStock=false` makes put-away a hard gate
for allocation, and `steps.put-away.autoCreateTasks`/`suggestShelf` switch
put-away to task mode with shelf suggestions; `measuring` and the remaining
steps only toggle PDA home tiles (there is no measuring task to gate).
The shipping feed is per-box: the list reads closed, unshipped boxes — gated
on the box's completed verify task when the verify step is enabled
("measured" ≡ closed). Shipping is a pure workflow transition (stock already
left inventory at pick-scan time): `POST /shipping-orders/:boxId/ship` stamps
the box `shipped_at`/`shipped_by` + transition log and then derives order
`shipped` for every order in the box whose items are all boxed, has nothing
unboxed, and has every box holding its packages shipped. The ship event is
`shipping_box.shipped` (topics `/shipping-orders` + `/picking-orders`).
Shipped boxes drop out of the feed; shipped orders stay visible via
`GET /picking-orders?status=shipped`.

| Endpoint | Description |
|---|---|
| `GET /config` | `{flowSteps: Record<FlowStep, boolean>, pickingAllocation: {allowDockStock: boolean}, putAway: {autoCreateTasks: boolean, suggestShelf: "existing-stock"\|"off"}}` — the resolved flow config (`warehouse_config` row `"flow"`, `FLOW_CONFIG` env override; legacy `FLOW_STEPS_DISABLED` maps onto `flowSteps` on top, deprecated). `pickingAllocation.allowDockStock=false` = put-away is a hard gate for allocation; `putAway` drives the put-away task mode + shelf suggestions. |
| `GET /shipping-orders` | Box rows: `{boxId, orderNos[], shipTos[], destinationCountry, boxSize, grossWeight, netWeight, packageCount, closedAt}` — closed, unshipped boxes (verify-gated when the verify step is on). |
| `GET /shipping-orders/:boxId` | Box detail: `{box{..., shippedAt, shippedBy}, packages[{..., partNo, wclItemNo, verified}], orders[{id, orderNo, status, shipTo, customerCode, poNo}]}` (404 `shipping_box_not_found`). |
| `POST /shipping-orders/:boxId/ship` | `{actorId}` → `{id, status, shippedOrderIds}`. Re-checks the feed predicate (closed, unshipped, verify-gated; 409 `box_not_ready_to_ship` otherwise, including already-shipped boxes), stamps the box, derives order `shipped`, emits `shipping_box.shipped`. |

## Goods verify (task-based, concept 7)

Implemented: `POST /goods-verify-tasks/generate`, `GET /goods-verify-tasks`,
`GET /goods-verify-tasks/:id`, `POST /goods-verify-tasks/:id/verify` (see
`apps/backend/src/routes/goodsverify.ts` + `src/db/goodsverify.ts`; generation
is one set-based `INSERT … SELECT … ON CONFLICT DO NOTHING` off the day's
distinct moved lots — `date` defaults to the DB server's `CURRENT_DATE`
(`txn_at` holds UTC wall-clock), `actorId` optional (system job); the queue
joins parts for `partNo`/`wclItemNo` and orders by shelf/box/part; detail
embeds the lot (batch + three-level location) and the `shelf_boxes` row with
its items (`box` null when `box_id` is unset or a legacy non-shelf-box id);
verify guards pending → count mismatch corrects lot `total_qty` (409
`counted_qty_below_allocated` so generated `available_qty` never goes
negative) + ADJUST `on_hand` ledger row (`reference_type 'goods_verify_task'`,
reason `cycle count adjustment`) → best-effort `allocateAll` after commit,
then marks the box's items verified and transitions the box `closed →
verified` (+ transition log; 409 `shelf_box_not_closed` for an open box —
put-away may still be in progress and a later stock change would reset the
flags anyway; an already-`verified` box is left alone).

| Endpoint | Description |
|---|---|
| `POST /goods-verify-tasks/generate` | `{date?, actorId?}` → `{created, date}`. Day-end generation: distinct lots moved in `inventory_transactions` that day → one task per `(task_date, inventory_lot_id)` (unique constraint = idempotent). `date` defaults to the DB server's `CURRENT_DATE`. |
| `GET /goods-verify-tasks?date=&status=&shelfCode=` | The work queue: `{id, taskDate, shelfCode, boxId, partId, partNo, wclItemNo, expectedQty, status, verifiedBy, verifiedAt}[]`, ordered by shelf/box/part. |
| `GET /goods-verify-tasks/:id` | `{task (all fields + partNo/wclItemNo/description), lot (batch + three-level location + qtys), box {id, status, items[]} \| null}`. 404 `goods_verify_task_not_found`. |
| `POST /goods-verify-tasks/:id/verify` | `{actorId, countedQty?}` → the updated task. `countedQty ≠ expectedQty` updates lot `total_qty` and writes an `inventory_transactions` ADJUST (`on_hand`) row (409 `counted_qty_below_allocated`); box items verified + box `closed → verified` (409 `shelf_box_not_closed`); 409 `goods_verify_task_not_pending`. |

Changes vs old: the old browse endpoints (`/shelves/with-box-counts`,
`/shelves/:code/boxes`, box detail) are superseded by the task queue; the
missing mark-verified endpoint exists by design (no `/verification-tasks`
hack); day-end generation is explicit and idempotent.

## Stock search

Implemented: `GET /stock-search` (see `apps/backend/src/routes/stocksearch.ts`
+ `src/db/stocksearch.ts`; read-only — no actorId, no mutations). One query
returns the matching lots (part identity embedded), and the distinct `parts`
list with `onHandQty = Σ total_qty` over those lots is stitched in TS. All
filters optional and ANDed: `partNo` is a case-insensitive substring on
`parts.part_no` normalized like scan matching (uppercase + whitespace
stripped, both sides), `shelfCode` is exact, `supplierCode` traces the lot via
`inventory_lot_sources` → invoice items → invoices →
`receiving_orders.supplier_code` (the old join). Zero-qty lots are returned,
mirroring the old `/stock-search/parts/lots` (its >0 rule was only the
suppliers-stats CTE and a client-side toggle). Order: `part_no`, `date_code
NULLS LAST`, `shelf_code`, `box_id`.

| Endpoint | Description |
|---|---|
| `GET /stock-search?supplierCode=&partNo=&shelfCode=` | One call → `{parts[{id, partNo, wclItemNo, description, onHandQty}], lots[{partId, dateCode, lotCode, coo, cow, shelfCode, boxId, warehouseCode, warehouseSectionCode, subInventoryCode, totalQty, allocatedQty, availableQty}]}`. |

Changes vs old: one query endpoint ends the 3-call cascade; location returned
as fields (client formats labels — no server-side `location_label` string).

## Upstream sync

**The server-to-server ingest HTTP API was retired 2026-08-18**, and the
ElectricSQL sync service was removed 2026-08-20. Upstream data no longer
arrives over HTTP, nor is it pulled by an embedded Electric consumer. Instead,
an external sync service is responsible for replicating master data and orders
into the warehouse backend.

The backend exposes two integration surfaces for that service:

1. **Outbound table-change feed** — `GET /sync-events?since=<id>&limit=<n>`
   (`src/routes/sync-events.ts`) over the trigger-written `sync_events` table.
   The external service polls this to learn what changed locally. Only writes
   committed by the backend's own `warehouse` role are recorded; the service's
   own `warehouse_sync` role writes are skipped, breaking the circular-event
   loop. See `docs/backend/event-catalog.md` for the full contract.

2. **Inbound apply layer** — the reusable domain functions in
   `src/db/ingest.ts` (`upsertPart`/`deletePart`, `upsertSupplier`, guarded
   `deleteReceivingOrder`/`deletePickingOrder`, …). They are idempotent,
   keyed by natural keys, and run every transaction with
   `app.sync_events_off = 1` (`suppressSyncEvents`) so upstream-originated
   writes do not echo back into the outbound `sync_events` feed. The external
   service can call these functions directly (same Node process) or reimplement
   the same semantics. `supplier_profiles` is NOT synced — it stays local-only.

There is no dedicated sync consumer in this repo anymore; the external service
brings its own transport. The `warehouse_sync` DB role (password from
`SYNC_DB_PASSWORD`, default `warehouse_sync`) is created idempotently for the
service to write into the business tables.

Known caveat: NULL `receiving_invoice_items.sub_inventory_code` is defaulted by
a rule Sean ships later (stub `applyItemSubInventoryDefault` warns today).

## Dev

| Endpoint | Description |
|---|---|
| `POST /dev/reset` | Truncate + reseed (demo only). |
