# ElectricSQL sync from DocPal master DB — design (2026-08-18)

Replaces the push-based ingest HTTP API with pull-based Postgres logical
replication (ElectricSQL) from the DocPal master database. Motivation: the
DocPal-side developer has no capacity to integrate the ingest API, so the
warehouse backend pulls changes itself. The ingest HTTP routes are retired
once the sync is validated; the ingest domain logic (`src/db/ingest.ts`) is
reused as the consumer's apply layer during the transition.

## Remote source (verified 2026-08-18)

- Postgres at `132.148.160.54:5432`, database `docpal` (lowercase), schema
  `demo` (NOT `public`). User `docpal` has `rolreplication` + superuser;
  `wal_level = logical`.
- Publication `docpal_cdc` already exists covering exactly the 9 `wms_*`
  tables, plus a dormant replication slot
  (`docpal_cdc_slot_warehouse_backend_localhost_5432`) from a previous CDC
  attempt. **Decision (2026-08-18): we do NOT reuse them** — we create our
  own publication + slot for the Electric service; the DocPal side drops
  the old ones later. (Until they do, that dormant slot retains WAL on
  their server — a slow disk-fill risk worth reminding them about.)
- Remote data today: ~131k parts, 345 suppliers, 152 org groups — same
  master dataset as the local seed. Order tables are empty; every workflow
  column (`status`, `picked_qty`, `allocated_qty`, `reported_mismatch`,
  `working_by`, `issue_*`, `shipped_*`) is untouched.

## Table mapping

| Remote (`demo` schema)        | Local                      | Notes |
|-------------------------------|----------------------------|-------|
| `wms_org_info`                | `sub_inventories`          | `org_id`/`organization_id` numeric → cast to integer in consumer |
| `wms_parts`                   | `parts`                    | remote has no `default_coo` — dropped locally (below) |
| `wms_suppliers`               | `suppliers`                | pure mirror both sides |
| `wms_picking_orders`          | `picking_orders`           | remote `id` (text UUID) becomes the local PK verbatim |
| `wms_picking_items`           | `picking_items`            | |
| `wms_receiving_orders`        | `receiving_orders`         | remote has no `sub_inventory_code` — local column dropped (below) |
| `wms_receiving_invoices`      | `receiving_invoices`       | remote has no `sub_inventory_code` — local column dropped |
| `wms_receiving_invoice_items` | `receiving_invoice_items`  | remote has extra `order_data` jsonb — new local column (passthrough, like `additional_data`) |
| ~~`wms_supplier_profiles`~~   | —                          | **EXCLUDED from sync** (confirmed 2026-08-18): QR templates are edited in the local admin console; `supplier_profiles` stays a local-only table |

## Column ownership (the core invariant)

Synced tables are shared documents: upstream owns the demand/master fields,
the warehouse backend owns the progress fields. The sync consumer writes
**only** remote-owned columns; local code writes **only** local-owned
columns.

- **Remote-owned:** all master-data columns on the four master tables;
  on orders: header fields (`order_no`, `delivery_date`, `po_no`,
  `ship_to`, `customer_code`, `org_id`, …), item demand fields (`qty`,
  `line_id`, `line_number`, `shipment_number`, `part_no`, `po_line`,
  `line_qty`, `ctn_no`, `part_no`, `po_line`, `additional_data`), plus
  `created_date`/`last_update_date`.
- **Shared (admin / warehouse floor may edit; last writer wins):**
  `picking_orders.delivery_date`, `receiving_orders.delivery_date`,
  `receiving_invoice_items.date_code`, `receiving_invoice_items.lot_code`,
  `receiving_invoice_items.coo`, `receiving_invoice_items.cow`,
  `sub_inventories.subinv_description`, `sub_inventories.office_code`,
  `sub_inventories.organization_id`.
- **Local-owned (never written by the consumer):** `status`,
  `allocation_status`, `allocated_qty`, `picked_qty`, `received_qty`,
  `put_away_qty`, `arrived_at`/`arrived_by`, `working_by`/`working_at`,
  `issue_*`, `shipped_at`/`shipped_by`, `priority_seq`, mismatch fields,
  `reported_mismatch`.
- **Enforcement:** the consumer connects as a dedicated DB role (same
  pattern as the existing `warehouse_sync` role in the sync-events
  triggers); a per-table trigger rejects any UPDATE from other roles that
  touches a remote-owned column. Ownership is therefore DB-enforced, not
  convention.
- **Prerequisite agreement with DocPal:** the workflow columns exist in
  their schema but they must never write them. Get this in writing —
  otherwise a sync will silently zero live workflow state one day.

## Local schema changes (align local to remote, per 2026-08-18 decisions)

1. **Drop `receiving_orders.sub_inventory_code`** (+ its composite FK) and
   **`receiving_invoices.sub_inventory_code`**. Sub-inventory partitioning
   of dock stock is item-level (`receiving_invoice_items.org_id` +
   `sub_inventory_code`, already present and nullable both sides).
   - Allocation (`src/db/allocate.ts` ~line 191) currently joins
     `receiving_orders` and matches `sub_inventories` on the ORDER pair —
     must switch to the ITEM pair.
   - NULL item pair: no special allocation policy — a defaulting rule at
     apply time assigns `sub_inventory_code` to every item row (see
     Decisions), so allocation can assume the item pair is populated. Any
     row the rule cannot resolve is surfaced/logged rather than allocated.
   - `receiving_orders.org_id` stays (NOT NULL, default 2).
   - Knock-on: `src/db/ingest.ts` validation moves from order level to
     item level; put-away suggestions; admin receiving pages; demo seed
     xlsx/generator; tests.
