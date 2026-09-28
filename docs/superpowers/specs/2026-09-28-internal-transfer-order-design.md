# Internal Transfer Order — Design

Date: 2026-09-28
Status: confirmed with stakeholder (schema stage)

## Background

The warehouse has two distinct "transfer" concepts:

1. **Transfer picking (existing, unchanged):** a normal `picking_order` whose
   items carry `additional_data.from_subinventory` — another warehouse's stock
   sits in this warehouse and this warehouse ships it out for them
   (`pickingFromSubinventoryOrgs` flow config; spec
   `2026-09-03-picking-from-subinventory-orgs-design.md`). These orders ship.
2. **Internal transfer order (this spec, new):** a stock move *within* this
   warehouse — from one `(org_id, sub_inventory_code)` partition to another,
   in most cases physically just shelf → shelf, re-stamping the lot's
   org/sub-inventory. These orders **never ship** and have no delivery.

Internal transfer orders are synced from the upstream service like picking
orders, reviewed/confirmed in the admin console, and picked on the PDA.

## Flow

1. Upstream sync inserts new internal transfer orders + items
   (`pending`).
2. Admin user reviews the internal transfer list, opens a detail.
3. Admin edits order info; may assign a **delegated picking order** — the
   ship-out order this transfer is gathering stock for. When set, the
   transfer's `to_` location defaults to that picking order's
   org/sub-inventory (stock is moved to where the picking order ships from).
4. Admin confirms allocation → status `allocated`. Transfer orders join the
   same allocation engine as picking orders (shared `priority_seq` ordering —
   they compete for the same shelf lots), with their own
   `internal_transfer_allocations` table. Sources are restricted to the
   order's `from_` location; the schema keeps the three-source shape of
   `allocations` so dock/receiving sources remain possible later.
5. PDA user sees the order in a transfer list and picks items off the
   `from_` shelves; each pick writes an `internal_transfer_packages` row.
6. On finish:
   - **Delegated picking order set:** picked stock is moved to the `to_`
     location; the next `allocateAll` allocates it to the delegated picking
     order there. The PDA offers "open related picking order" to continue.
   - **No delegated picking order:** finishing creates a **put-away task**
     (move-to-stock) targeting the `to_` location; the PDA put-away flow
     shelves the stock and re-stamps org/sub-inventory.

## Status model

Order: `pending | allocated | picking | issue | finished` (picking model
minus `skip`/`shipped` — no shipping). Item: `pending | picked`.
`allocation_status`: `unallocated | partial | allocated` (engine-maintained,
same rule as picking).

## Schema (`apps/backend/src/db/schema/internal-transfer.ts`)

### internal_transfer_orders

| Field | Type | Description |
|---|---|---|
| id | text PK | Caller-supplied UUID (sync dedup key, same as picking_orders) |
| order_no | text NOT NULL | Upstream order number — NOT unique |
| from_org_id / from_sub_inventory_code | int / text | Source partition; composite FK → org_info, nullable pair |
| to_org_id / to_sub_inventory_code | int / text | Destination partition; composite FK → org_info, nullable pair |
| picking_order_id | text NULL → picking_orders.id (set null) | Delegated picking order |
| priority_seq | int NOT NULL DEFAULT 0 | Shared allocation/list order with picking (lower first) |
| working_by / working_at | → users.id / timestamp | PDA work lock (same 10-min semantics as picking) |
| issue_reason / issue_qty / issue_note / issue_remark / issue_reported_at / issue_reported_by | mirror picking_orders | Shortage reporting during transfer picking |
| status | text NOT NULL DEFAULT 'pending' | See status model |
| allocation_status | text NOT NULL DEFAULT 'unallocated' | Engine-maintained |
| remark | text | |
| additional_data | jsonb | Upstream passthrough |
| created_date / last_update_date | timestamp | Standard pair |

Indexes: `status`, `picking_order_id`.

### internal_transfer_items

Mirror of `picking_items`: `id` PK; `transfer_order_id` NOT NULL FK cascade;
`part_no` plain text; `wcl_item_no`; `qty` / `picked_qty` / `allocated_qty`;
`line_id` bigint / `line_number` (upstream line identity); `status`
(`pending | picked`); `additional_data` jsonb; timestamps.
Indexes: `transfer_order_id`, `part_no`.

### internal_transfer_allocations

Mirror of `allocations`: `transfer_item_id` NOT NULL FK cascade; the same
three nullable source FKs (`inventory_lot_id` / `receiving_invoice_item_id` /
`receiving_order_id`, all cascade) with `CHECK (≥ 1 source set)`; `qty`;
`manual` (admin-pinned rows survive wipe/rebuild). Indexes on all four FKs.
Same shape lets the engine reuse its source-loading logic for both demand
types.

### internal_transfer_packages

Mirror of `picking_packages` minus shipping: `transfer_item_id` +
`transfer_order_id` NOT NULL FKs cascade; `source_type`
(`receiving_invoice_item | inventory_lot`) + `source_id`; `qty`; lot
snapshot (`date_code` / `lot_code` / `coo` / `cow`); `shelf_code` NULL →
`shelves.code` (destination shelf, stamped at put-away); timestamps.
Indexes: item, order.

### put_away_tasks change

- `receiving_order_id` → nullable (FK cascade kept).
- Add `internal_transfer_order_id` text NULL → internal_transfer_orders.id
  (cascade), unique index.
- Add `CHECK (num_nonnulls(receiving_order_id, internal_transfer_order_id) = 1)`.
- Keep the existing unique index on `receiving_order_id`.

This reuses the existing PDA put-away flow for the no-delegated-order case
instead of inventing a parallel task type.

## Later stages (not in the schema commit)

- Allocation engine: merge transfer demands into `allocateAll` /
  scoped cores ordered by `priority_seq`; skip orders with a live work lock;
  `allocation_status` maintenance; admin run/reallocate + manual pin/remove
  endpoints mirroring the picking ones.
- Admin UI: internal transfer list + detail (edit, assign delegated picking
  order, confirm allocation, status override).
- PDA: transfer list/detail + scan picking (work lock, issue reporting),
  finish → put-away task or related-picking-order navigation.
- Sync: upstream writer for the new tables.
