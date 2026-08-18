# Backend (`apps/backend`) Documentation

The next-generation WMS backend: Hono + Drizzle ORM + PostgreSQL, plus the
`apps/admin` desktop console for master data. This section covers the new
system; the current production demo (`apps/api` + `apps/web`) is documented in
`docs/app-docs/` and `docs/database-schema-api.md`.

- [Key Concepts](./concepts.md) — what the app is and the core business rules
  (receiving structure, warehouse/sub-inventory, date-code fallback,
  allocation strategy, day-end goods verify).
- [Schema Reference](./schema.md) — every table, column, index, and the
  deliberate deltas from the original target DDL.
- [API Design](./api-design.md) — the endorsed API for this backend:
  conventions (camelCase DTOs, complete reads, one canonical route per
  operation) and the route map per flow, including the task-based
  goods-verify API. (Its "`actorId` in mutation bodies" convention is
  superseded by bearer-token auth — see the auth bullet below.)
- [Old API Review](./api-review-old-api.md) — design review of the deprecated
  `apps/api` this replaces (what carried over, what got redesigned and why).

## API surface (current)

- Auth (spec: `docs/superpowers/specs/2026-07-21-real-login-design.md`) —
  JWT bearer auth enforced by global middleware (`src/auth/middleware.ts`) on
  every route except `GET /health`, `POST /auth/login`, and `/dev/*`. Send
  `Authorization: Bearer <token>` on all other calls; `GET /events`
  additionally accepts `?token=` because EventSource cannot set headers.
  Failures are 401 `unauthorized`. The actor for every mutation comes from
  the token (`c.get("user")`) — request bodies no longer carry `actorId`.
  - `POST /auth/login` `{username, password}` →
    `{user: {id, username, displayName, groupCodes}, token}` — scrypt verify
    (`src/auth/password.ts`, `scrypt:N:r:p:salt:hash`); legacy plain-text rows
    are lazily re-hashed on success. 401 `invalid credentials`.
  - `GET /auth/me` → the same `user` object, resolved fresh from the DB by
    token `sub` (client session restore).
  - `GET /auth/users/:id` → the same `user` object for any user.
  - `POST /auth/logout` → `{ok}` no-op (client discards the token; no
    server-side revocation).
  - Tokens are HS256 JWTs (`src/auth/jwt.ts`), payload
    `{sub, username, groupCodes, exp}`, signed with `AUTH_SECRET` (dev default
    + startup warning), TTL `AUTH_TOKEN_TTL_SECONDS` (default 43200 = 12 h).
- `GET /health` — liveness + DB check.
- Receiving flow (`apps/backend/src/routes/receiving.ts`):
  - `GET /receiving-orders?status=` — list with per-order invoice/item counts,
    remaining (not fully put-away) items, and open picking-order demand.
  - `GET /receiving-orders/:id` — nested detail: order + supplier (with
    profile) + invoices → items, each item embedding its part, `allocatedQty`,
    and active mismatch.
  - `GET /receiving-orders/:id/picking` — picking section: picking orders with
    allocations tracing to this order, items embedding their allocations
    (lot or receiving source), packages, and transition logs, plus shipping
    boxes.
  - `POST /receiving-orders/:id/confirm-arrival` (no body) — pending or
    provisional_received → `in_hand` with full receipt, date-code fallback,
    RECEIVE_TO_DOCK ledger rows, a transition log, then a best-effort
    `allocateAll` (concepts 4-5).
  - `POST /receiving-orders/:id/scan` `{raw?, partNo?, qty, ...}` —
    QR-template parse (supplier profile, `koa_zeros` qty decoding) → match
    against the order's items; single match auto-applies a partial receipt
    (`received_qty += qty`, order → `provisional_received`, ledger row);
    zero/multiple matches → 409 `{message, candidates}`. A parsed/explicit
    `serialNo` (the KOA S-key) is recorded in `receiving_scan_labels`
    (unique per order) — a repeat serial → 409 `label_already_scanned`;
    scans without a serial skip dedup.
  - `GET|POST|PATCH /receiving-invoice-items/:id/mismatch`,
    `POST /receiving-invoice-items/:id/mismatch/confirm|cancel` — mismatch
    lifecycle on the flat item columns (report/edit/confirm/cancel), with
    `transaction_logs` rows per step.