2. **Drop `parts.default_coo`.** Only runtime use is the COO prefill during
   receiving scans (`src/routes/receiving.ts`); operators enter COO
   manually instead. Cleanup: schema, `gen-seed-real-data.mjs`,
   `gen-seed-demo-scenario.mjs`, stock-search, ingest, web/admin types.
3. **Nullability alignment to remote:** make local
   `picking_items.line_id`/`line_number`/`shipment_number` and
   `receiving_invoice_items.line_qty` nullable.
4. **ID strategy — adopt remote IDs for synced rows.** Local `newId()`
   stays UUID v7 for locally-created rows (index locality; harmless mix).
   Synced rows carry the remote ID verbatim: master-data tables get a
   one-time re-seed keyed on the remote UUIDs (nothing FK-references
   `parts.id`/`suppliers.id`/`sub_inventories.id` — refs go by `code` /
   composite pair, so adoption is safe). `picking_orders.id` is already a
   caller-supplied UUID — the remote `wms_picking_orders.id` becomes the
   local PK as-is. Do NOT switch `newId()` to v4: regenerating local IDs
   does not make them match remote ones and touches everything for
   nothing.
5. **Timestamps:** remote mixes `timestamptz` (headers/master) and
   `timestamp` (items); local is `timestamp`. Consumer normalizes.

## Sync architecture

- Self-hosted **Electric sync service** (docker, added to
  `docker-compose.yml` / `docker-compose.prod.yml`) pointed at the remote
  `docpal` DB, using our **own** publication and slot (stream id `warehouse`;
  the old `docpal_cdc` publication/slot will be dropped by DocPal).
- **Consumer** in the backend (or a sibling worker): one Electric shape per
  mapped table (schema-qualified `demo.wms_*`, shape selects only
  remote-owned columns), consumed via `@electric-sql/client` with offset
  checkpointing persisted locally. Applies changes through the existing
  ingest domain functions where shapes permit (`upsertPart` /
  `upsertSupplier` / `upsertSubInventory` / order upserts keyed by natural
  keys) — order ITEM row changes get a per-row apply path since ingest
  reconciles whole documents today.
- After any applied change to an open order → best-effort `allocateAll`
  (same trigger points as the ingest routes).
- All consumer transactions run under `suppressSyncEvents` — sync-applied
  writes are upstream-originated and must not enter the `sync_events`
  feed (would loop DocPal's own changes back, same as ingest today).
- Initial load: shape initial snapshot replaces local master data
  wholesale (re-seed keyed on remote IDs, per ID strategy above).

## Deletes

Electric delivers deletes unconditionally; the local guards exist because
deleting an order mid-work is real. Consumer policy on a remote delete of
a guarded row: **reject + surface** (log loudly, admin-visible issue) rather
than force-delete or silent-ignore. DocPal-side cancellation of in-flight
orders is a business decision to confirm. Master-data deletes apply unless
FK-referenced (mirrors today's `409 cannot_delete_referenced` behavior —
the consumer logs and skips).

## Transition plan

1. Land the local schema changes (item-level sub-inventory allocation,
   `default_coo` removal, nullability) against the CURRENT ingest API —
   they are independent of the transport.
2. Add Electric service + consumer; master-data tables first (no workflow
   state, thin logic, low risk).
3. Add the ownership triggers + sync role.
4. Extend consumer to the four order tables.
5. Run ingest API and sync in parallel; reconcile diffs; then remove the
   HTTP ingest routes (`src/routes/ingest.ts`) and update
   `docs/backend/ingest-api.md`, AGENTS.md, and app-docs.

## Decisions (2026-08-18, post-review)

- `wms_receiving_invoice_items.order_data`: **stored** — add a local
  `order_data` jsonb column (passthrough, like `additional_data`).
- **Electric service runs in the same compose project** — added to both
  `docker-compose.yml` (dev) and `docker-compose.prod.yml`.
- **Own publication + slot** for the Electric service; DocPal drops the
  existing `docpal_cdc` objects later (see "Remote source").
- **NULL item sub-inventory:** resolved by rule, not by allocation policy —
  a defaulting rule assigns `sub_inventory_code` to every
  `receiving_invoice_items` row at apply time (rule definition owned by
  Sean, to be specified before phase 1 lands). After the rule runs, the
  NULL-pair case should not exist in practice.
- **Delete policy for in-flight orders: deferred.** Interim behavior =
  reject + surface as described under "Deletes"; revisit when DocPal
  actually starts cancelling orders.

## Open questions

- The exact defaulting rule for `receiving_invoice_items.sub_inventory_code`
  (owner: Sean).
- DocPal confirmation that they never write the local-owned workflow
  columns (prerequisite under "Column ownership").
