# DB Schema Rethink — Hono + SQLite Backend (`apps/api`)

- **Date:** 2026-07-10
- **Status:** Design (approved in conversation; pending written-spec review)
- **Scope:** New `sqlite-core` schema for `apps/api`. The pg-core schema in `apps/web/db/schema.ts` is reference only and is not migrated as-is.
- **Replaces:** PGlite (in-browser Postgres WASM) as the system of record. PGlite was too slow on Android (candidate/availability reads ~460–520 ms on a T23X PDA).

## 1. Context & goals

The PDA is a warehouse store-management Android app (Nuxt + Capacitor + native OCR/barcode). Business flow:

1. Admin maintains packing lists (= receiving orders) in a separate admin web app.
2. Admin creates/updates picking orders there too.
3. On a new picking order, the system auto-matches receiving ↔ picking.
4. Goods arrive; worker basic-checks and confirms the packing list (`pending → in_hand`).
5. API recalculates all unfulfilled picking orders and allocates.
6. App is notified a picking order is ready.
7. Worker picks per the allocation.
8. While picking, worker creates a box or assigns an existing empty box and packs goods.
9. All picked + boxed → picking order `finished`; a **measuring task** is created.
10. App notified of the measuring task.
11. Measuring = verify + detail check, box by box.
12. Worker sets box size, net weight, gross weight, destination (from picking order).
13. All boxes verified → a **verify task** is created + notify.
14. That verify is the final pre-shipment per-box check.
15. Once all picking orders of a receiving order finish, worker put-aways to shelf.
16. Put items into boxes and assign a shelf id.
17. Everything clean → receiving order `clear`.

Daily: (a) after each stock change a verify task is assigned next day; (b) worker goes to the shelf, scans the box, verifies each item.

Allocation rules: receiving order = multiple supplier invoices, each with multiple items (parts). Allocation is always **FIFO** and **prefers stock already on a shelf**. When allocating receiving-order items: if an item carries a box id, allocate **box by box**; otherwise group all same-part items across all invoices in that receiving order as one pool.

**Goals**
- System of record for receiving/picking/inventory/allocation/tasks. Admin web app and PDA are both clients.
- Optimize the business-logic read paths (scan-time candidate lookup, allocation, list pages) for a low-end Android CPU.
- Keep the design minimal and auditable; no speculative generality.

**Non-goals / out of scope**
- Push notifications (polling only; see §11). No notification table.
- The admin web app itself (only its upsert contract with us).
- Auth redesign (keep existing user model; plain-text demo passwords stay for now).
- iOS.

## 2. Approach decision

**Chosen — A: maintain the numbers, precompute the text, persist the links.**
Replace read-time derivation with write-time maintenance (mirroring `inventory_lots.allocated_qty` today): maintain available/remaining quantity columns, persist an explicit allocation↔invoice-item link table, and store OCR-normalized search columns at write time. Backed by a comprehensive B-tree index plan and WAL concurrency.

Rejected:
- **B — Trigger-maintained read tables:** same read speed, but a refresh/invalidation layer to own; SQLite triggers are easy to get subtly wrong. Heavier than A for no extra benefit.
- **C — Indexes only:** does not remove the window-function CTE or the read-time OCR regex, which are the real cost. Marginal gain only.

## 3. Conventions

- **IDs:** UUID text primary keys everywhere (`id TEXT PRIMARY KEY`).
- **External key:** every order/invoice that the admin app owns has `external_id TEXT UNIQUE` — the stable cross-system key used for idempotent upsert (§9). Our UUID stays internal.
- **Timestamps:** `created_at` / `updated_at` on every table, **ISO-8601 UTC text, fixed width** (e.g. `2026-07-10T11:50:35.026Z`). Must be normalized UTC so lexicographic order == chronological order — required for the polling watermark index (§11) and all `ORDER BY updated_at`.
- **Weights:** integer grams (`net_weight_g`, `gross_weight_g`) — no float drift.
- **FKs:** every foreign key is indexed by default and enforced (`PRAGMA foreign_keys=ON`).
- **Normalized search columns:** stored at write time, used for all scan matching. Suffix `_norm`. Part number normalization collapses whitespace + OCR-confusable chars (`O→0, I→1, L→1, Z→2, S→5`); same transform is applied to the scanned input. Date/lot/coo/cow normalization collapses whitespace + uppercases (date/lot also apply the confusable map). **No regex runs at scan time.**

## 4. Schema

