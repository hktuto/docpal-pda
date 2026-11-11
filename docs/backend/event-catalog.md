# Sync event catalog

Event contract for the **table-change notification table** consumed by the
external sync service (local DB → remote replica). Events are produced by a
generic PostgreSQL trigger (`sync_events_notify()`) attached to the 30
**baseline** business tables (migration `0000_baseline.sql` — exactly the
tables in the "Full event list" below; no later migration adds a trigger), so
coverage of those tables is complete by construction: every INSERT/UPDATE/DELETE
committed by the backend lands here, transactionally (a rollback drops the
event with the change). Tables created after the baseline have **no trigger**
and are absent from the outbound feed — the CN queue/scan families
(`receiving_orders_cn`, `receiving_invoices_cn`, `receiving_invoice_items_cn`,
`receiving_cn_workflows`, `receiving_cn_scan_events`, `put_away_tasks_cn`),
put-back/cancel (`put_back_tasks`, `put_back_task_items`, `cancel_records`),
`internal_transfer_*`, `allocation_snapshot_*`, `label_prints`,
`inventory_labels`, `ad_hoc_put_aways`, `shelf_exchanges`,
`date_code_counter_periods`, `user_profiles`, `bug_reports`. Downstream
readers must not expect CN flows or these newer features in this feed; new
coverage requires adding triggers in a migration.

## Circular-write guard

The sync service also writes into this database (remote → local). Its writes
must not generate events, or each replication would echo back as a new event.
The trigger therefore records events **only for writes made by the backend's
own Postgres role** (`warehouse`) and skips everything else:

```sql
IF current_user <> 'warehouse' THEN
  RETURN NULL;  -- not written by the backend — not an event
END IF;
```

This is a whitelist: writes by the sync service (`warehouse_sync` role),
manual psql sessions under any other account, or any future tool never
produce events. The backend must perform all its writes under the
`warehouse` role (it does — `DATABASE_URL`).

## Envelope (row shape)

| Field | Type | Description |
| --- | --- | --- |
| id | bigserial | Monotonic row id — the sync service's resume cursor (`?since=<id>`) |
| event_type | text | `<table>.<insert\|update\|delete>` (see list below) |
| event_data | jsonb | `{table, action, new, old}` (see below) |
| created_date | timestamp | Commit time (UTC) |
| last_update_date | timestamp | Same as created_date (rows are immutable) |

## Consuming the feed

The `GET /sync-events?since=<id>&limit=<n>` poll endpoint was removed
2026-10. External consumers read the `sync_events` table directly, using the
monotonic `id` as resume cursor (rows with `id > since`, oldest first).

Response, oldest-first — the service stores the last seen `id` as its cursor:

```json
{
  "events": [
    {"id": 101, "eventType": "picking_items.update", "eventData": {"table": "picking_items", "action": "UPDATE", "new": {}, "old": {}}, "createdDate": "2026-07-30T08:00:00.000Z"}
  ]
}
```

## Roles

- `warehouse` — the backend's own role (`DATABASE_URL`); the only writer that
  generates events.
