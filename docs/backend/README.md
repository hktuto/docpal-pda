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
  operation, `actorId` in mutation bodies) and the route map per flow,
  including the task-based goods-verify API.
- [Old API Review](./api-review-old-api.md) — design review of the deprecated
  `apps/api` this replaces (what carried over, what got redesigned and why).

## API surface (current)

- `POST /auth/login`, `POST /auth/logout`, `GET /auth/users/:id` — stateless
  demo auth (plain-text compare, no tokens).
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
  - `POST /receiving-orders/:id/confirm-arrival` `{actorId}` — pending or
    provisional_received → `in_hand` with full receipt, date-code fallback,
    RECEIVE_TO_DOCK ledger rows, a transition log, then a best-effort
    `allocateAll` (concepts 4-5).
  - `POST /receiving-orders/:id/scan` `{actorId, raw?, partNo?, qty, ...}` —
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
  - `GET /put-away/candidates` — receivable orders (`in_hand` /
    `provisional_received`) with per-order received/unboxed item counts
    (unboxed = received − picked − put away − allocated − staged).
  - `GET /receiving-orders/:id/put-away` — one aggregate for the detail
    screen: order + expected items (per invoice item: qty counters,
    `allocatedQty`, `remainingQty` = the candidates formula, batch fields) +
    materialized lots + staging scans + non-staging boxes with their items.
  - `POST /receiving-orders/:id/put-away-scans` `{actorId,
    receivingInvoiceItemId, qty, dateCode?, lotCode?, coo?, cow?}` — staging
    scan insert (auto-creates the per-order staging box), batch-attr backfill
    on the item, 409 `scanned_qty_exceeds_remaining`.
  - `POST /shelf-boxes` `{receivingOrderId, shelfCode, actorId}` /
    `DELETE /shelf-boxes/:id` `{actorId}` — create / cancel (empty, open,
    non-staging only; hard delete + transition log).
  - `POST /shelf-boxes/:id/scans` `{scanId, actorId}` /
    `DELETE /shelf-boxes/:id/scans/:scanId` `{actorId}` — assign / remove one
    staging scan; assign materializes the lot (stamped with the shelf's
    warehouse/section/sub-inventory) + `inventory_lot_sources` +
    `put_away_qty` + two PUT_AWAY ledger rows (dock −qty / on_hand +qty),
    remove reverses (409 `lot_has_pick_allocations` when allocated, emptied
    lots are deleted with their ledger rows detached).
  - `POST /shelf-boxes/:id/add-all-unboxed` `{actorId}` → `{count}` /
    `POST /shelf-boxes/:id/close` `{actorId}` — bulk assign / close box;
    lot-changing mutations run `allocateAll` best-effort after commit, and
    fully put-away `in_hand` orders auto-flip to `clear` (+ transition log).
