# API schema migration to revised WMS PDA target — design spec

Date: 2026-07-17. Status: approved, in implementation.

## Decision

The revised target DDL supplied by the user (see `2026-07-17-api-schema-target.md` plan) is
**authoritative**: the API follows it exactly. Anything the target omits is removed, even where
working code depends on it. Dev phase: local databases are wiped and reseeded; no
data-preserving migration.

Already done: Drizzle schema rewritten (`apps/api/src/db/schema/*.ts`), fresh baseline
migration generated (`apps/api/drizzle/0000_*.sql`), local Postgres recreated
(`warehouse` + `warehouse_test`, both empty).

## Removed schema elements (and their replacements)

| Removed | Replacement / consequence |
|---|---|
| `external_id` on orders/invoices | Ingest matches by natural key (below) |
| `*_norm` columns (part/date/lot/coo/cow) | `db/schema/normalize.ts` stays a JS util; matching done in JS or plain SQL, no stored norm columns |
| `suppliers.qr_template`, `qrcode_qty_encoding` | Removed from API surface |
| `parts.supplier_id`, `parts.part_no_norm` | — |
| `shelves.id` (surrogate) | `shelves.code` is the PK; FKs reference `shelves(code)` |
| `shelf_boxes.box_id` | Box identity is `shelf_boxes.id` (e.g. `SBOX-0001`) — already the de-facto key |
| `receiving_item_mismatches` table | Inline fields on `receiving_invoice_items` (below) |
| `allocation_receiving_items` + `allocations.receiving_order_id/remark` | Single-level `allocations` rows pointing directly at `inventory_lot_id` XOR-ish `receiving_invoice_item_id` (CHECK is OR) |
| `put_away_scans` | `shelf_box_items` (now with `receiving_invoice_item_id`) + staging box (below) |
| `verification_tasks` | Removed entirely — no cycle-count scheduling, no pre-shipment task |
| `rii.allocated_qty`, `rii.available_qty`, `rii.line_no` | Computed on the fly (contract below) |
| `picking_items.scanned_not_boxed_qty`, `remaining_qty`, `line_id` | Computed on the fly |
| `transition_logs` | Renamed `transaction_logs` (`from_state`/`to_state`, `metadata jsonb`, no `note`/`updated_at`) |
| text ISO timestamps | Real `TIMESTAMP` columns, Drizzle `timestamp({mode:"date"})` |

## Invariant contract (maintained vs computed)

Maintained (written by code, checked by `invariants.guard.ts`):
- `picking_items.allocated_qty` = Σ `allocations.qty` per picking item.
- `picking_items.picked_qty` = Σ `picking_packages.qty` **boxed** (`shipping_box_id IS NOT NULL`). (Semantics unchanged.)
- `inventory_lots.allocated_qty` = Σ `allocations.qty` per lot; `available_qty` is GENERATED (`total_qty - allocated_qty`).
- `rii.received_qty / picked_qty / put_away_qty` — incremented by receive/pick/put-away actions as today.

Computed on the fly (never stored):
- rii availability = `received_qty - picked_qty - put_away_qty - Σ allocations.qty(receiving_invoice_item_id)`.
- picking "unboxed qty" (was `scanned_not_boxed_qty`) = Σ packages with `shipping_box_id IS NULL`.
- picking "remaining qty" = `qty - Σ all packages`.

`invariants.guard.ts` checks the maintained columns against their definitions plus
non-negativity of the computed rii availability, plus single-source per allocation
(the DB CHECK is OR; the guard enforces XOR).

Implementation notes (settled during implementation):
- `inventory_lots` has no `created_at` — shelf-lot allocation ordering is
  `date_code ASC NULLS LAST, id ASC` (FEFO + stable tiebreak).
- `shipping_box_items` mirror rows use the **package id as their id** (one mirror row per
  boxed package; `assignPackageToBox` inserts, `unassignPackageFromBox` deletes).
- `invariants.ts` `applyPutAway(tx, itemId, qty)` just bumps `put_away_qty` (staging-box
  scan model lives in `putAway.ts` `recordPutAwayScan`).
- Timestamps: `db/client.ts` `patchTimestampHandling` re-registers UTC parse/serialize for
  oids 1114/1184 AFTER `drizzle()` wraps the client (drizzle replaces them with identity,
  which would crash raw `sql` Date params and break ISO wire format). `now()` returns `Date`
  and is safe to interpolate in raw SQL. `invariants.ts` uses SQL `now()` where convenient.

## Allocations (single-level)

`allocate.ts` per picking item: delete existing allocations; need = `qty - Σ all packages`;
take from (1) shelf lots with `available_qty > 0` ordered by `created_at`, then (2) `in_hand`
receiving orders' rii rows with positive computed availability (boxed rows first, then unboxed;
same ordering as before). One `allocations` row per source: lot → `inventory_lot_id`, rii →
`receiving_invoice_item_id`. `createAllocation`/`deleteAllocation` in `invariants.ts` recompute
the picking item and the lot (and nothing else — no rii recompute).

## Put-away (staging box model)

- "Staged" pieces live in the order's **staging box**: one `shelf_boxes` row per receiving
  order with `shelf_code IS NULL`, `status='open'`, id from the existing `SBOX-%` sequence
  (find-or-create on first scan).
- `recordPutAwayScan` → insert `shelf_box_items` (staging box, `receiving_invoice_item_id`,
  `part_id`, qty). Over-scan guard: qty ≤ received − picked − put_away − Σalloc − staged.
  Batch attributes are taken from the **rii row** (`date_code/lot_code/coo/cow`); scan-supplied
  attributes only backfill NULL rii attributes.