- Scan support (`apps/backend/src/routes/scantemplates.ts`):
  - `GET /scan-templates` — public read: `[{supplierCode, qrTemplate,
    qtyEncoding}]` for every supplier profile (null templates included,
    clients filter), ordered by supplier code. For client-side label
    validation on picking / put-away / measuring scans.
- Put-away flow (`apps/backend/src/routes/putaway.ts`):
  - `GET /put-away-tasks?status=` — the task queue when flow config
    `steps.put-away.autoCreateTasks` is on: one `pending` task per receiving
    order, created inside the arrival-confirm tx, completed by the
    auto-clear; rows carry order/supplier + received/unboxed item counts,
    oldest first (spec
    `docs/superpowers/specs/2026-08-10-put-away-tasks-design.md`).
  - `GET /put-away-tasks/:id` — the per-order put-away aggregate + `{task}`;
    404 `put_away_task_not_found`.
  - `GET /put-away/candidates` — receivable orders (`in_hand` /
    `provisional_received`) with per-order received/unboxed item counts
    (unboxed = received − picked − put away − allocated − staged).
  - `GET /receiving-orders/:id/put-away` — one aggregate for the detail
    screen: order + expected items (per invoice item: qty counters,
    `allocatedQty`, `remainingQty` = the candidates formula, batch fields),
    each with the advisory per-item `suggestedShelfCode`/`suggestedBoxId`/
    `suggestionReason` (most recent open box or lot of the same part in the
    item's org + sub-inventory, else the sub-inventory-tagged shelf;
    `steps.put-away.suggestShelf=off` suppresses), + materialized lots +
    staging scans + non-staging boxes with their items.
  - `POST /receiving-orders/:id/put-away-scans` `{receivingInvoiceItemId, qty, dateCode?, lotCode?, coo?, cow?, shelfBoxId?}`
    — staging scan insert (auto-creates the staging box), batch-attr backfill
    on the item, 409 `scanned_qty_exceeds_remaining`; with `shelfBoxId` the
    scan is assigned straight into that open box in the same tx (active-box
    auto-put, lot + ledger included).
  - `POST /shelf-boxes` `{receivingOrderId, shelfCode, boxId?}` /
    `DELETE /shelf-boxes/:id` (no body) — create / cancel (empty, open,
    non-staging only; hard delete + transition log). `boxId` = scanned
    physical box QR (an existing open box of the same order is reused, any
    other duplicate → 409 `box_id_already_exists`).
  - `POST /shelf-boxes/:id/scans` `{scanId}` /
    `DELETE /shelf-boxes/:id/scans/:scanId` (no body) — assign / remove one
    staging scan; assign materializes the lot + `inventory_lot_sources` +
    `put_away_qty` + two PUT_AWAY ledger rows (dock −qty / on_hand +qty),
    remove reverses (409 `lot_has_pick_allocations` when allocated, emptied
    lots are deleted with their ledger rows detached).
  - `POST /shelf-boxes/:id/add-all-unboxed` (no body) → `{count}` /
    `POST /shelf-boxes/:id/close` (no body) — bulk assign / close box;
    lot-changing mutations run `allocateAll` best-effort after commit, and
    fully put-away `in_hand` orders auto-flip to `clear` (+ transition log).