- Picking flow (`apps/backend/src/routes/picking.ts`):
  - `GET /picking-orders?status=` — list with per-order item counts and
    total/picked quantities.
  - `GET /picking-orders/:id` — nested detail: order (incl. issue fields +
    three-level location) + `measuringTask` + items with `allocations` (lot or
    receiving source) and `packages`, plus shipping boxes with `packageCount`.
  - `POST /picking-items/:id/scan` `{actorId, allocationId, qty, dateCode?,
    lotCode?, coo?, cow?}` → `{packageIds}` — the one canonical scan-to-pick:
    consumes the allocation's source (lot `total_qty`/`allocated_qty` −qty,
    receiving `picked_qty` +qty, or FIFO across the lines of an order-level
    receiving source), creates `picking_packages` with the batch snapshot
    (explicit fields override), shrinks the allocation, writes two PICK ledger
    rows per portion (reserved −qty / on_hand −qty), order `pending →
    picking`; 409 `scanned_qty_exceeds_allocation` / `scan_qty_exceeds_required`.
  - `DELETE /packages/:id` `{actorId}` — remove an unboxed, unverified
    package, reversing source + allocation + ledger. Scan and removal run
    `allocateAll` best-effort after commit.
  - `POST /packages/:id/verify` `{actorId}` — measuring-time verification
    (package boxed, box open, measuring task pending).
  - `POST /picking-orders/:id/boxes` `{actorId}` /
    `PATCH /shipping-boxes/:id` `{actorId, boxSize?, netWeightG?,
    grossWeightG?, destinationCountry?}` (grams) — create / measure boxes.
  - `POST /shipping-boxes/:id/packages` `{packageId, actorId}` /
    `DELETE /shipping-boxes/:id/packages/:packageId` `{actorId}` /
    `POST /shipping-boxes/:id/add-all-unboxed` `{actorId}` → `{packed}` —
    box membership; `picked_qty` tracks boxed packages, so boxing the last
    package auto-finishes the order (+ `measuring_tasks` row).
  - `POST /shipping-boxes/:id/cancel` `{actorId}` (empty + open) /
    `POST /shipping-boxes/:id/close` `{actorId}` (all packages verified +
    destination/box-size/weights guards, transition log).
  - `POST /picking-orders/:id/finish` `{actorId}` → the `measuring_tasks`
    row (409 `measuring_task_exists` when present).
  - `POST /picking-orders/report-issues` `{actorId, entries:[{pickingOrderId,
    reason, qty?, packSize?, note?, remark?}]}` → `{reported[], skipped[]}` —
    per-order issue fields + `issue` status + transition log; unknown ids and
    non-pending/picking orders are skipped.
- Measuring flow (`apps/backend/src/routes/measuring.ts`):
  - `GET /measuring-tasks?status=` — list with `refNo`/`shipTo` and
    server-side `boxCount`/`closedBoxCount` (closed = any status but `open`).
  - `GET /measuring-tasks/:id` — consolidated `{task, order, boxes[{...,
    packages[]}]}`; packages carry `partId`/`partNo`/`wclItemNo` — no second
    request. 404 `measuring_task_not_found`.
  - `POST /measuring-tasks/:id/complete` `{actorId}` — guards: 404
    `measuring_task_not_found`, 409 `measuring_task_not_pending`, 409
    `shipping_boxes_not_all_closed`, 409 `picking_items_not_fully_packed`
    (unboxed packages left); then `completed` + transition log. No stock
    movement; the picking order status stays `finished` (old
    `completeMeasuringTask` semantics). Box measurement itself reuses the
    picking routes (`PATCH /shipping-boxes/:id`, `/packages/:id/verify`,
    `/close`).
