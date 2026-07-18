# Backend — Database Schema Reference

Schema for `apps/backend` (PostgreSQL, Drizzle ORM). The typed source of truth
is `apps/backend/src/db/schema/*.ts`; migrations live in `apps/backend/drizzle/`
and auto-apply on server start. All ids are `text` (UUID strings); timestamps
are `timestamp` (UTC wall-clock); `created_at`/`updated_at` are set by the app.

Differences from the original target DDL are deliberate and listed at the end.

## Master data (`schema/master.ts`)

- **users** — `id` PK, `username` UQ, `password_hash`, `display_name`, `role`
  (default `operator`), `created_at`. Demo table; ucenter integration later.
- **suppliers** — `id` PK, `code` UQ, `name`, `short_name`. Pure AP_SUPPLIERS
  sync mirror — PDA-local fields live in `supplier_profiles`.
- **supplier_profiles** — `id` PK, `supplier_code` UQ FK→`suppliers(code)`,
  `name` (local display-name override), `qr_template`, `qty_encoding`
  (e.g. `koa_zeros`), `remark`, timestamps. Survives sync id churn (keyed by
  business code).
- **parts** — `id` PK, `part_no` UQ, `wcl_item_no` (WCL Part No, same meaning
  as `receiving_invoice_items.wcl_item_no`), `internal_code`, `description`,
  `default_coo`.
- **shelves** — `code` PK, `zone`, `org_id`, `warehouse_code` (NOT NULL,
  default from instance), `warehouse_section_code` FK→`warehouse_sections`,
  `sub_inventory_code` FK→`sub_inventories`,
  `location_type` (`shelf`|`dock`, default `shelf`), timestamps.
- **country_list** — `code` PK (ISO 3166-1 alpha-2), `name`.
- **box_size_list** — `code` PK (`"L X W X H"` cm), `description`.
- **net_weight_formula** — `id` PK, `part_id` UQ FK→`parts`, `qty` int,
  `weight` real (grams per `qty` units → unit net = weight/qty).
- **customer_profiles** — `code` PK, `label`, `remark`, timestamps.
- **warehouse_sections** — `code` PK, `name`, `warehouse_code` (the warehouse
  instance the section belongs to). Middle stock level:
  warehouse → warehouse_section → sub_inventory.
- **sub_inventories** — `code` PK, `name`, `customer_code` FK→`customer_profiles`
  (set for customer-segregated stores).

## Receiving (`schema/receiving.ts`)

- **receiving_orders** — `id` PK, `ref_no`, `external_id` (nullable, unique —
  ingest sync key; `NULL` for locally created orders), `supplier_id` FK, `delivery_date`,
  `warehouse_code` (NN), `warehouse_section_code` FK, `sub_inventory_code`
  (NN, FK — mandatory per concept 3),
  `date_code` (nullable batch-level date code; items without one inherit it),
  `status` (default `pending`;
  `pending` | `provisional_received` | `clear`), `arrived_at`, `arrived_by` FK→users,
  timestamps. Indexes on `status`, `external_id` (unique). (= packing-list batch)
- **receiving_invoices** — `id` PK, `receiving_order_id` FK cascade,
  `invoice_no`, `supplier_id` FK, `wcl_company_name`, `total_qty`, `total_ctn`,
  `delivery_date`, `org_id` (default 2 = HK), `warehouse_code` (NN),
  `warehouse_section_code` FK, `sub_inventory_code` FK, timestamps. (= packing-list header)
- **receiving_invoice_items** — `id` PK, `receiving_invoice_id` FK cascade,
  `part_id` FK, `wcl_item_no`, `po_no`, `po_line`, `qty` (expected),
  `received_qty`/`picked_qty`/`put_away_qty` (default 0), `box_id`, `date_code`,
  `lot_code`, `coo`, `cow`, and flat mismatch fields (`reported_mismatch`,
  `mismatch_reason`, `mismatch_qty`, `wrong_part_no`, `mismatch_note`).
  Indexes on `receiving_invoice_id`, `part_id`.
