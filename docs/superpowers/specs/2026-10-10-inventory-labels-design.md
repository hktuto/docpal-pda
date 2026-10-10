# Inventory Labels Design Spec

**Date:** 2026-10-10
**Status:** Draft

## Motivation

Sub-inventories are identified by `(org_id, sub_inventory_code)` pairs (e.g. `2 / STORE1`). These codes are internal database keys — meaningless to warehouse staff on the PDA. The goal is a per-warehouse presentation layer: admin-friendly labels mapped to each sub-inventory, with display ordering and an active flag to control which options appear on the PDA.

## Scope

- **In scope:** New `inventory_labels` table, admin CRUD API + UI
- **Out of scope (Phase 2):** PDA frontend integration, `GET /config` enrichment, stock-search options replacement

## Schema

### `inventory_labels`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | text PK | UUID v7 via `newId()` |
| `org_id` | integer NOT NULL | composite FK → `org_info(org_id, secondary_inventory_name)` |
| `sub_inventory_code` | text NOT NULL | same FK |
| `label` | text NOT NULL | user-visible display name |
| `sort_order` | integer NOT NULL DEFAULT 0 | display order on PDA |
| `is_active` | boolean NOT NULL DEFAULT true | controls PDA visibility |
| `remark` | text NULL | free-text note |
| `created_date` | timestamp NOT NULL DEFAULT now() | |
| `last_update_date` | timestamp NOT NULL DEFAULT now() | |

**Constraints:**
- `UNIQUE(org_id, sub_inventory_code)` — one label per sub-inventory per warehouse
- FK `inventory_labels_sub_inv_fk` → `org_info(org_id, secondary_inventory_name)`

Each warehouse is a separate instance/database, so no `warehouse_id` column is needed.

## API

### `GET /admin/inventory-labels`
Returns all labels, ordered by `sort_order ASC, org_id ASC, sub_inventory_code ASC`.

### `GET /admin/inventory-labels/:id`
Returns a single label.

### `POST /admin/inventory-labels`
Create a new label. Required: `orgId` (int), `subInventoryCode` (text), `label` (text). Optional: `sortOrder` (int, default 0), `isActive` (bool, default true), `remark` (text).

### `PATCH /admin/inventory-labels/:id`
Partial update. Same fields as create.

### `DELETE /admin/inventory-labels/:id`
Delete a label.

All endpoints use the standard `createCrudRouter` pattern.

## Admin UI

- **Page:** `/inventory-labels` — standard `CrudTable` with `clientSearch` + `clientFilters` (orgId)
- **Fields:** Org ID (number), Sub-inventory code (text), Label (text), Sort order (number), Is active (boolean), Remark (text)
- **Nav:** Warehouse Management section, between Sub-inventories and Parts
- **i18n:** en-US, zh-HK, zh-CN labels under `admin.fields.*` and `admin.entities.inventoryLabels.*`

## Migration

`pnpm --filter @warehouse/backend db:generate` → `0029_bumpy_mentallo.sql`

## Phase 2 (future)

- PDA fetches `/inventory-labels` (or a dedicated PDA endpoint)
- Replace raw sub-inventory code display with the mapped label
- Filter by `is_active`, order by `sort_order`
- Fallback to raw code when no mapping exists