Notation: `col TYPE [constraints] — note`. `M` = app-maintained (cross-row); `G` = SQLite generated (same-row). All tables also have `created_at`, `updated_at`.

### Master data

**users**
- `id TEXT PK`, `username TEXT UNIQUE`, `password_hash TEXT`, `role TEXT`, `name TEXT`.

**suppliers**
- `id TEXT PK`, `code TEXT UNIQUE`, `name TEXT`, `qr_template TEXT` (OCR template, as today).

**parts**
- `id TEXT PK`, `part_no TEXT`, `part_no_norm TEXT` — normalized lookup key, indexed, `description TEXT`.

**shelves**
- `id TEXT PK`, `code TEXT UNIQUE`, plus any existing attributes.

### Receiving (= packing lists)

**receiving_orders**
- `id TEXT PK`, `external_id TEXT UNIQUE`, `ref_no TEXT`, `delivery_date TEXT` (ISO date, nullable), `status TEXT CHECK(status IN ('pending','in_hand','clear'))`, `supplier_id TEXT FK→suppliers` (nullable).

**receiving_invoices**
- `id TEXT PK`, `external_id TEXT`, `receiving_order_id TEXT FK→receiving_orders`, `invoice_no TEXT`, `supplier_id TEXT FK→suppliers`.
- `UNIQUE(receiving_order_id, invoice_no)`. `external_id` unique within order if the admin app provides one; otherwise key on `(receiving_order_id, invoice_no)`.

**receiving_invoice_items**
- `id TEXT PK`, `receiving_invoice_id TEXT FK→receiving_invoices`, `part_id TEXT FK→parts`.
- `qty INTEGER` (ordered), `received_qty INTEGER`, `picked_qty INTEGER`, `put_away_qty INTEGER` (boxed + unboxed put-away scans; see §5).
- `box_id TEXT` (nullable; supplier box id → drives box-by-box allocation).
- `date_code`, `lot_code`, `coo`, `cow` (raw) + `date_code_norm`, `lot_code_norm`, `coo_norm`, `cow_norm`.
- `allocated_qty INTEGER` **M** — Σ of `allocation_receiving_items.qty` for this item.
- `available_qty INTEGER` **M** — `received_qty − picked_qty − put_away_qty − allocated_qty`.

**receiving_item_mismatches** — unchanged from today.

### Picking

**picking_orders**
- `id TEXT PK`, `external_id TEXT UNIQUE`, `ref_no TEXT`, `status TEXT CHECK(status IN ('pending','picking','finished','issue'))`, `ship_to TEXT`, `destination_country TEXT`, plus existing issue fields (`issue_reason`, `issue_note`, …).

**picking_items**
- `id TEXT PK`, `picking_order_id TEXT FK→picking_orders`, `part_id TEXT FK→parts`.
- `qty INTEGER`, `picked_qty INTEGER`, `allocated_qty INTEGER` **M**.
- `required_date_code TEXT` (nullable), `source_shelf_code TEXT` (nullable).
- `scanned_not_boxed_qty INTEGER` **M** — `Σ picking_packages.qty WHERE shipping_box_id IS NULL`.
- `remaining_qty INTEGER` **G** — `qty − picked_qty − scanned_not_boxed_qty` (generated, all same-row).

**picking_packages**
- `id TEXT PK`, `picking_item_id TEXT FK→picking_items`, `source_type TEXT` (`receiving_invoice_item` | `inventory_lot`), `source_id TEXT`, `qty INTEGER`, `shipping_box_id TEXT FK→shipping_boxes` (nullable), `date_code`, `lot_code`, `coo`, `cow`, `verified INTEGER` (0/1).

**shipping_boxes**
- `id TEXT PK`, `picking_order_id TEXT FK→picking_orders`, `status TEXT CHECK(status IN ('open','closed','verified'))`, `box_size TEXT`, `net_weight_g INTEGER`, `gross_weight_g INTEGER`, `destination_country TEXT`.

### Inventory (shelf stock)

**inventory_lots**
- `id TEXT PK`, `part_id TEXT FK→parts`, `date_code`, `lot_code`, `coo`, `cow` + `_norm` columns.
- `shelf_code TEXT` (nullable; null = receiving-area lot), `box_id TEXT` (nullable).
- `total_qty INTEGER`, `allocated_qty INTEGER` **M**.
- `available_qty INTEGER` **G** — `total_qty − allocated_qty` (generated, same-row, indexed).

