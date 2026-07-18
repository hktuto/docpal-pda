# Backend API Design

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
   - **`actorId` in the body of every mutation** (never a query param).
6. **Errors:** proper HTTP status (400 invalid, 404 missing, 409 conflict) +
   plain-text snake_code message body (e.g. `receiving_order_not_found`).

## Auth (implemented)

| Endpoint | Body → Response | Note |
|---|---|---|
| `POST /auth/login` | `{username, password}` → 200 `{id, username, displayName, role}` / 401 | plain-text compare, demo |
| `POST /auth/logout` | — → `{ok: true}` | no-op (stateless) |
| `GET /auth/users/:id` | — → AuthUser / 404 | |

No tokens/sessions yet; `actorId` travels in mutation bodies (demo trust model).

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
| `GET /receiving-orders/:id/picking` | Picking section: `pickingOrders[{id, refNo, status, shipTo, customerCode, items[{id, partId, partNo, qty, pickedQty, allocatedQty, requiredDateCode, allocations[{id, qty, lot{shelfCode, boxId, dateCode, lotCode, coo, cow}, receivingInvoiceItemId, boxId}], packages[{id, qty, dateCode, lotCode, verified, shippingBoxId}], transitionLogs[{fromState, toState, actorId, createdAt}]}], boxes[{id, status, boxSize, grossWeight, netWeight}]}]`. |
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
when nothing remains).

| Endpoint | Description |
|---|---|
| `GET /put-away/candidates` | List of receivable orders with per-order received/unboxed counts. |
| `GET /receiving-orders/:id/put-away` | One aggregate: `{order, items[], lots[], scans[], boxes[{..., items[]}]}` for the put-away detail screen. `items[]` = the order's expected (receivable) invoice items `{id, partId, partNo, qty, receivedQty, pickedQty, putAwayQty, allocatedQty, remainingQty, dateCode, lotCode, coo, cow}` with `remainingQty = received − picked − put_away − allocated − staged` (the candidates-list formula). |
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
`POST /packages/:id/verify`, `POST /picking-orders/:id/boxes`,
`PATCH /shipping-boxes/:id`, `POST /shipping-boxes/:id/packages`,
`DELETE /shipping-boxes/:id/packages/:packageId`,
`POST /shipping-boxes/:id/add-all-unboxed`,
`POST /shipping-boxes/:id/cancel`, `POST /shipping-boxes/:id/close`,
`POST /picking-orders/:id/finish`, `POST /picking-orders/report-issues` (see
`apps/backend/src/routes/picking.ts` + `src/db/picking.ts`; scan consumes the
allocation's source — lot `total_qty`/`allocated_qty`, receiving
`picked_qty`, or FIFO distribution across an order-level receiving source —
into `picking_packages` + two PICK ledger rows (reserved −qty / on_hand −qty)
per portion, removal reverses; `picked_qty` tracks boxed packages so the last
box add auto-finishes the order with a `measuring_tasks` row; scan/removal run
`allocateAll` best-effort).

| Endpoint | Description |
|---|---|
| `GET /picking-orders?status=` | List: `{id, refNo, status, poNo, shipTo, customerCode, destinationCountry, deliveryDate, warehouseCode, warehouseSectionCode, subInventoryCode, itemCount, totalQty, pickedQty}`. |
| `GET /picking-orders/:id` | Nested detail: `{order..., measuringTask, items[{..., allocations[{..., lot|receivingItem, boxId}], packages[]}], boxes[{..., packageCount}]}`. No parallel arrays. |
| `POST /picking-items/:id/scan` | `{actorId, allocationId|source, qty, raw?}` → `{packageIds}`. The one canonical scan-to-pick route; OCR/receiving-source picking folds in here (old `ocr-pick` path dies). |
| `DELETE /packages/:id` | `{actorId}` → removes an unboxed (unverified) package. |
| `POST /packages/:id/verify` | `{actorId}`. |
| `POST /picking-orders/:id/boxes` | `{actorId}` → box. |
| `PATCH /shipping-boxes/:id` | `{boxSize?, netWeightG?, grossWeightG?, destinationCountry?, actorId}` (grams, one unit everywhere). |
| `POST /shipping-boxes/:id/packages {packageId, actorId}` · `DELETE /shipping-boxes/:id/packages/:packageId` | Box membership. |
| `POST /shipping-boxes/:id/add-all-unboxed` | `{actorId}` → `{packed}`. |
| `POST /shipping-boxes/:id/cancel` · `/close` | `{actorId}`. |
| `POST /picking-orders/:id/finish` | `{actorId}` → creates the `measuring_tasks` row. |
| `POST /picking-orders/report-issues` | `{actorId, entries: [{pickingOrderId, reason, qty?, packSize?, note?, remark?}]}` → `{reported[], skipped[]}`. Per-order entries — no `"; "`-joined remark hack. |

