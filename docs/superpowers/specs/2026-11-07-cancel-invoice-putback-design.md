# Cancel-Invoice Ingest + Put-Back Tasks — Design

Date: 2026-11-07
Status: Draft
Related: `2026-11-05-allocation-dock-match-ordering-design.md`, `2026-11-01-task-assignee-design.md`,
`2026-10-07-ad-hoc-put-away-design.md`, `2026-09-17-admin-picking-status-override-design.md`

## Problem

Picking orders are created upstream (external sync writes `picking_orders` / `picking_items`).
We never learn when the customer cancels an invoice or a single TN line — the cancelled order
keeps occupying allocated stock and keeps showing in the PDA queues.

Upstream publishes two **externally-managed** tables into the same database (precedent:
`wcl_part_drawno` — no Drizzle schema, no migration, created/owned by the upstream, written by
the `warehouse_sync` role):

| table | key columns |
|---|---|
| `public.cancel_invoice` | `id` (varchar PK), `pi_invoice_num` (varchar NOT NULL), `pi_deliver_id`, `organization_id`, `batch_no`, `state`, `update_logs` (jsonb), `created_date`, `last_update_date`, `updated_date` |
| `public.cancel_invoice_tn` | `id` (varchar PK), `tn_number`, `tn_line_id` (bigint), `tn_line_num`, `org_id`, `po_number`, `tn_status`, `state`, `update_logs`, `created_date`, `last_update_date`, `updated_date` |

`pi_invoice_num` / `tn_number` join to `picking_orders.order_no`; `tn_line_id` joins to
`picking_items.line_id` (`bigint`, the upstream Oracle line key).

We do **not** read or write `state` / `update_logs` — those belong to the upstream processor.
We are a separate consumer of the same rows.

## Decisions (agreed with the requester)

1. Detect new/updated rows by a **watermark** on `greatest(created_date, last_update_date)`; dedupe on the source row `id`.
2. Outcome lives in **our** table only. Never write back to the cancel tables.
3. Cancellation creates a **new put-back queue** (`put_back_tasks` + `put_back_task_items`) with real PDA pages — option (a).
4. No `too_late` outcome and no admin retry: already-shipped orders are a **no-op** (`outcome = 'ignored'`); a later update to the same source row re-runs the logic unchanged (idempotent).
5. TN line cancel leaves the order open: `picking_items.status = 'cancelled'`, that line's allocations released; order → `cancelled` only when all items are cancelled.

## Backend

### New picking status `cancelled`

`PICKING_ORDER_STATUSES` (`src/db/picking.ts`) and `PICKING_ITEM_STATUSES` gain
`'cancelled'`. It is terminal and **not** allocation-holding, so the shared release path fires.
`skip` stays "deliberately not picking, may reopen"; `cancelled` is "upstream withdrew the order".

`recomputePickingItem` must not resurrect a cancelled item: its status write becomes
`CASE WHEN status = 'cancelled' THEN status WHEN <picked test> THEN 'picked' ELSE 'pending' END`.