**inventory_lot_sources** — `id TEXT PK`, `inventory_lot_id TEXT FK→inventory_lots`, `receiving_invoice_item_id TEXT FK→receiving_invoice_items`, `qty INTEGER`. (As today; a scanned receiving-area lot is sourced from the invoice items it was FIFO-drawn from.)

**shelf_boxes** (+ item rows for goods-verify) — keep today's structure; add `cycle_count_pending` is **not** needed (see §10 coalescing).

**put_away_scans** — `id TEXT PK`, `receiving_invoice_item_id TEXT FK→receiving_invoice_items`, `qty INTEGER`, `shelf_box_id TEXT FK→shelf_boxes` (nullable; null = scanned but not yet assigned to a shelf box), `verified`, `verified_at`, `date_code`, `lot_code`, `coo`, `cow`. Every put-away scan (boxed or not) reduces `receiving_invoice_items.put_away_qty` immediately (§5).

### Allocation

**allocations**
- `id TEXT PK`, `picking_item_id TEXT FK→picking_items`, `qty INTEGER`, `remark TEXT` (free text only — **no more boxId JSON**).
- `inventory_lot_id TEXT FK→inventory_lots` (nullable), `receiving_order_id TEXT FK→receiving_orders` (nullable).
- `CHECK ( (inventory_lot_id IS NOT NULL) != (receiving_order_id IS NOT NULL) )` — targets exactly one of a shelf lot or a receiving order.

**allocation_receiving_items** *(new — replaces `allocations.remark` boxId JSON and the read-time `allocationsCte` window function)*
- `id TEXT PK`, `allocation_id TEXT FK→allocations`, `receiving_invoice_item_id TEXT FK→receiving_invoice_items`, `qty INTEGER`.
- Encodes box-by-box vs grouped directly: box-with-id → one link row per boxed item; no box id → one link row per `(allocation, invoice_item, qty)` FIFO portion across the grouped pool.
- `UNIQUE(allocation_id, receiving_invoice_item_id)`.

### Tasks

**measuring_tasks**
- `id TEXT PK`, `picking_order_id TEXT FK→picking_orders UNIQUE`, `status TEXT CHECK(status IN ('pending','completed'))`.

**verification_tasks**
- `id TEXT PK`, `kind TEXT CHECK(kind IN ('pre_shipment','cycle_count'))`, `status TEXT CHECK(status IN ('pending','completed'))`, `due_at TEXT` (nullable; cycle_count next-morning due time).
- `picking_order_id TEXT FK→picking_orders` (nullable), `shelf_box_id TEXT FK→shelf_boxes` (nullable).
- `CHECK ( (kind='pre_shipment') = (picking_order_id IS NOT NULL) )` and `CHECK ( (kind='cycle_count') = (shelf_box_id IS NOT NULL) )` — typed, FK-enforced polymorphism (chosen over loose `target_type`/`target_id`).
- Coalescing enforced via a **unique index** on `(kind, shelf_box_id, date(due_at))` — same-day cycle_count per box collapses to one row (§10).

### Audit

**transition_logs** — unchanged (entity, from→to, actor, at).

## 5. Maintained-column invariants

Cross-row values are maintained by app code in the **same transaction** that mutates the source rows:

| Column | = | Maintained when |
|---|---|---|
| `receiving_invoice_items.allocated_qty` | `Σ allocation_receiving_items.qty` for item | link row inserted/deleted/changed |
| `receiving_invoice_items.available_qty` | `received − picked − put_away − allocated` | any of those four terms changes |
| `picking_items.allocated_qty` | `Σ allocations.qty` for item | allocation written/released |
| `picking_items.scanned_not_boxed_qty` | `Σ picking_packages.qty WHERE shipping_box_id IS NULL` | scan-to-unboxed; later box assignment |
| `inventory_lots.allocated_qty` | `Σ allocations.qty` for lot | allocation written/released |

Same-row (generated, free, never inconsistent): `inventory_lots.available_qty`, `picking_items.remaining_qty`.

**Put-away simplification (approved):** every put-away scan — boxed or not — reduces `put_away_qty` (and therefore `available_qty`) immediately. Net effect on availability is identical to today (boxed scans already subtracted via `put_away_qty`; unboxed scans subtracted via a separate term). Fewer moving parts, same result.

**Safety net (mandatory):** a property/invariant test that, after every mutating operation, each maintained column equals the value re-derived from source rows. This is what makes approach A safe; the plan must include it.