- **receiving_scan_labels** — scanned-label dedup for receiving scans (the
  S-key serial from the supplier QR template): `id` PK,
  `receiving_order_id` FK cascade, `receiving_invoice_item_id` FK cascade,
  `serial_no`, `qty`, `scanned_by` FK→users, `scanned_at` (NN, default now).
  UNIQUE index on `(receiving_order_id, serial_no)` — one row per label
  scanned on an order; `POST /receiving-orders/:id/scan` pre-checks it and
  rejects repeats with 409 `label_already_scanned`. Added in migration 0012.

## Picking (`schema/picking.ts`)

- **picking_orders** — `id` PK, `ref_no`, `external_id` (nullable, unique —
  ingest sync key), `supplier_id` FK, `delivery_date`,
  `po_no`, `required_date_code_notice`, `ship_to`, `destination_country`,
  `customer_code` FK→`customer_profiles`, `warehouse_code` (NN),
  `warehouse_section_code` FK, `sub_inventory_code` FK, issue-report fields (`issue_reason`, `issue_qty`,
  `issue_pack_size`, `issue_note`, `issue_remark`, `issue_reported_at`,
  `issue_reported_by` FK→users), `status` (default `pending`), timestamps.
  Indexes on `status`, `external_id` (unique).
- **picking_items** — `id` PK, `picking_order_id` FK cascade, `part_id` FK,
  `qty` (demand), `picked_qty`, `allocated_qty`, `required_date_code`,
  `source_shelf_code`, timestamps. Indexes on `picking_order_id`, `part_id`.
- **measuring_tasks** — `id` PK, `picking_order_id` FK cascade (UQ index),
  `status` (default `pending`), `created_at`.
- **shipping_boxes** — `id` PK, `picking_order_id` FK, `measuring_task_id` FK,
  `status` (default `open`), `gross_weight`/`net_weight` real,
  `destination_country`, `box_size`, timestamps. Indexes on task, order.
- **picking_packages** — `id` PK, `picking_item_id` FK cascade,
  `picking_order_id` FK cascade, `source_type`, `source_id`, `qty`,
  `shipping_box_id` FK, `date_code`, `lot_code`, `coo`, `cow`, `verified`,
  timestamps. Indexes on item, order, box. (The packing truth.)
- **shipping_box_items** — compat table; `id` PK, `shipping_box_id` FK cascade,
  `picking_item_id` FK, `part_id` FK, `qty`, timestamps.

## Inventory (`schema/inventory.ts`)

- **inventory_lots** — `id` PK, `part_id` FK, `date_code`, `lot_code`, `coo`,
  `cow`, `shelf_code` FK→`shelves(code)` (dock lots use a virtual dock shelf),
  `box_id`, `warehouse_code` (NN), `warehouse_section_code` FK,
  `sub_inventory_code` FK,
  `supplier_invoice_no`, `expected_qty`, `total_qty`, `allocated_qty`,
  `available_qty` GENERATED (`total_qty - allocated_qty`).
  Partial UQ index `inventory_lots_unique_lot` on
  `(part_id, date_code, coo, cow, shelf_code, box_id, warehouse_section_code,
  sub_inventory_code, warehouse_code)` WHERE `shelf_code IS NOT NULL OR box_id IS NOT NULL`;
  indexes on part, (part, available), (shelf, box).
- **inventory_lot_sources** — `id` PK, `inventory_lot_id` FK cascade,
  `receiving_invoice_item_id` FK cascade, `qty`. UQ on (lot, item).
- **shelf_boxes** — `id` PK, `receiving_order_id` FK, `shelf_code` FK,
  `status` (default `open`), `created_at`.
- **shelf_box_items** — `id` PK, `shelf_box_id` FK cascade,
  `receiving_invoice_item_id` FK, `part_id` FK, `qty`, `verified`
  (nullable bool, default false), `verified_at`.