Consumers that treat picking orders as closed gain `cancelled` alongside `shipped`: admin
status filter lists, `useStatusBadge` / `statusLabel` (PDA + admin), picking-list default
filters (cancelled rows simply don't match `allocated`/`picking`).

### Put-back is not put-away

`put_away_tasks` carries `CHECK (num_nonnulls(receiving_order_id, internal_transfer_order_id) = 1)`,
so a cancel-driven return task cannot live there. New schema `src/db/schema/putBack.ts`:

```
put_back_tasks
  id text PK (uuid v7)
  cancel_source text NOT NULL        -- 'cancel_invoice' | 'cancel_invoice_tn'
  cancel_source_id text NOT NULL     -- source row id (dedupe/audit)
  picking_order_id text NOT NULL → picking_orders (CASCADE)
  picking_item_id text → picking_items (CASCADE)   -- TN line cancels; NULL = whole order
  status text NOT NULL DEFAULT 'pending'           -- pending | completed
  assignee text                                    -- queue convention (NULL = visible to all)
  created_date / last_update_date

put_back_task_items
  id text PK
  put_back_task_id text NOT NULL → put_back_tasks (CASCADE)
  picking_package_id text → picking_packages       -- the physical unit being returned
  part_no text NOT NULL
  qty integer NOT NULL CHECK (qty > 0)
  date_code / lot_code / coo / cow text
  shelf_code text NULL               -- where it came from (original lot) — pre-fill target
  box_id text NULL
  org_id integer NOT NULL / sub_inventory_code text NOT NULL
  status text NOT NULL DEFAULT 'pending'           -- pending | put_back
  created_date / last_update_date
```

`unique (cancel_source, cancel_source_id, picking_order_id, picking_item_id)` on `put_back_tasks`
makes task creation idempotent (`ON CONFLICT DO NOTHING`).

The item is **the picked package**, so we know which labels/lots to credit:
`picking_packages.source_type/source_id` + `scanned_*` batch fields, `shelf_code` from
`inventory_lots`. Dock-sourced packages (`receiving_invoice_item` / `receiving_order`) get
`shelf_code = NULL` — the operator chooses the shelf.

### Ingest: `src/db/cancelInvoice.ts` (tx-wrapped, snake_code errors)

Per source row in one transaction:

```
find order  = picking_orders WHERE order_no = pi_invoice_num | tn_number   (org_id within allowedOrgIds)
              cancel_invoice → all items; cancel_invoice_tn → items WHERE line_id = tn_line_id
no order / no item            → cancel_records.outcome = 'no_match', no side effects
order.status = 'shipped'      → 'ignored'
order/item already 'cancelled'→ 'ignored'
order.status ∈ {pending, allocated, skip, issue, picking}      → cancel_order()
order.status ∈ {picking_finished, measuring_finished} + picked qty → cancel_order() + put-back tasks
```

`cancel_order` reuses the existing close machinery: the allocation-release block extracted from
`overridePickingOrderStatus` (`releaseOrderAllocations(tx, orderIds, { actorId, reason })`,
RESERVE-release ledger rows + freed lots) plus `status = 'cancelled'`, work-lock clear,
`transaction_logs` transition and `picking_order.updated` SSE — same shape as the admin
override, so the fleet's `allocation_status` stays coherent via `refreshAllocationStatus`.

**Already picked stock** (any `picking_packages` on the cancelled items, boxed or in-hand) →
one `put_back_tasks` row + one item row per package. `picked_qty` is **not** reversed: the
packages stay the record of what was picked, the put-back task moves them physically.

For `cancel_invoice` every package of the order returns; for a TN row only that line's packages.

### Ledger on put-back completion

Credit the stock with the existing ad-hoc primitive (lot upsert keyed by
`LotKey {partNo, shelfCode, dateCode, lotCode, coo, cow, orgId, subInventoryCode}` +
`ADJUST on_hand +qty`), extracted from `commitAdHocPutAway` into an exported
`creditLotTx` in `src/db/adhocPutaway.ts` so both paths share one implementation.
`txnReason = "cancel put-back"`, `referenceType = "put_back_task"`. No
`inventory_lot_sources` row (the stock was already in the ledger).

### Cron: `src/jobs/cancelInvoiceSync.ts`

Copy of the `receivingCnSync.ts` shape: `runCancelInvoiceSyncOnce(db)` exported for tests
(per-row `try/catch` → `console.error`, the job never throws) + `startCancelInvoiceSyncCron(db)`
self-rescheduling `setTimeout` with `timer.unref()`; started in `src/server.ts`.
Env (`src/config.ts`): `CANCEL_INVOICE_SYNC=off`, `CANCEL_INVOICE_SYNC_INTERVAL_SEC` (default 120).
A per-row failure leaves the watermark untouched and retries next pass; a missing upstream table
is tolerated like `wcl_part_drawno` (`42P01` → warn once, no-op).

```sql
SELECT c.* FROM cancel_invoice c
LEFT JOIN cancel_records r ON r.source = 'cancel_invoice' AND r.source_id = c.id
WHERE greatest(c.created_date, c.last_update_date) >= $1   -- watermark, inclusive
  AND (r.id IS NULL OR r.status = 'error'
       OR greatest(c.created_date, c.last_update_date) > r.source_ts)  -- new | retry | updated
ORDER BY greatest(c.created_date, c.last_update_date), c.id
LIMIT 200;
```

`cancel_records` is both the dedupe key and the watermark store:

```
cancel_records
  source text NOT NULL / source_id text NOT NULL   -- unique (source, source_id)
  pi_invoice_num text / tn_number text / tn_line_id bigint   -- copied lookup keys
  picking_order_id text / picking_item_id text     -- what we matched (NULL = no_match)
  outcome text NOT NULL     -- cancelled | cancelled_with_putback | ignored | no_match | error
  message text              -- admin-readable reason / error text
  source_ts timestamptz     -- greatest(created_date,last_update_date) at processing time
  status text NOT NULL      -- done | error       ('error' rows are retried)
  created_date / last_update_date
```

Watermark = `SELECT max(source_ts) FROM cancel_records WHERE source = $1`, empty table = epoch —
the first pass deliberately processes ALL existing rows (the real cancellations already sitting in
the table are exactly what must be applied). A row is re-processed when its timestamp moved
(upstream update) or our record is `status='error'`; `done` records with an unchanged timestamp are
skipped, which keeps the `>=` inclusive scan idempotent. Both source tables get their own watermark.

### Routes

| verb | path | app | notes |
|---|---|---|---|
| `GET` | `/put-back-tasks?status=` | PDA | list, `assigneeFilter` |
| `GET` | `/put-back-tasks/:id` | PDA | detail + items |
| `POST` | `/put-back-tasks/:id/complete` | PDA | body `{ shelfCode }` — fallback shelf for items without a source shelf; credits ALL pending items in one tx |
| `GET` | `/admin/cancel-records?source=&outcome=` | admin | ingest log |
| `PATCH` | `/admin/task-assignment` | admin | extended to `flow='put-back'` |

Completion is guarded by `status = 'pending'` (`put_back_task_already_completed`), the whole tx
credits every pending item, flips the task `completed`, writes `transaction_logs` +
`put_back_task.completed` (`topics: ["/put-back-tasks"]`) — mirroring `putawaytasks.ts`.
Re-allocation is **not** scheduled: the released reservations already freed the stock and
allocation is manual-only (fleet convention).

## PDA (`apps/pda`)

- New flow step key **`put-back`** in `FLOW_STEPS` (backend `config.ts`), PDA `FlowStep` union and
  `useFlowSteps` defaults; home tile gated by it (spec's queue-tile convention). Default enabled.
- `pages/put-back/index.vue` — `AppListPage` + `AppListRow`, reload on
  `/put-back-tasks` SSE topic (`:topics` + AppListPage's visible-reload), row
  `title` = order_no, `meta` = item count · total qty, `chip` = status.
  shortcut: no `pdaViewConfig.lists['put-back']` entry yet (fixed row rendering);
  add it when a warehouse needs a custom layout.
- `pages/put-back/[id].vue` — `DetailRow` list of items (part_no, qty, date code, lot, COO/COW,
  source shelf), shelf scan via `useHardwareScanner` (same code-match as put-away) to set the
  fallback target shelf for dock-sourced items, Complete button → `POST .../complete`
  `{ shelfCode }` (credits ALL pending items in one tx; items with a source shelf go back there,
  the rest land on the scanned fallback).
- `services/types.ts` + `WarehouseService` + `backendWarehouse.ts`: `listPutBackTasks`,
  `getPutBackTaskDetail`, `completePutBackTask`.
- `useStatusBadge` / `statusLabel`: `cancelled` → `badge--finished`, `put_back pending/completed`.

## Admin (`apps/admin`)

- `pages/cancel-records.vue` — read-only `DataTable` of `cancel_records` (source, key, outcome,
  message, matched order link, processed date) + filters; nav link in `utils/entities.ts`
  `navSections`. Reload on `picking_order.updated` / `cancel_record.processed` via `useChangeNotice`.
- `task-assignments.vue` gains the `put-back` flow option.
- picking order/item status filter + detail badge gain `cancelled`.

## Out of scope (deliberate, one line each)

- No `too_late`/manual-retry UI, no partial-qty cancel (tables carry no qty column), no
  un-boxing of already-shipped stock, no write-back to upstream tables, no camera-OCR label
  matching on the put-back detail, no SZ/HK cross-instance push (each instance reads its own DB copy).

## Testing

- `src/db/cancelInvoice.test.ts` (node:test, `setupTestDb`): creates the two upstream tables with
  `CREATE TABLE IF NOT EXISTS` (the `wcl_part_drawno` precedent), then
  invoice cancel on pending/allocated → order `cancelled` + allocations released + RESERVE ledger rows;
  picked order → put-back task with one item per package, `shelf_code` from the lot;
  TN row → only that line `cancelled`, order `cancelled` once all lines are cancelled;
  shipped → `ignored`; unknown number → `no_match`; idempotent re-run (no duplicate records/tasks,
  watermark advances); error row retried on the next pass.
- `src/db/putback.test.ts`: list/detail assignee scoping, complete → lot credit + ledger + `completed`,
  double-complete 409.
- `src/jobs/cancelInvoiceSync.test.ts`: watermark + too-old guard + missing-table no-op.
- Full `pnpm --filter @warehouse/backend test`, `pnpm nuxt prepare`, PDA vitest, manual browser walk.