Centralize all maintenance in one module (e.g. `apps/api/src/db/invariants.ts`) so there is a single place that bumps these columns; no ad-hoc updates elsewhere.

## 6. Index plan

Every FK is indexed by default (omitted below). The notable composite / predicate-matching indexes:

- `parts(part_no_norm)`
- `receiving_invoices(receiving_order_id)`
- `receiving_invoice_items(part_id, available_qty)` — scan-time receiving candidates + allocation grouping
- `receiving_invoice_items(receiving_invoice_id)`
- `inventory_lots(part_id, shelf_code, available_qty)` — on-shelf-first allocation; receiving-area lots are `shelf_code IS NULL`
- `picking_items(part_id)`, `picking_items(picking_order_id)`
- `allocations(receiving_order_id)` — the `findPickingCandidates` edge lookup (was an `EXISTS` subquery)
- `allocations(picking_item_id)`, `allocations(inventory_lot_id)`
- `allocation_receiving_items(receiving_invoice_item_id)`, `allocation_receiving_items(allocation_id)`
- `picking_packages(shipping_box_id)`, `picking_packages(picking_item_id)` — measuring/goods-verify by box
- `put_away_scans(receiving_invoice_item_id)`, `put_away_scans(shelf_box_id)`
- `shipping_boxes(picking_order_id)`, `shipping_boxes(status)`
- `shelf_boxes(shelf_code)`
- `receiving_orders(external_id) UNIQUE`, `picking_orders(external_id) UNIQUE`
- `receiving_orders(status, updated_at)`, `picking_orders(status, updated_at)` — list pages
- `measuring_tasks(status, updated_at)`, `verification_tasks(kind, status, updated_at)` — polling

Rationale: scan-time lookups and allocation become index range scans; polling/list endpoints become `WHERE status=? AND updated_at>?` range scans.

## 7. Allocation algorithm

`allocate()` is a **pure synchronous** `db.transaction()` (better-sqlite3) with `BEGIN IMMEDIATE`. It re-plans every picking item with `remaining_qty > 0`:

1. Release prior allocations for the affected picking items (delete `allocations` + `allocation_receiving_items`, bump maintained columns back). Re-runnable: same inputs → same output.
2. **Phase 1 — shelf first.** `SELECT … FROM inventory_lots WHERE part_id=? AND shelf_code IS NOT NULL AND available_qty>0 ORDER BY created_at, date_code_norm NULLS LAST` (arrival/put-away order as the shelf-FIFO proxy; index range scan; no JS filter/sort). Consume, write `allocations(inventory_lot_id=…)`, bump `inventory_lots.allocated_qty`.
3. **Phase 2 — receiving FIFO.** For remaining demand: `SELECT … FROM receiving_invoice_items ⋈ receiving_invoices ⋈ receiving_orders WHERE part_id=? AND status='in_hand' AND available_qty>0 ORDER BY delivery_date, invoice_no, date_code` (index range scan, maintained `available_qty`, no CTE, no correlated subqueries).
   - Items with `box_id` → allocate **box by box** (one `allocation_receiving_items` row per boxed item).
   - Items without `box_id` → group same-part across the order's invoices as one pool; consume FIFO; one `allocation_receiving_items` row per `(allocation, invoice_item, qty)` portion.
   - Write `allocations(receiving_order_id=…)` + `allocation_receiving_items`, bump `receiving_invoice_items.allocated_qty`/`available_qty`.
4. Defense-in-depth: re-check `available_qty >= qty` inside the tx before each write.

`allocate()` is idempotent and re-runnable: it plans from `remaining_qty` and maintained `available_qty`; running twice never double-allocates.

## 8. Allocation triggers

- **Picking order created/updated** (step 3 auto-match) → run `allocate()` for its items. On-shelf stock allocates immediately; receiving stock is not `in_hand` yet so contributes 0 (correct).
- **Receiving order confirmed `in_hand`** (step 4 → 5) → run `allocate()` across **all** picking items with `remaining_qty > 0`. Receiving stock is now available → receiving FIFO kicks in.

"Matching" = the `allocations` + `allocation_receiving_items` the allocator produces. `findPickingCandidates` collapses from today's `EXISTS` correlated-subquery form to a plain indexed read: picking items with `remaining_qty > 0` that have an `allocations` row from this receiving order. The edges exist because the allocator already ran at arrival time — exactly when scan-time matching needs them.

## 9. Ingestion / upsert contract

The admin web app writes through this API via idempotent `PUT` keyed by `external_id`:

