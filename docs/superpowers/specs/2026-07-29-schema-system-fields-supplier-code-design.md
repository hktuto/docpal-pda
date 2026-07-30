# Schema system fields, supplier-code references, `parts.brand`, `additional_data`

Date: 2026-07-29
Status: implemented

## Problem

Three independent schema smells had piled up:

1. **Inconsistent audit timestamps.** Some tables carried
   `created_at`/`updated_at`, others only `created_at`, and many
   (`suppliers`, `parts`, the lookup lists, `receiving_invoice_items`,
   `inventory_lots`, …) had neither. There was no uniform way to ask "when
   did this row last change" — painful for sync reconciliation and debugging.
2. **Supplier references by internal UUID.** `receiving_orders.supplier_id`
   and `receiving_invoices.supplier_id` pointed at `suppliers(id)` — an
   internal surrogate the upstream system never sees. Upstream payloads,
   admins, and `supplier_profiles` all think in supplier **codes**, so every
   ingest/report path had to resolve ids back and forth. Meanwhile
   `parts.supplier_code` was `NOT NULL UNIQUE FK → suppliers(code)`: both the
   uniqueness (a supplier has many parts) and the FK (brand is just a label
   copied from the upstream part master) were wrong.
3. **No place for extra upstream line fields.** Packing-list and picking
   documents carry per-line attributes the target schema has no column for;
   dropping them silently makes integrations lossy.

## Decisions

### 1. Uniform system fields on every table

Every table now carries `created_date` and `last_update_date` (`timestamp
NOT NULL DEFAULT now()`; TS/JSON `createdDate`/`lastUpdateDate`) — renamed
from `created_at`/`updated_at` where those existed, added where they did
not. Append-only tables (`transaction_logs`, `inventory_transactions`,
`app_events`, `receiving_scan_labels`) get both columns too: uniformity
beats arguing about which tables "deserve" the fields, and the storage cost
is negligible. Both are set by the app (`$defaultFn(now)` at insert,
`last_update_date = now()` stamped explicitly on updates — no DB triggers;
helper `src/db/now.ts`). Business timestamps (`arrived_at`, `txn_at`,
`scanned_at`, `verified_at`, `working_at`, `issue_reported_at`,
`delivery_date`) are untouched.

### 2. Supplier references by business code

`receiving_orders.supplier_id` / `receiving_invoices.supplier_id` are
replaced by `supplier_code text FK → suppliers(code)` (nullable).
`suppliers.id` stays the internal PK; code is the business key every
external system already uses (same reasoning as `supplier_profiles`, which
was already code-keyed). Receiving order detail responses still return the
joined `supplier: {id, code, name, shortName}` object.

### 3. `parts.supplier_code` → `parts.brand`

`brand text NOT NULL` — a plain-text copy of the supplier code from the
upstream part master, **no FK and no uniqueness**. The parts seed splits
`supplier/part_no` on the fly and brand is display/grouping data, not a
referential link; a dropped FK also means part rows never block supplier
sync cleanup.

### 4. `additional_data jsonb` on line tables

Nullable free-form JSONB on `receiving_invoice_items` and `picking_items`.
Ingest passes the body's `additionalData` through on insert — no schema, no
interpretation, and deliberately **no reconcile-diff semantics**: the upsert
reconcile keys and change detection ignore it (it rides along with the row,
it is not part of the business-key identity).

## Breaking API changes

- **Ingest `PUT /receiving-orders/:batchNo`** bodies take `supplierCode`
  **only** — the `supplierId` body field was removed (400
  `unknown_supplier` for an unresolvable code). Receiving/picking items
  accept an optional `additionalData` object.
- **`GET /stock-search`** filter param is `supplierCode` (matches
  `receiving_orders.supplier_code`), not `supplierId`.
- **Admin parts server-paging** filter/sort param is `?brand=`, not
  `?supplierCode=`.
- **Receiving invoice rows** in API responses return `supplierCode` instead
  of `supplierId`.
- **All API rows** expose `createdDate`/`lastUpdateDate` instead of
  `createdAt`/`updatedAt`.

## Migration

`apps/backend/drizzle/0005_system_fields_supplier_code_brand.sql` —
hand-written, data-preserving:

- Renames `created_at`/`updated_at` → `created_date`/`last_update_date` and
  adds the pair (default `now()`) to tables that lacked them.
- Adds `supplier_code` to `receiving_orders`/`receiving_invoices`,
  backfills it from `suppliers` via the old id, then drops the old
  `supplier_id` columns and swaps the FK to `suppliers(code)`.
- Renames `parts.supplier_code` → `brand`, drops the FK/unique constraint.
- Adds `additional_data` to `receiving_invoice_items`/`picking_items`.
- Renames the index `idx_transaction_logs_created_at` →
  `idx_transaction_logs_created_date` (on `created_date`).

## Out of scope

- DB-level `ON UPDATE` triggers for `last_update_date` (app-stamped, per
  decision 1).
- Surfacing `additional_data` in the PDA/admin UIs (stored for downstream
  consumers; read paths can opt in later).
- `suppliers.code` renameability (code changes would cascade; not needed
  for the POC sync model).