- Picking flow (`apps/backend/src/routes/picking.ts`):
  - `GET /picking-orders?status=` — list with per-order item counts,
    total/picked quantities, and `allocationStatus`/`allocatedQty` (order-level
    allocation coverage recomputed by every `allocateAll`: `allocated` when
    Σ allocated = Σ open qty, `partial` between, `unallocated` when nothing is
    reserved). `?status=shipped` lists shipped orders.
  - `GET /picking-orders/:id` — nested detail: order (incl. issue fields +
    three-level location) + items with `allocations` (lot or
    receiving source) and `packages`, plus shipping boxes with `packageCount`,
    and `suggestedBox` (the whole-box claim hint, null when none/inactive).
  - `POST /picking-orders/:id/claim-shelf-box` `{shelfBoxId}` →
    `{shippingBoxId, packageIds}` — whole-box exact-match claim (spec
    `docs/superpowers/specs/2026-07-29-whole-box-picking-claim-design.md`):
    the shelf box's current `inventory_lots` contents must exactly equal the
    order's full remaining demand (409 `box_not_exact_match`) and be free of
    other orders' reservations (409 `box_not_fully_available`). The carton is
    reused as the shipping box, prefilled with box size/net/gross weight from
    the source receiving lines' `additional_data`
    (`{boxSize, netWeight, grossWeight, weightUnit}` — g→kg, default kg),
    `source_shelf_box_id` recorded; packages are created boxed, the order's
    allocations released, and the order auto-finishes like the scan path.
  - `POST /picking-items/:id/scan` `{allocationId, qty, dateCode?,
    lotCode?, coo?, cow?}` → `{packageIds}` — the one canonical scan-to-pick:
    consumes the allocation's source (lot `total_qty`/`allocated_qty` −qty,
    receiving `picked_qty` +qty, or FIFO across the lines of an order-level
    receiving source), creates `picking_packages` with the batch snapshot
    (explicit fields override), shrinks the allocation, writes two PICK ledger
    rows per portion (reserved −qty / on_hand −qty), order `pending →
    picking`; 409 `scanned_qty_exceeds_allocation` / `scan_qty_exceeds_required`.
  - `DELETE /packages/:id` (no body) — remove an unboxed, unverified
    package, reversing source + allocation + ledger. Scan and removal run
    `allocateAll` best-effort after commit.
  - `POST /packages/:id/verify` (no body) — measuring/verify-time verification
    (package must be boxed — 409 `package_not_in_box`). With the box **open**
    (measuring pass) `verified` is set — no task involved; with the box
    **closed** (verify pass — re-scan against the sealed box) a pending verify
    task on the box is required (409 `no_pending_measure_or_verify_task`) and
    both `verified` and the `verify_verified` re-scan flag are set (409
    `package_already_verified` per the applicable flag).
  - `POST /picking-orders/:id/boxes` (no body) /
    `PATCH /shipping-boxes/:id` `{boxSize?, netWeightKg?,
    grossWeightKg?, destinationCountry?}` (kilograms — decimals allowed,
    rounded to 3 dp; 400 `invalid_net_weight_kg` /
    `invalid_gross_weight_kg`) — create / measure boxes.
  - `POST /shipping-boxes/:id/packages` `{packageId}` /
    `DELETE /shipping-boxes/:id/packages/:packageId` (no body) /
    `POST /shipping-boxes/:id/add-all-unboxed` (no body) → `{packed}` —
    box membership; cross-order packing: any open order's unboxed package may
    be added (the old `different_picking_orders` guard is gone;
    `shipping_boxes.picking_order_id` stays as the informational creator
    order; `add-all-unboxed` stays creator-order-scoped). `picked_qty` tracks
    boxed packages, so boxing the last package auto-finishes the order — no
    next-step task is created (box-scoped design).
  - `POST /shipping-boxes/:id/scan` `{barcode, qty?}` → `{packageIds}`, 201 —
    scan-to-box across orders: resolves the barcode to the one open picking
    item it could mean across ALL orders (404 `no_matching_picking_item`,
    409 `ambiguous_picking_item`) and picks it straight into this box.
  - `POST /shipping-boxes/:id/cancel` (no body) (empty + open) /
    `POST /shipping-boxes/:id/close` (no body) (non-empty, all packages
    verified + destination/box-size/weights guards, transition log — closing
    IS the measuring completion; when the verify step is enabled it also
    spawns the box's pending verify task in the same tx, idempotent —
    see the verify flow below) /
    `POST /shipping-boxes/:id/reopen` (no body) — verify-step re-measure,
    box-scoped: closed box → `open` + its packages un-verified (both
    `verified` and `verify_verified` reset; 409
    `shipping_box_not_closed`; 409 `verify_task_not_pending` — reopen requires
    a pending verify task on THIS box).
  - `POST /picking-orders/:id/finish` (no body) → `{id, status}` — flips the
    order to `finished` (409 `not_all_items_fully_boxed` until every item is
    fully picked/boxed); no next-step task row is created anymore.
  - `POST /picking-orders/report-issues` `{entries:[{pickingOrderId,
    reason, qty?, packSize?, note?, remark?}]}` → `{reported[], skipped[]}` —
    per-order issue fields + `issue` status + transition log; unknown ids and
    non-pending/picking orders are skipped. Emits `picking_order.issue_reported`.
  - `POST /picking-orders/:id/resolve-issue` `{resolutionNote?}` →
    `{id, orderNo, status}` — 409 `picking_order_no_open_issue` unless the order
    is in `issue`; returns it to `pending`, clears the `issue_*` columns,
    writes the `issue`→`pending` transition log (metadata
    `{reason, resolutionNote}`), emits `picking_order.updated`, then best-effort
    `allocateAll`.
  - `POST /picking-orders/:id/work-lock` (no body) → `{orderId, workingBy}` —
    acquire/refresh the page work lock (idempotent per user; 409 `lock_held`
    with `{holderId, holderName}` when another user holds a fresh lock; the
    lock expires 10 min after `working_at`) /
    `DELETE /picking-orders/:id/work-lock` (no body) — best-effort release on
    page leave (holder only). Locked orders are skipped by `allocateAll`;
    finishing an order clears its lock.
  - `POST /picking-orders/reorder` `{orderIds[]}` → `{reordered}` — rewrites
    `priority_seq` 1..n in the given order (400 `invalid_order_ids` for
    unknown/finished ids), emits `picking.reordered`, then runs `allocateAll`.
    The list endpoint sorts by `priority_seq` (allocation order).