Changes vs old: flat-by-id mutations only (nested twins die); polymorphic
`DELETE /packages/:id` split into remove vs box-membership `DELETE`; one
weight unit (grams); nested detail kills client joins.

## Measuring

Implemented: `GET /measuring-tasks`, `GET /measuring-tasks/:id`,
`POST /measuring-tasks/:id/complete` (see
`apps/backend/src/routes/measuring.ts` + `src/db/measuring.ts`; list computes
`boxCount`/`closedBoxCount` server-side — closed = any status but `open`;
detail is the one consolidated task/order/boxes read with part identity on the
packages; complete guards pending → all boxes closed → nothing unboxed (the
old "picking item not fully packed" guard, which in this schema is "no
unboxed packages" since `picked_qty` tracks boxed-only), sets `completed` +
transition log, no stock movement, and leaves the picking order `finished`
like the old `completeMeasuringTask`. Box measurement reuses the picking
routes: `PATCH /shipping-boxes/:id`, `POST /packages/:id/verify`,
`POST /shipping-boxes/:id/close`).

| Endpoint | Description |
|---|---|
| `GET /measuring-tasks?status=` | List: `{id, status, pickingOrderId, refNo, shipTo, boxCount, closedBoxCount, createdAt}`. |
| `GET /measuring-tasks/:id` | Consolidated detail: `{task, order, boxes[{..., packages[{..., partId, partNo}]}]}`. The one "order + boxes + packages" read. |
| `POST /measuring-tasks/:id/complete` | `{actorId}`. |

Changes vs old: `GET /shipping-boxes/:id/for-measuring` and the competing
picking-detail bundle are superseded by this one shape (packages carry
`partId`/`partNo` — no second request, no client-side matching).

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
stripped, both sides), `shelfCode` is exact, `supplierId` traces the lot via
`inventory_lot_sources` → invoice items → invoices →
`receiving_orders.supplier_id` (the old join). Zero-qty lots are returned,
mirroring the old `/stock-search/parts/lots` (its >0 rule was only the
suppliers-stats CTE and a client-side toggle). Order: `part_no`, `date_code
NULLS LAST`, `shelf_code`, `box_id`.

| Endpoint | Description |
|---|---|
| `GET /stock-search?supplierId=&partNo=&shelfCode=` | One call → `{parts[{id, partNo, wclItemNo, description, defaultCoo, onHandQty}], lots[{partId, dateCode, lotCode, coo, cow, shelfCode, boxId, warehouseCode, warehouseSectionCode, subInventoryCode, totalQty, allocatedQty, availableQty}]}`. |

Changes vs old: one query endpoint ends the 3-call cascade; location returned
as fields (client formats labels — no server-side `location_label` string).

## Ingest (server-to-server)

Implemented: `PUT /receiving-orders/:externalId`,
`PUT /picking-orders/:externalId` (see `apps/backend/src/routes/ingest.ts` +
`src/db/ingest.ts`; camelCase bodies, idempotent upserts keyed by the new
`external_id` columns, business-key map reconciles — receiving invoices by
`invoiceNo`, receiving items by `partId + poNo + poLine`, picking items by
`partId + requiredDateCode` — no ledger rows, `allocateAll` best-effort after
commit when a changed upsert touches an order with allocation demand).
`supplierCode`/`partNo`/`customerCode` resolve to their master rows
(400 `unknown_supplier` / `unknown_part` / `unknown_customer`), direct ids are
also accepted.

| Endpoint | Description |
|---|---|
| `PUT /receiving-orders/:externalId` | Idempotent upsert `{order, invoices[{..., items[]}]}` → `{id, externalId, created, changed}`, 201/200. |
| `PUT /picking-orders/:externalId` | Same pattern (`{order, items[]}`), items reconciled by business key. |

Kept as-is (right shape). Internal cleanups (O(n²) reconcile, HTTP coupling)
are implementation work, not API design.

## Dev

| Endpoint | Description |
|---|---|
| `POST /dev/reset` | Truncate + reseed (demo only). |
