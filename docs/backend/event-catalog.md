# Sync event catalog

Event contract for the **table-change notification table** consumed by the
external sync service (local DB → remote replica). Events are produced by a
generic PostgreSQL trigger (`sync_events_notify()`) attached to every business
table, so coverage is complete by construction — every INSERT/UPDATE/DELETE
committed by the backend lands here, transactionally (a rollback drops the
event with the change).

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

## Polling API

`GET /sync-events?since=<id>&limit=<n>` (JWT-authenticated like every other
route; the sync service logs in via `POST /auth/login`).

- `since` — return rows with `id > since` (default 0)
- `limit` — page size (default 200, max 1000)

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
| `sub_inventories` | `sub_inventories.insert` / `sub_inventories.update` / `sub_inventories.delete` |
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

(Seed/reset paths (`db:seed`, `POST /dev/reset`) set
`SET LOCAL app.sync_events_off = 1` so demo reseeding does not flood the
table; the trigger checks the same setting.)

## Related: the SSE typed events (separate mechanism)

The pre-existing `app_events` outbox (`GET /events` SSE stream, 13 business
event types such as `picking_order.created`, `allocation.computed`) stays as
is — it exists for PDA/admin cache invalidation, carries business-level
meaning, and is pruned after 3 days. The sync table above is row-level, not
business-level, and is the contract for the sync service.