- Measuring flow (`apps/backend/src/routes/measuring.ts`; spec
  `docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`)
  — box-scoped, no tasks: `measuring_tasks` is gone, closing a box IS the
  measuring completion. A box may hold packages from several picking orders
  (cross-order packing), so order numbers are aggregated per box.
  - `GET /measuring-boxes` — the work list: open boxes with at least one
    package, rows `{boxId, status, orderNos[], packageCount, verifiedCount,
    createdDate}`.
  - `GET /measuring-boxes/:id` — box detail `{boxId, ..., destinationCountry,
    suggestedNetWeightKg, packages[]}`; packages carry `partNo`/`wclItemNo`
    plus the `verified`/`verifyVerified` flags, and `suggestedNetWeightKg`
    is Σ over the box's packages of `(formula.weight / formula.qty) × pkg.qty`
    grams from `net_weight_formula`, converted to kg (3 dp; parts without a
    formula contribute 0, `null` when none have one). 404
    `shipping_box_not_found`. Box measurement itself reuses the picking
    routes (`PATCH /shipping-boxes/:id`, `/packages/:id/verify`, `/close`).
- Verify flow (`apps/backend/src/routes/verify.ts`, spec
  `docs/superpowers/specs/2026-08-11-box-scoped-measuring-verify-design.md`)
  — a second full re-scan pass over a closed shipping box; one
  `verify_tasks` row per box (`shipping_box_id`, unique), created by
  `closeShippingBox` when the verify step is enabled (`ON CONFLICT DO
  NOTHING`):
  - `GET /verify-tasks?status=` — list rows `{taskId, status, shippingBoxId,
    boxStatus, orderNos[], destinationCountry, packageCount,
    verifyVerifiedCount, createdDate}`.
  - `GET /verify-tasks/:id` — `{task{id, status, shippingBoxId, createdDate},
    box{..., suggestedNetWeightKg}, packages[]}` (same per-box shape as the
    measuring detail). 404 `verify_task_not_found`.
  - `POST /verify-tasks/:id/complete` (no body) — guards: 404
    `verify_task_not_found`, 409 `verify_task_not_pending`, 409
    `shipping_box_not_closed`, plus 409 `packages_not_all_rescanned` until
    every package in the box carries the `verify_verified` re-scan flag; then
    `completed` + transition log. No stock movement. Box re-work reuses the
    picking routes, including the verify-only
    `POST /shipping-boxes/:id/reopen` (see the picking flow above).
- Shipping feed (`apps/backend/src/routes/shipping.ts`) — per-box read for
  the admin console: closed, unshipped boxes, gated on the box's completed
  verify task when the verify step is enabled ("measured" ≡ closed). Shipped
  boxes (`shipping_boxes.shipped_at` set) are excluded.
  - `GET /shipping-orders` — box rows `{boxId, orderNos[], shipTos[],
    destinationCountry, boxSize, grossWeight, netWeight, packageCount,
    closedAt}`.
  - `GET /shipping-orders/:boxId` — `{box{..., shippedAt, shippedBy},
    packages[], orders[]}` detail (the box, its packages with part identity,
    and the orders involved). 404 `shipping_box_not_found`.
  - `POST /shipping-orders/:boxId/ship` — ship the box (actor from the JWT;
    pure workflow transition — stock left at pick-scan). Re-checks the feed
    predicate, else 409 `box_not_ready_to_ship` (also when already shipped);
    stamps the box's `shipped_at`/`shipped_by` + transition log, then derives
    order `shipped` for every order in the box whose items are all boxed,
    has nothing unboxed, and has every box holding its packages shipped;
    emits `shipping_box.shipped` and returns `{id, status, shippedOrderIds}`.
    Shipped orders stay visible via `GET /picking-orders?status=shipped`.