- `assignScanToBox` → move the `shelf_box_items` row to a real box (UPDATE `shelf_box_id`),
  then materialize/increment the inventory lot exactly as today (shelf from box,
  `box_id` = shelf_box id, attrs from rii), bump `put_away_qty`, `tryMarkReceivingOrderClear`.
- `removeScanFromBox` → reverse (back to staging box, un-materialize as today).
- `removeScannedPiece` → delete the staging-box row.
- Box empty checks count `shelf_box_items`. `cancelShelfBox` only for empty open boxes
  (staging boxes are never cancelled via API).
- Goods verify (`verifyShelfBoxItem`) verifies `shelf_box_items` rows by `part_id` directly
  (no join through rii). Box `verified` transition: when all its items are verified
  (goodsVerify route / `markShelfBoxVerified` semantics), no verification task gate.
- `scheduleCycleCount` is deleted; stock-change re-verification becomes: set the box's items
  `verified=false, verified_at=NULL` and box status back from `verified` to `closed`.
- `shelf_boxes` has no `updated_at` in the new schema — stop writing it.
- Shelf-box list queries must exclude (or specially present) staging boxes (`shelf_code IS NULL`).

## Mismatch (inline)

- `reportMismatch`: shared `validateMismatchInputs`/`computeReceivedQty`/`assertCanApplyMismatchQty`
  (allocated = Σ allocations by rii). One active mismatch per item (`reported_mismatch` already
  true → 409). Applies immediately: `received_qty = effective`, sets
  `reported_mismatch=true, mismatch_reason, mismatch_qty (null for not_found), wrong_part_no (only wrong_part), mismatch_note`.
  Log to `transaction_logs` (entity `receiving_invoice_item`, metadata = report details incl. previous received qty).
- `editMismatch`: reporter only, overwrites the same fields and recomputes effective received qty.
- `cancelMismatch`: clears all mismatch fields and restores `received_qty = qty` (document
  expected qty — the realistic "report was a mistake, goods match the packing list" case;
  `previous_received_qty` no longer exists anywhere, documented approximation).
- No confirm lifecycle, no statuses. `getLatestMismatch` reads the inline fields.
- `mismatchStatuses` stays in `packages/shared` (web still uses it) but the API stops importing it.

## Measuring / shipping boxes

- Weights: `net_weight`/`gross_weight` REAL, unit = whatever the client sends (kg, decimals
  allowed); `parseGrams` becomes `parseWeight` (number ≥ 0, non-integer allowed).
- `shipping_boxes.measuring_task_id` is set when a box is created for a measuring task.
- `completeMeasuringTask`: no verification-task creation. `verifyShippingBox`: closed → verified
  gated only on "all packages verified" (no task lookup). `completeVerificationTask` deleted.
- `shipping_box_items` mirror: on assign/remove package to/from a shipping box, keep
  `shipping_box_items` (box_id, picking_item_id, part_id, qty) in sync with `picking_packages`
  (truth stays `picking_packages`; mirror is for compatibility readers).

## `transaction_logs`

`ingest/transition.ts` `logTransition(tx, { entityType, entityId, fromState, toState, actorId, metadata? })`
writes `transaction_logs`; `metadata` is a JS object (default `{}`), replacing stringified `note`.
Update all callers (they currently pass `fromStatus`/`toStatus`/`note`).

## `inventory_transactions` ledger

New helper `db/inventoryTx.ts`: `recordInventoryTxn(tx, {...})` inserting one row per qty-class
change. Hooks (each inside the same tx as the mutation):
- receiving scan (`applyReceipt`): `RECEIVE_TO_DOCK`, qty_type `dock`, +qty, ref receiving order/item.
- put-away assign: `PUT_AWAY`, two rows (`dock` −qty, `on_hand` +qty), lot/shelf/box refs.
- allocate/deallocate: `RESERVE`, qty_type `reserved` ±qty.
- pick scan: `PICK`, `reserved` −qty and/or `on_hand`/`dock` −qty per source kind.
- shipping box close: `SHIP_CONFIRM`, `on_hand` −qty per package.
- mismatch apply/cancel: `ADJUST`, `dock` ±delta.
Batch snapshot (date_code/lot_code/coo/cow) copied from the source lot or rii row.
`txn_at` = now; `reference_type/reference_id` = the driving document.

## Ingest (no external_id)

- `PUT` routes lose the `:external_id` path param. Upsert keys: receiving order by `ref_no`;
  invoice by `(receiving_order_id, invoice_no)`; picking order by `ref_no` (select-then-insert/update,
  no new unique constraints). Re-ingest updates the same row (idempotent by natural key).
- Detail routes that accepted "internal id or external_id" now take the internal id only.
- `confirmReceivingArrival` also sets `arrived_at` = now and `arrived_by` = actor.
- `receiving_orders.status` enum adds `provisional_received` (kept `in_hand`).

## Timestamps

Columns are real `TIMESTAMP`; JS values are `Date`. `db/client.ts` `createSql` forces UTC
parsing of oid 1114 so round-trips are timezone-stable (Hono JSON serializes Date → ISO, same
wire format as before). `db/now.ts` returns `new Date()`. Raw SQL that compared/ordered text
timestamps keeps working; string functions on timestamps (e.g. `LEFT(due_at,10)`) are gone with
`verification_tasks`.

## Conventions for implementers

- Raw SQL via `db/query.ts` (`queryAll/queryGet/queryRun`) — the established pattern.
- Every mutation runs inside `db.transaction`.
- Tests: Robolectric-style fixtures don't exist here — tests insert rows with raw SQL matching
  the new columns (no norm columns, no external_id, `name`→`display_name`, etc.). Run:
  `pnpm --filter @warehouse/api test` (serial, needs Postgres + `warehouse_test`).
- `seedSql.ts` is a generated artifact — do not hand-edit; regenerate via the generator update
  (separate workstream).