- **goods_verify_tasks** — daily verify tasks (concept 7): `id` PK,
  `task_date` date, `inventory_lot_id` FK (NN), `shelf_code` FK, `box_id`
  (box-based verify), `part_id` FK (NN), `expected_qty` (stock snapshot at
  generation), `status` (default `pending`; `pending`|`verified`|`skipped`),
  `verified_by` FK→users, `verified_at`, `created_at`. UQ on
  `(task_date, inventory_lot_id)` — one task per lot per day; indexes on
  (shelf, task_date), status. Generated from `inventory_transactions`.

## Allocation (`schema/allocation.ts`)

- **allocations** — `id` PK, `picking_item_id` FK cascade, `inventory_lot_id`
  FK cascade, `receiving_invoice_item_id` FK cascade, `receiving_order_id` FK
  cascade (whole-order allocation when the line has no box), `qty`, timestamps.
  CHECK: at least one of `inventory_lot_id` / `receiving_invoice_item_id` /
  `receiving_order_id`. Indexes on picking item, lot, receiving item,
  receiving order.

## Audit (`schema/audit.ts`)

- **transaction_logs** — `id` PK, `entity_type`, `entity_id`, `from_state`,
  `to_state`, `actor_id` FK→users, `metadata` jsonb (default `{}`),
  `created_at`. Indexes on (entity_type, entity_id), created_at.
- **inventory_transactions** — movement ledger: `id` PK, `inventory_lot_id` FK,
  `part_id` FK, `shelf_code` FK, `box_id`, `txn_type` (EXPECTED_CREATE /
  RECEIVE_TO_DOCK / PUT_AWAY / RESERVE / PICK / SHIP_CONFIRM / ADJUST),
  `qty_type` (`expected`|`dock`|`on_hand`|`reserved`, CHECK), `qty_delta`,
  lot snapshot (`date_code`, `lot_code`, `coo`, `cow`), `reference_type`,
  `reference_id`, `receiving_invoice_item_id` FK, `actor_id` FK,
  `txn_reason`, `metadata` jsonb, `txn_at`, `created_at`. Indexes on
  (shelf, txn_at), (lot, txn_at), (part, txn_at), txn_type,
  (reference_type, reference_id), receiving item.

## Deliberate differences from the original target DDL

1. `supplier_profiles` added (PDA-local supplier fields; `suppliers` stays a
   sync mirror). `suppliers.short_name` kept per the original DDL.
2. Lookup tables added: `country_list`, `box_size_list`, `net_weight_formula`,
   `customer_profiles`, `sub_inventories`.
3. `sub_inventory_code` (FK) on shelves / receiving orders+invoices / picking
   orders / inventory_lots; `warehouse_code` (plain text, instance default
   `WAREHOUSE_CODE` = `HK1`) on the same five tables. Both are part of
   `inventory_lots_unique_lot`.
4. `parts.wcl_item_no` added.
5. `picking_orders.customer_code` FK → `customer_profiles` added.
6. `receiving_orders.sub_inventory_code` is `NOT NULL` (mandatory per concept
   3) and `receiving_orders.date_code` added (batch date-code fallback).
7. `allocations.receiving_order_id` FK added (whole-order allocation); the
   CHECK allows any of lot / receiving item / receiving order as the source.
8. `goods_verify_tasks` added (day-end verify tasks, concept 7).
9. Three-level stock partitioning: `warehouse_sections` table plus
   `warehouse_section_code` on the same five tables that carry
   `warehouse_code`/`sub_inventory_code`, and in `inventory_lots_unique_lot`.
10. `external_id` (nullable TEXT + unique index) on `receiving_orders` and
    `picking_orders` — ingest upsert sync key
    (`PUT /receiving-orders/:externalId`, `PUT /picking-orders/:externalId`);
    `NULL` for locally created orders.
11. `receiving_scan_labels` added (migration 0012) — receiving scan S-key
    serial dedup, unique per receiving order.