- Flow config (`apps/backend/src/routes/config.ts`,
  `apps/backend/src/config.ts`; spec
  `docs/superpowers/specs/2026-08-10-flow-config-design.md`):
  - `GET /config` → `{flowSteps, pickingAllocation}` — `flowSteps` holds one
    boolean per step (`receiving`, `put-away`, `picking`, `goods-verify`,
    `measuring`, `verify`, `stock-search`), `pickingAllocation.allowDockStock`
    tells whether receiving dock stock may allocate to picking. Source: the
    `warehouse_config` row key `"flow"` — a JSON object merged over defaults,
    seeded per warehouse (edit the seed for fresh DBs, SQL UPDATE + backend
    restart for existing ones) and validated at boot (invalid JSON / unknown
    keys / the put-away-off + dock-off deadlock fail startup; changes need a
    backend restart — the PDA fetches this once after login to hide disabled
    home tiles). The `FLOW_CONFIG` env var (same JSON shape) overrides the
    row when set. When `FLOW_CONFIG` is unset, the deprecated legacy
    `FLOW_STEPS_DISABLED` env (comma-separated step keys to turn off) still
    maps onto `flowSteps` on top of the row. Behavior-changing keys:
    `verify` wires the close chain (closing a box spawns its pending verify
    task, and the shipping feed is gated on completed verify tasks),
    `goods-verify` makes task generation (manual + nightly
    job) a no-op, and `steps.picking.allocation.allowDockStock=false` makes
    put-away a hard gate — the allocation engine skips receiving dock stock
    until put-away materializes lots; the other steps' endpoints stay
    functional (`measuring` only hides the PDA tile — there is no measuring
    task to gate).