- Goods verify flow (`apps/backend/src/routes/goodsverify.ts`, concept 7):
  - `POST /goods-verify-tasks/generate` `{date?, actorId?}` → `{created,
    date}` — day-end generation: one pending task per lot moved in
    `inventory_transactions` that day (`date` defaults to the DB server's
    `CURRENT_DATE`); the `(task_date, inventory_lot_id)` unique index makes
    re-runs idempotent (`created` counts only new rows).
  - `GET /goods-verify-tasks?date=&status=&shelfCode=` — the work queue with
    `partNo`/`wclItemNo` joined, ordered by shelf/box/part.
  - `GET /goods-verify-tasks/:id` — task (all fields + part identity) + lot
    (batch, three-level location, qtys) + the shelf box with its items
    (`box` null when the task's `box_id` is unset or not a `shelf_boxes` row).
  - `POST /goods-verify-tasks/:id/verify` `{actorId, countedQty?}` → the
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
- Ingest (`apps/backend/src/routes/ingest.ts`, server-to-server):
  - `PUT /receiving-orders/:externalId` `{order, invoices[{..., items[]}]}`
    (camelCase) → 201/200 `{id, externalId, created, changed}` — idempotent
    upsert keyed by `receiving_orders.external_id`; invoices reconcile by
    `invoiceNo` (add/update/delete — delete cascades items), items by business
    key (`partId + poNo + poLine`). Derived state (`received_qty`,
    `picked_qty`, `put_away_qty`, mismatch flags) is never written; qty
    decreases / removals are 409-guarded once the order is past pending or
    work has started. A changed upsert on an order past `pending` runs
    `allocateAll` best-effort after commit; no ledger rows on ingest.
  - `PUT /picking-orders/:externalId` `{order, items[]}` → same shape —
    items reconcile by business key (`partId + requiredDateCode`),
    `picked_qty`/`allocated_qty` never written, `customerCode` resolves to
    `customer_profiles.code`; a changed upsert on a `pending`/`picking` order
    runs `allocateAll` best-effort after commit.
  - Both resolve `supplierCode`/`partNo` (400 `unknown_supplier` /
    `unknown_part` / `unknown_customer` with the code in the message);
    `supplierId`/`partId` given directly are also accepted.
- `/admin/*` — master-data CRUD (see `apps/backend/src/routes/admin/`):
  generic CRUD for shelves, suppliers, supplier-profiles, parts, countries,
  box-sizes, sub-inventories, customer-profiles, net-weight-formulas, users,
  plus the custom `shelf-boxes` router. Unauthenticated POC — errors are plain
  text.
- `POST /dev/reset`, `POST /dev/allocate` — demo reset / manual allocation
  recompute.

## Run it

```bash
pnpm dev:backend   # API on :3002 (migrates + auto-seeds when empty)
pnpm dev:admin     # admin console on :3100 (login: admin / DocPalAdmin2026!)
```

Config (`.env`): `DATABASE_URL` (default database `warehouse_backend` on the
shared local Postgres), `PORT`, `WAREHOUSE_CODE` (instance warehouse default,
`HK1`), `CORS_ORIGINS`, `WAREHOUSE_SEED=off` to disable auto-seed.

`pnpm --filter @warehouse/backend db:seed` wipes and re-seeds the demo dataset;
`db:generate` / `db:migrate` manage migrations.

## Hosted dev (Vercel + Neon)

The backend and admin console also run hosted for demos:

- **Backend:** `https://docpal-pda-backend.vercel.app` — Vercel project
  `docpal-pda-backend` (root `apps/backend`, Hono preset serving
  `src/index.ts` as the function via its `export default app`; `maxDuration`
  60 in `vercel.json`). Boot-time migrate/seed are **skipped on Vercel**
  (`process.env.VERCEL` gate in `src/db.ts`) — migrations run explicitly:
  `DATABASE_URL=<unpooled> pnpm --filter @warehouse/backend db:migrate`, then
  `db:seed` once.
- **Database:** Neon `warehouse_backend` (Vercel Marketplace integration,
  injects `DATABASE_URL`/`DATABASE_URL_UNPOOLED`). Runtime uses the **pooled**
  URL with `PG_MAX=1` + `PG_PREPARE=false` (PgBouncer transaction mode);
  migrations/seed use the unpooled URL.
- **Admin:** Vercel project `docpal-pda-admin` (root `apps/admin`) with
  `NUXT_PUBLIC_API_BASE_URL` pointing at the backend URL; the backend's
  `CORS_ORIGINS` includes the admin origin.
- **CORS_ORIGINS must keep every client origin** — it replaces the default
  list wholesale. The hosted value needs: `http://localhost:3000`,
  `http://localhost:3100`, `http://localhost` (**the Android WebView origin —
  dropping it breaks the Capacitor app's login with a network error**),
  `capacitor://localhost`, and both admin URLs
  (`https://docpal-pda-admin.vercel.app` + the `-sean-tsnags-projects`
  alias).
- Env vars live on the Vercel projects (Production scope): backend
  `WAREHOUSE_SEED=off`, `WAREHOUSE_CODE=HK1`, `PG_MAX`, `PG_PREPARE`,
  `CORS_ORIGINS` (optionally `DEV_ROUTES=off` to hide the demo routes);
  admin `NUXT_PUBLIC_API_BASE_URL`.
- Deploys are git-triggered: push to `master` on GitHub redeploys both
  projects. SSO deployment protection is disabled on both (public POC).
  A PM2 alternative for a VM lives in `ecosystem.config.cjs`.

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