- `warehouse_sync` — the sync service's role (password from
  `SYNC_DB_PASSWORD`, default `warehouse_sync`). Created idempotently by
  migration `0010` and by `scripts/sql/create-sync-role.sh` (mounted into the
  prod db container's `/docker-entrypoint-initdb.d`, first init only). Holds
  SELECT/INSERT/UPDATE/DELETE on the business tables.

## event_data payload

```json
{
  "table": "picking_items",
  "action": "INSERT | UPDATE | DELETE",
  "new": { /* full row after the change, snake_case columns; null for DELETE */ },
  "old": { /* full row before the change; null for INSERT */ }
}
```

`new`/`old` are the complete row images (`to_jsonb(NEW)` / `to_jsonb(OLD)`),
so the payload schema per event type equals the table's column list — see
`docs/backend/schema-tables.md` for each table's columns.

Example — a picking-items qty update:

```json
{
  "table": "picking_items",
  "action": "UPDATE",
  "new": {"id": "…", "picking_order_id": "…", "part_no": "RK73H1JTTD2202F", "qty": 12, "picked_qty": 0, "allocated_qty": 0, "line_id": 8002, "line_number": 2, "shipment_number": 1, "status": "pending", "additional_data": null, "created_date": "…", "last_update_date": "…"},
  "old": {"id": "…", "picking_order_id": "…", "part_no": "RK73H1JTTD2202F", "qty": 10, "picked_qty": 0, "allocated_qty": 0, "line_id": 8002, "line_number": 2, "shipment_number": 1, "status": "pending", "additional_data": null, "created_date": "…", "last_update_date": "…"}
}
```

## Full event list

Every table below yields three event types: `<table>.insert`, `<table>.update`,
`<table>.delete`. Triggers are attached per table; inserts fire per row (one
API call touching N rows produces N events).

### Master data

| Table | Event types |
| --- | --- |
| `users` | `users.insert` / `users.update` / `users.delete` |
| `user_groups` | `user_groups.insert` / `user_groups.update` / `user_groups.delete` |
| `user_group_members` | `user_group_members.insert` / `user_group_members.update` / `user_group_members.delete` |
| `suppliers` | `suppliers.insert` / `suppliers.update` / `suppliers.delete` |
| `supplier_profiles` | `supplier_profiles.insert` / `supplier_profiles.update` / `supplier_profiles.delete` |
| `parts` | `parts.insert` / `parts.update` / `parts.delete` |
| `shelves` | `shelves.insert` / `shelves.update` / `shelves.delete` |
| `country_list` | `country_list.insert` / `country_list.update` / `country_list.delete` |
| `box_size_list` | `box_size_list.insert` / `box_size_list.update` / `box_size_list.delete` |
| `net_weight_formula` | `net_weight_formula.insert` / `net_weight_formula.update` / `net_weight_formula.delete` |
| `customer_profiles` | `customer_profiles.insert` / `customer_profiles.update` / `customer_profiles.delete` |
| `org_info` | `org_info.insert` / `org_info.update` / `org_info.delete` |
| `sub_inventory_share_members` | `sub_inventory_share_members.insert` / `sub_inventory_share_members.update` / `sub_inventory_share_members.delete` |

### Receiving

| Table | Event types |
| --- | --- |
| `receiving_orders` | `receiving_orders.insert` / `receiving_orders.update` / `receiving_orders.delete` |
| `receiving_invoices` | `receiving_invoices.insert` / `receiving_invoices.update` / `receiving_invoices.delete` |
| `receiving_invoice_items` | `receiving_invoice_items.insert` / `receiving_invoice_items.update` / `receiving_invoice_items.delete` |
| `receiving_scan_labels` | `receiving_scan_labels.insert` / `receiving_scan_labels.update` / `receiving_scan_labels.delete` |

### Picking / shipping

| Table | Event types |
| --- | --- |
| `picking_orders` | `picking_orders.insert` / `picking_orders.update` / `picking_orders.delete` |
| `picking_items` | `picking_items.insert` / `picking_items.update` / `picking_items.delete` |
| `picking_packages` | `picking_packages.insert` / `picking_packages.update` / `picking_packages.delete` |
| `shipping_boxes` | `shipping_boxes.insert` / `shipping_boxes.update` / `shipping_boxes.delete` |
| `shipping_box_items` | `shipping_box_items.insert` / `shipping_box_items.update` / `shipping_box_items.delete` |
| `verify_tasks` | `verify_tasks.insert` / `verify_tasks.update` / `verify_tasks.delete` |

### Inventory

| Table | Event types |
| --- | --- |
| `inventory_lots` | `inventory_lots.insert` / `inventory_lots.update` / `inventory_lots.delete` |
| `inventory_lot_sources` | `inventory_lot_sources.insert` / `inventory_lot_sources.update` / `inventory_lot_sources.delete` |
| `shelf_boxes` | `shelf_boxes.insert` / `shelf_boxes.update` / `shelf_boxes.delete` |
| `shelf_box_items` | `shelf_box_items.insert` / `shelf_box_items.update` / `shelf_box_items.delete` |
| `allocations` | `allocations.insert` / `allocations.update` / `allocations.delete` |
| `goods_verify_tasks` | `goods_verify_tasks.insert` / `goods_verify_tasks.update` / `goods_verify_tasks.delete` |
| `put_away_tasks` | `put_away_tasks.insert` / `put_away_tasks.update` / `put_away_tasks.delete` |

### Excluded (housekeeping — no trigger)

| Table | Why |
| --- | --- |
| `sync_events` (this table) | Mandatory — a trigger on it would recurse |
| `app_events` | SSE UI-notification outbox; internal plumbing, not business data |
| `transaction_logs` | Audit log — derivable; would double-report every mutation |
| `inventory_transactions` | Stock ledger — derivable; would double-report every stock move |
| `outdated_scan_warnings` | PDA-local scan warnings (spec 2026-10-07) — admin-local state, not synced upstream |
| `allocation_snapshot_batches` / `allocation_snapshot_rows` | UAT-only allocation snapshot/restore safety net (spec 2026-10-26) — backend-local recovery state, deliberately FK-free so the nightly upstream wipe cannot cascade into it; not synced |

(Seed/reset paths (`db:seed`) set
`SET LOCAL app.sync_events_off = 1` so demo reseeding does not flood the
table; the trigger checks the same setting. Warehouse-originated side
effects of synced data (a manual Re-allocate recompute) run in
their own transaction and ARE recorded.)

## Related: the SSE typed events (separate mechanism)

The pre-existing `app_events` outbox (`GET /events` SSE stream) stays as
is — it exists for PDA/admin cache invalidation, carries business-level
meaning, and is pruned after 3 days. The sync table above is row-level, not
business-level, and is the contract for the sync service.

**31 distinct business event types** are emitted via
`emitEvent(db, { type, topics, data })` across `src/db/*.ts` and
`src/routes/` (there is no `picking_order.created`):

| Event type | Topics | Emitted by |
| --- | --- | --- |
| `allocation.started` | `/picking-orders`, `/receiving-orders` | `db/allocate.ts` (recompute runner start) |
| `allocation.finished` | `/picking-orders`, `/receiving-orders` | `db/allocate.ts`, `db/allocationSnapshot.ts` |
| `allocation.computed` | `/picking-orders` (+`/receiving-orders` on snapshot restore) | `db/allocate.ts`, `db/pickingAllocateForm.ts`, `db/receivingReallocate.ts`, `db/allocationSnapshot.ts` |
| `picking.reordered` | `/picking-orders` | `db/picking.ts` |
| `picking.labeling_finished` | `/picking-orders`, `/labeling-orders` | `db/picking.ts` |
| `picking.label_printing_finished` | `/picking-orders`, `/labeling-orders`, `/label-printing-orders` | `db/picking.ts` |
| `picking.packaged` | `/packaging-orders`, `/picking-orders`, `/shipping-orders` | `db/packaging.ts` |
| `picking_order.issue_reported` | `/picking-orders` | `db/picking.ts` |
| `picking_order.updated` | `/picking-orders` | `db/picking.ts`, `db/cancelInvoice.ts` |
| `receiving.mismatch_reported` / `receiving.mismatch_updated` / `receiving.mismatch_confirmed` / `receiving.mismatch_cancelled` | `/receiving-orders` | `db/receiving.ts` |
| `receiving_order.item_removed` | `/receiving-orders` | `db/receiving.ts` |
| `receiving_order.upserted` | `/receiving-orders` | `db/receiving.ts` |
| `receiving_cn.scan_started` | `/admin/receiving-cn`, `/receiving-cn-scan-tasks` | `db/receivingCn.ts` |
| `receiving_cn.updated` | `/admin/receiving-cn`, `/receiving-cn-scan-tasks`, `/put-away-tasks` | `db/receivingCn.ts` |
| `receiving_cn.completed` | `/admin/receiving-cn`, `/receiving-cn-scan-tasks`, `/put-away-tasks` | `db/receivingCn.ts`, `db/receivingCnScan.ts` |
| `receiving_cn.failed` / `receiving_cn.cancelled` | `/admin/receiving-cn` | `db/receivingCn.ts` (`markCnWorkflowTerminal`, dynamic `` `receiving_cn.${status}` ``) |
| `receiving_cn_scan.item_updated` | `/receiving-cn-scan-tasks`, `/admin/receiving-cn` | `db/receivingCnScan.ts` |
| `put_away_task.created` / `put_away_task.completed` | `/put-away-tasks` | `db/putawaytasks.ts` |
| `put_away_task_cn.completed` | `/put-away-cn-tasks`, `/put-away-tasks` | `db/putawayCn.ts` |
| `put_back_task.created` | `/put-back-tasks` | `db/cancelInvoice.ts` (cron create + admin confirm) |
| `put_back_task.completed` | `/put-back-tasks` | `db/putback.ts` |
| `cancel_record.processed` | `/cancel-records` | `db/cancelInvoice.ts` |
| `goods_verify.tasks_created` | `/goods-verify-tasks` | `db/goodsverify.ts` |
| `outdated.warning.created` / `outdated.warning.resolved` | `/admin/outdated-warnings`, `/picking-orders` or `/receiving-orders` (per `orderKind`) | `db/outdated.ts` |
| `shipping_box.shipped` | `/shipping-orders`, `/picking-orders` | `db/shipping.ts` |
| `config.updated` | `/config` | `routes/admin/flowConfig.ts` |

Per-type data payloads and the specs behind several of these are in the
notes below. (Also on this
stream: `config.updated` with topics `["/config"]`, emitted by
`PUT /admin/flow-config` when the save is applied at runtime — PDA clients
refetch `GET /config` on it so display/flow settings propagate without
re-login. And the outdated date-code scan warnings, spec
`docs/superpowers/specs/2026-10-07-supplier-outdated-datecode-warning-design.md`:
`outdated.warning.created` — emitted inside the picking/put-away scan
transaction that recorded the warning, data `{id, orderKind, orderId,
supplierCode, dateCode, limitMonths}`; and `outdated.warning.resolved` —
emitted by `POST /admin/outdated-warnings/resolve-order` when it resolved
anything, data `{orderKind, orderId, resolved, actorId}`. Both carry topics
`["/admin/outdated-warnings", "/picking-orders"]` for picking warnings /
`["/admin/outdated-warnings", "/receiving-orders"]` for put-away warnings.)
The UAT allocation snapshot restore (spec
`docs/superpowers/specs/2026-10-26-uat-allocation-snapshot-restore-design.md`)
reuses the allocation events: after a restore it emits `allocation.computed`
(topics `["/picking-orders", "/receiving-orders"]`, only when anything was
restored or released) and always `allocation.finished`, both with data
`{scope: "snapshot-restore", ...restore summary minus the per-row report}` —
so open picking/receiving pages converge after the morning restore.

The picking labeling stage (spec
`docs/superpowers/specs/2026-10-28-picking-labeling-step-design.md`):
`picking.labeling_finished` — emitted by
`POST /picking-orders/:id/labeling-finish` after it clears the order's
`labeling_pending`, topics `["/picking-orders", "/labeling-orders"]`, so the
PDA labeling queue and picking pages converge.

The picking label-printing stage (spec
`docs/superpowers/specs/2026-11-02-label-printing-step-design.md`):
`picking.label_printing_finished` — emitted by
`POST /picking-orders/:id/label-printing-finish` after it clears the order's
`label_printing_pending`, topics `["/picking-orders", "/label-printing-orders",
"/labeling-orders"]`, so the PDA label-printing queue, labeling queue (the
order may have just entered it), and picking pages converge.

The packaging stage (spec
`docs/superpowers/specs/2026-11-10-packaging-shipping-steps-design.md`):
`picking.packaged` — emitted by `POST /packaging-orders/:orderId/confirm` after
it stamps the order's `packaged_at`/packed numbers, data `{orderId, weight,
boxCount, palletCount, actorId}`, topics
`["/packaging-orders", "/picking-orders", "/shipping-orders"]` — the packaging
queues (PDA + admin) drain and the shipping feed converges (packaging-gated
while the step is on).

The cancel-invoice ingest (spec
`docs/superpowers/specs/2026-11-07-cancel-invoice-putback-design.md`) adds three
event types: `put_back_task.created` (topics `["/put-back-tasks"]`, emitted when
the cron creates a return-to-shelf task for picked stock),
`put_back_task.completed` (topics `["/put-back-tasks"]`, emitted by
`POST /put-back-tasks/:id/complete`), and `cancel_record.processed` (topics
`["/cancel-records"]`, emitted per upstream cancel row the cron applies, data
`{source, sourceId, outcome}`). Order cancellations reuse `picking_order.updated`
(topics `["/picking-orders"]`) — PDA picking pages drop cancelled orders on it.
The confirm gate (2026-11-09) reuses both cancel types: `PATCH
/admin/cancel-records/:id` (replacement invoice) emits one
`cancel_record.processed` with `outcome: "replacement_set"`, and `POST
/admin/cancel-records/:id/confirm-putback` emits one `put_back_task.created` per
released task plus a final `cancel_record.processed` with
`outcome: "putback_confirmed"` — the PDA list reloads on the former, the admin
page on either.

Internal transfer admin actions (spec
`docs/superpowers/specs/2026-11-10-internal-transfer-admin-allocate-design.md`):
`POST /admin/internal-transfer-orders/:id/reallocate` emits the usual
`allocation.computed` (change-gated) and `allocation.finished` on the
`/internal-transfer-orders` topic (summary payload, `changed` flag), the
manual allocation add/remove emit `allocation.computed` with
`scope: "internal-transfer-order-item"`, and the delegated picking order
assignment emits one `internal-transfer.updated`
(`{transferOrderId, pickingOrderId, pickingOrderNo}`) on the same topic — the
admin list/detail pages reload on these; nothing PDA-side consumes them yet.

Stage 2 (spec 2026-11-10-internal-transfer-pda-picking-design.md) extends the
same topic: the PDA finish emits `internal-transfer.updated`
(`{transferOrderId, status: "finished"}`) — and, on the linked branch, the
awaited delegated re-allocation emits its usual `allocation.computed` /
`allocation.finished` on `/picking-orders` — the native shelving step emits
`internal-transfer.updated` with `{action: "shelve", shelved, taskCompleted}`,
and the admin Confirm/Unconfirm emits it with the new status. Pick scans and
package removals emit nothing (the PDA detail refetches from the scan
response, same as picking).