- Goods verify flow (`apps/backend/src/routes/goodsverify.ts`, concept 7):
  - `POST /goods-verify-tasks/generate` `{date?}` → `{created,
    date}` — day-end generation: one pending task per lot moved in
    `inventory_transactions` that day (`date` defaults to the DB server's
    `CURRENT_DATE`); the `(task_date, inventory_lot_id)` unique index makes
    re-runs idempotent (`created` counts only new rows). Also runs
    automatically every night at local 00:00 (`src/jobs/goodsVerifyDayEnd.ts`
    from `src/server.ts`, generating `CURRENT_DATE-1` + `CURRENT_DATE` with a
    boot catch-up; `GOODS_VERIFY_CRON=off` disables).
  - `GET /goods-verify-tasks?date=&status=&shelfCode=` — the work queue with
    `partNo`/`wclItemNo` joined, ordered by shelf/box/part.
  - `GET /goods-verify-tasks/:id` — task (all fields + part identity) + lot
    (batch, location, qtys, `orgId` derived via the shelf) + the shelf box
    with its items
    (`box` null when the task's `box_id` is unset or not a `shelf_boxes` row).
  - `POST /goods-verify-tasks/:id/verify` `{countedQty?}` → the
    updated task — pending → `verified` (+ transition log); a `countedQty`
    mismatch corrects lot `total_qty` (409 `counted_qty_below_allocated` so
    `available_qty` never goes negative) and writes an ADJUST `on_hand`
    ledger row, then runs `allocateAll` best-effort after commit; a task with
    a box marks its `shelf_box_items` verified and transitions the box
    `closed → verified` (+ log; 409 `shelf_box_not_closed` when still open).
    Guards: 404 `goods_verify_task_not_found`, 400 `actor_not_found`, 409
    `goods_verify_task_not_pending`.
- Stock search (`apps/backend/src/routes/stocksearch.ts`):
  - `GET /stock-search?supplierId=&partNo=&shelfCode=` — one aggregate
    `{parts[{..., onHandQty}], lots[{...}]}` read replacing the old 3-call
    cascade (suppliers → parts → lots). Read-only; filters ANDed: `partNo`
    case-insensitive substring (whitespace-normalized like scan matching),
    `shelfCode` exact, `supplierId` via lot sources → receiving order's
    supplier; zero-qty lots included (old `/stock-search/parts/lots`
    semantics).
- Upstream sync — Electric consumer (`apps/backend/src/sync/consumer.ts` +
  `src/sync/orders.ts`, wired in `src/server.ts`; the ingest HTTP API was
  retired 2026-08-18, `src/routes/ingest.ts` deleted): pulls the 8 `demo.wms_*`
  tables from the remote DocPal Postgres master through the self-hosted
  Electric service (dev: `docker compose --profile sync up -d electric`, needs
  `DOCPAL_SYNC_DATABASE_URL` in the root `.env`; prod: internal-only in the
  same compose project). One `ShapeStream` per table resuming from its
  `sync_checkpoints` row (`src/db/schema/sync.ts`), applying through the
  `src/db/ingest.ts` domain functions (synced rows adopt the remote UUID id);
  best-effort `allocateAll` after order-changing batches; remote deletes of
  in-flight orders reuse the guarded deletes (404/409 → warn + skip). Runs
  only when `ELECTRIC_URL` is set and `ELECTRIC_SYNC != off`
  (`ELECTRIC_SECRET` as the `?secret=` shape param in prod); connects to the
  local DB as the `wms_sync_consumer` role (`SYNC_CONSUMER_DB_PASSWORD`) and
  sets `app.upstream_write = 1` in its apply transactions — the
  `enforce_remote_owned_columns()` BEFORE UPDATE triggers reject local updates
  to remote-owned columns (`delivery_date`/`date_code` stay shared for admin
  edits). Spec:
  `docs/superpowers/specs/2026-08-18-electric-sql-sync-design.md`.
- `/admin/*` — master-data CRUD (see `apps/backend/src/routes/admin/`):
  generic CRUD for shelves (code/zone), suppliers, supplier-profiles
  (incl. `qrType`), parts (referenced by `partNo`, `supplierCode` required),
  countries, box-sizes, customer-profiles (incl. `rule`), net-weight-formulas
  (`partNo`), plus custom routers for `shelf-boxes` and
  `sub-inventories` (groups addressed as `:orgId::code`), and
  `sub-inventory-share-groups`
  (`GET` all memberships, `PUT /admin/sub-inventory-share-groups/:orgId::code`
  `{shareGroup}` upserts — empty/null removes — `DELETE` removes). Parts is
  server-side paged: `GET /admin/parts?page=&pageSize=&q=` returns
  `{rows, total}` (`q` ILIKEs part_no / wcl_item_no / description /
  supplier_code).
  Flow-data edits for the admin console: `PATCH /admin/picking-orders/:id`
  `{deliveryDate}` (`YYYY-MM-DD` or null) and
  `PATCH /admin/receiving-invoice-items/:id` `{dateCode}` (or null) — both in
  `src/db/adminedits.ts`, each leaving a `transaction_logs` audit row.
  `GET /admin/receiving-mismatches` (`src/routes/admin/issues.ts`) lists open
  receiving-item mismatches across orders (order/invoice/part/supplier joins,
  newest first) for the admin Issues page. The same router serves the admin
  audit-log reads `GET /admin/receiving-orders/:id/logs` /
  `GET /admin/picking-orders/:id/logs` (`transaction_logs` rows for the order
  and its child entities, actor display name joined, newest first) and
  `DELETE /admin/receiving-invoice-items/:id` — removes a not-yet-worked item
  (409 `item_work_started` when received/picked/put-away qty > 0 or
  allocations/shelf-box items reference it), logging `item_removed` against
  the order.
  Requires the bearer token like everything else; errors are plain text.
- `POST /dev/reset`, `POST /dev/allocate` — demo reset / manual allocation
  recompute.
- `GET /events?since=<id>` — SSE stream (`src/routes/events.ts`) over the
  `app_events` transactional-outbox table (`src/db/schema/events.ts`).
  Mutations insert event rows inside their own transaction via
  `emitEvent` (`src/db/events.ts`); each open stream polls
  `WHERE id > since` every ~1.5 s (heartbeat comment every 25 s) and rows are
  pruned after 3 days. Catalog: `allocation.computed` (from `allocateAll`,
  only on net allocation change), `picking_order.created` /
  `picking_order.updated` (also on issue resolve), `picking_order.issue_reported`,
  `shipping_box.shipped` (per-box ship confirm, topics `/shipping-orders` +
  `/picking-orders`, data `{shippingBoxId, shippedOrderIds, actorId}`),
  `picking.reordered` (priority reorder, emitted even
  when allocations did not change), `receiving_order.upserted` (from the
  `src/db/ingest.ts` apply functions — the Electric consumer's per-row order
  upserts emit no `app_events`; its guarded order deletes emit
  `receiving_order.deleted` / `picking_order.deleted`),
  `receiving.mismatch_reported` / `receiving.mismatch_updated` /
  `receiving.mismatch_confirmed` / `receiving.mismatch_cancelled`,
  `receiving_order.item_removed` (admin issue-item delete),
  `goods_verify.tasks_created` (day-end generate). Frames carry
  `topics` (URL path prefixes like `/picking-orders`) that web clients use to
  invalidate their local API cache.
  Authenticated like every other route, with one exception: as the only
  route where `?token=` is accepted (EventSource cannot set headers).
- `GET /sync-events?since=<id>&limit=<n>` — JSON poll endpoint
  (`src/routes/sync-events.ts`) over the `sync_events` table-change feed for
  the external sync service. Rows are written by the `sync_events_notify()`
  trigger on every business table (only for commits by the backend's own
  `warehouse` role — the sync service writes as `warehouse_sync` and is
  skipped, breaking the circular-event loop; seed/reset suppresses via
  `SET LOCAL app.sync_events_off = 1`). Event contract + full event list:
  `docs/backend/event-catalog.md`.

## Run it

```bash
pnpm dev:backend   # API on :3002 (migrates + auto-seeds when empty)
pnpm dev:admin     # admin console on :3100 (login: admin / DocPalAdmin2026!)
```

Config (`.env`): `DATABASE_URL` (default database `warehouse_backend` on the
shared local Postgres), `PORT`, `WAREHOUSE_CODE` (instance warehouse default,
`HK1`), `CORS_ORIGINS`, `FLOW_CONFIG` (optional flow config JSON override —
step enablement + `steps.picking.allocation.allowDockStock`, served as
`GET /config`; the primary source is the seeded `warehouse_config` row
`"flow"`, and the deprecated `FLOW_STEPS_DISABLED` comma-separated step keys
still apply when unset),
`WAREHOUSE_SEED=off` to disable auto-seed.

`pnpm --filter @warehouse/backend db:seed` wipes and re-seeds the demo dataset;
`db:generate` / `db:migrate` manage migrations. A PM2 setup for a VM lives in
`ecosystem.config.cjs`.

## Known follow-ups (web-client migration)

- **KOA label semantics (`qr_template`):** KOA uses package-in-package
  labels. The **subId** segment marks inner reels: outer package labels have
  an *empty* subId (`:RK73H2ATTD2403F::253:M:63048349:S613:KOA*…`, qty 253 →
  25000), inner reel labels carry one
  (`:RK73H2ATTD2403F:x12:53:M:63048349:S611:KOA*…`, qty 53 → 5000). The
  seeded template requires a non-empty subId (`(?<subId>[^:]+)`), which
  rejects every outer label — **fixed** (`(?<subId>[^:]*)` in the seed +
  reseeded DB, covered by a `parseQrRaw` outer-label test).
- **S-key scan dedup (DONE):** the `ignore2` segment (S613 outer / S611
  inner) is a serial key, unique for every label in an order. Implemented:
  the seeded KOA template group is now `(?<serialNo>…)`, `scanParse.ts`
  surfaces `serialNo`, and the `receiving_scan_labels` table (migration
  0012, unique on receiving order + serial, recording item/qty/actor/
  scanned_at) backs the dedup — `POST /receiving-orders/:id/scan` rejects a
  repeat serial with `409 label_already_scanned`; scans without a serial
  skip dedup. The same table can be reused for put-away scan dedup later.
- **Allocation ids are unstable between scan and boxing:** post-scan
  `allocateAll` rebuilds a picking item's allocation rows until its packages
  are boxed (`allocatedQty` appears to "resurrect"). Web clients must re-fetch
  allocations rather than cache allocation ids.
