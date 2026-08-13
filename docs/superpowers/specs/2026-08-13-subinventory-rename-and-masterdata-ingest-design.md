# Sub-inventory schema rename + master-data ingest — design

Date: 2026-08-13. Status: implemented.

Two related changes: (A) rename the `sub_inventories` table's columns to
mirror the upstream DocPal/Oracle subinventory schema, and (B) add
master-data ingest endpoints (upsert + delete) for `parts`, `suppliers`,
`supplier_profiles`, `sub_inventories`.

## A. sub_inventories rename

### Upstream schema mapping

Upstream (DocPal/Oracle side) table columns and how they map here:

| Upstream column | Upstream type | Here | Type here | Note |
| --- | --- | --- | --- | --- |
| id | uuid | `id` | text PK (UUID v7) | Unchanged; every table here uses a text UUID PK |
| office_code | text | `office_code` | text NULL | New column; upstream field the PDA does not use |
| organization_id | numeric | `organization_id` | integer NULL | New column; Oracle NUMBER → integer (see below) |
| org_id | numeric | `org_id` | integer NOT NULL | Kept; Oracle NUMBER → integer |
| secondary_inventory_name | text | `secondary_inventory_name` | text NOT NULL | Renamed from `code` |
| subinv_description | text | `subinv_description` | text NULL | Renamed from `name` |
| creation_date | timestamptz | `creation_date` | timestamp (without time zone) | Renamed from `created_date`; see below |
| last_update_date | timestamptz | `last_update_date` | timestamp (without time zone) | Kept |
| — (PDA-local) | — | `customer_code` | text FK → customer_profiles(code) | Kept; upstream has no such column |

Type decisions:

- **Oracle NUMBER → integer, not numeric.** `org_id` (and the new
  `organization_id`) stay `integer`: ~7 tables carry composite FKs targeting
  `(org_id, code)`, and Postgres requires type-identical columns on both
  sides of an FK — widening every referencing `org_id` column to numeric is
  out of scope. Org ids are small integers in practice (2 = HK).
- **timestamptz → timestamp without time zone.** Project convention: every
  table uses `timestamp without time zone` (`created_date`/`last_update_date`
  everywhere). Not changed for this one table.

### Rename impact

- Unique constraint `sub_inventories_org_code_unique` →
  `sub_inventories_org_subinv_unique`, on `(org_id, secondary_inventory_name)`.
- Composite FKs retargeted (`foreignColumns` → `subInventories.secondaryInventoryName`)
  in `receiving.ts` (receiving_orders, receiving_invoices,
  receiving_invoice_items), `picking.ts` (picking_orders), `inventory.ts`
  (inventory_lots, shelf_boxes), `master.ts` (sub_inventory_share_members).
  The referencing columns keep the name `sub_inventory_code` everywhere
  (API/DB convention) — only the FK target column changed.
- Migration `drizzle/0011_majestic_triton.sql`: generated with
  `db:generate --custom` (the interactive rename prompts cannot run
  non-interactively) and hand-written as `ALTER TABLE ... RENAME COLUMN` /
  `RENAME CONSTRAINT` + two `ADD COLUMN`s. RENAME COLUMN preserves data and
  leaves the dependent composite FKs and the unique constraint intact
  (constraints follow the renamed column by identity), so no FK drop/re-add
  is needed. The `meta/0011_snapshot.json` was updated to match (verified:
  a re-run of `db:generate` reports "No schema changes").
- Code references updated: `src/db/allocate.ts` (2 joins),
  `src/db/picking.ts` (1 join), `src/routes/admin/subInventories.ts` (custom
  router; returns `secondaryInventoryName`/`subinvDescription` plus the new
  `officeCode`/`organizationId`; POST still takes the business key as
  `code`), `src/routes/admin/subInventoryShareGroups.ts` (join +
  `subinvDescription`), `src/db/seed.ts`,
  `scripts/gen-seed-real-data.mjs` (regenerated
  `src/db/seed-subinventories-data.ts`).