- `PUT /api/receiving-orders/:external_id` — body is the **full nested snapshot** `{ order, invoices[], items[] }`. Create if absent, update if present; re-PUT of the same payload is a no-op.
- `PUT /api/picking-orders/:external_id` — `{ order, items[] }`, same semantics.
- `PUT` (not `POST`): the URI is the key → naturally idempotent.
- **Line reconciliation:** each invoice/item carries its own key (`invoice_no` / line id). The snapshot is the source of truth. Lines absent from the snapshot are removed **only if no work has started** (no allocations, no scans); otherwise `409 Conflict`. Once `in_hand` / `picking`, qty may only increase.
- Responses return the server UUIDs; the admin app stores the `external_id` mapping (it already owns the number).

**Reconciliation flag:** the admin app's real payload shape has not been inspected. The snapshot shape above is proposed; reconcile against the admin app during the plan phase.

## 10. Tasks & creation triggers

- **PO finished** (all items picked + boxed) → `INSERT measuring_tasks (picking_order_id)` (idempotent via `UNIQUE(picking_order_id)`).
- **measuring completed** (every `shipping_boxes` row `verified`, weights/size/destination set) → `INSERT verification_tasks(kind='pre_shipment', picking_order_id)`.
- **stock change** on a shelf box → **upsert** `verification_tasks(kind='cycle_count', shelf_box_id, due_at=next morning)`. Multiple changes to the same box the same day coalesce into one task (unique index on `(kind, shelf_box_id, date(due_at))`); no flag column, no scheduler scan.
- **All POs of an RO finished** → RO becomes put-away-able; RO fully put-away → `status='clear'`.

Measuring work is box-by-box: verify `picking_packages.verified`, set `shipping_boxes.{box_size, net_weight_g, gross_weight_g, destination_country}` (destination defaults from `picking_orders.ship_to`). `pre_shipment` verify = final per-box check before ship-out. `cycle_count` verify = goods-verify shelf scan.

## 11. Notifications = polling

No push, no notification table. The PDA polls task/order endpoints with a watermark (the max `updated_at` it has seen); the server returns `updated_at > since`:

- `GET /api/measuring-tasks?status=pending&since=<watermark>`
- `GET /api/verification-tasks?kind=pre_shipment&status=pending&since=…`
- `GET /api/verification-tasks?kind=cycle_count&status=pending&due_before=<now>&since=…`
- `GET /api/picking-orders?status=picking&updated_since=…` (and equivalent for receiving)

Backed by the `(status, updated_at)` / `(kind, status, updated_at)` indexes → cheap range scans. Push can be added later behind an outbox table without touching core tables (out of scope now).

## 12. Concurrency / SQLite pragmas

- `PRAGMA journal_mode=WAL; busy_timeout=<ms>; synchronous=NORMAL; foreign_keys=ON;` — many readers, one writer.
- `allocate()` is synchronous `db.transaction()` with `BEGIN IMMEDIATE` (write lock taken up front). better-sqlite3 transactions are synchronous, so there is no event-loop interleaving mid-allocation; concurrent requests serialize at the SQLite write lock. No separate mutex required.
- One long-lived `Database` instance per process.

## 13. State machines

- `receiving_orders`: `pending → in_hand → clear`
- `picking_orders`: `pending → picking → finished` (branch: `→ issue`)
- `measuring_tasks` / `verification_tasks`: `pending → completed`
- `shipping_boxes`: `open → closed → verified`

## 14. Open questions / reconciliation

- **Admin upsert payload shape** (§9) — proposed; reconcile against the real admin app in the plan phase.
- **Cycle-count "next day" definition** (§10) — assumed next local morning, coalesced per box per day. Confirm the cutoff (midnight vs a fixed hour) and timezone.
- **Shelf-lot FIFO key** (§7 Phase 1) — proposed `created_at` (arrival/put-away order) then `date_code`; confirm whether shelf FIFO should instead key off `date_code`/`lot_code` like receiving does.
- **Weights in integer grams** (§3) — confirm no downstream consumer expects kg/decimal.
- **Seed port** — current demo seed is PGlite/pg-core; a SQLite seed (and the precalc seed) must be ported. Covered by the implementation plan, not this spec.
- **Auth** — unchanged for now (plain-text demo passwords); out of scope but noted.

## 15. Out of scope (explicit)

Push notifications / outbox; the admin web app; iOS; migrations framework (schema is created from code like today); multi-process / multi-node (single Node process, single writer).