- Admin app: `apps/admin/pages/sub-inventories.vue` (custom page — there is
  no sub-inventories EntityConfig in `utils/entities.ts`) renamed row fields
  and added office-code/organization-id columns + form fields;
  `apps/admin/components/CrudForm.vue` (multiSelect options source);
  new i18n keys `admin.pages.subInventories.officeCode` / `.organizationId`
  in `layers/i18n/i18n/locales/{en-US,zh-CN,zh-HK}.ts`; the `name` label is
  now "Description". `apps/web` does not read the sub-inventories API.

## B. Master-data ingest endpoints

Same pattern as the order ingests (`src/db/ingest.ts`): natural-key upsert,
`{id, created, changed}` with 201 on create / 200 on reconcile for PUT;
`{id, deleted: true}` 200 for DELETE; 404 `not_found`; caller-supplied `id?`
honored on INSERT only (`assertValidSuppliedId` → 400 `invalid_id`,
`insertId` → 409 `id_already_exists`), ignored on update; expected-side
fields reconciled (absent = null), `last_update_date` bumped only when
something changed. No `allocateAll` (master rows move no stock) and no
`app_events` — the admin master-data CRUD (`routes/admin/crud.ts`) emits
none either; the `sync_events` DB triggers already record these writes for
the external sync service.

| Endpoint | Key | Body | Guards / errors |
| --- | --- | --- | --- |
| `PUT /parts/:partNo` | `part_no` (UNIQUE) | `{id?, brand*, wclItemNo?, description?, defaultCoo?}` | 400 validation / `invalid_id`; 409 `id_already_exists` |
| `DELETE /parts/:partNo` | `part_no` | — | 404 `not_found`; 409 `cannot_delete_referenced` |
| `PUT /suppliers/:code` | `code` (UNIQUE) | `{id?, name*, shortName?}` | 400 validation / `invalid_id`; 409 `id_already_exists` |
| `DELETE /suppliers/:code` | `code` | — | 404 `not_found`; 409 `cannot_delete_referenced` |
| `PUT /supplier-profiles/:supplierCode` | `supplier_code` (UNIQUE, FK → suppliers.code) | `{id?, name?, qrTemplate?, qrTemplateConfig?, qrType?, qtyEncoding?, remark?}` | 400 `unknown_supplier` (via `assertSupplierCode`) / `invalid_id`; 409 `id_already_exists` |
| `DELETE /supplier-profiles/:supplierCode` | `supplier_code` | — | 404 `not_found` |
| `PUT /sub-inventories/:orgId/:code` | `(org_id, secondary_inventory_name)` | `{id?, subinvDescription?, officeCode?, organizationId?, customerCode?}` | 400 `invalid_org_id` (path orgId not an integer) / `organizationId must be an integer` / `unknown_customer` (via the customer-resolve helper) / `invalid_id`; 409 `id_already_exists` |
| `DELETE /sub-inventories/:orgId/:code` | `(org_id, secondary_inventory_name)` | — | 400 `invalid_org_id`; 404 `not_found`; 409 `cannot_delete_referenced` |

DELETE guard for all four entities: master rows are FK-referenced all over
the schema, so the delete runs and a Postgres FK violation (driver error
`code` `23503`, checked via `err.code ?? err.cause.code` like
`routes/admin/crud.ts`'s `mapDbError`) maps to 409 `cannot_delete_referenced`.
The reconcile compare for `qr_template_config` (jsonb) is done SQL-side with
`IS NOT DISTINCT FROM ... ::jsonb`, so key-order differences on the wire do
not produce spurious `changed` bumps.

Tests: `src/db/ingest-masterdata.test.ts` — per entity: create (caller id
honored), update/reconcile (`changed` correct, supplied id ignored), 404
delete-unknown, happy-path delete, 409 `cannot_delete_referenced` (part ←
receiving_invoice_items, supplier ← receiving_orders and ← supplier_profiles,
sub-inventory ← receiving_orders); validation: `invalid_id`,
`unknown_supplier`, `invalid_org_id`, `id_already_exists`.
