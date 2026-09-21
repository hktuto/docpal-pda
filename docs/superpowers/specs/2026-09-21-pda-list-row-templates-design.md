# PDA list-row display templates — design (2026-09-21)

Configurable per-warehouse policy for **what the PDA list rows display**: each of the
six PDA list pages gets a free-form title template and meta template (placeholders +
literal text, bare values joined by whatever separator the template uses). User
decisions: scope = all six lists; title + meta both configurable (aside/badges stay
fixed); free-form templates like the part-1 templates; bare values (no labels).

## Config

New top-level key in the `warehouse_config` row `"flow"`:

```json
{
  "pdaListTemplates": {
    "receiving":  { "title": "[name]",     "meta": "[supplier_name] · [delivery_date]" },
    "picking":    { "title": "[order_no]", "meta": "[customer_code] · [po_no]" },
    "put-away":   { "title": "[batch_no]", "meta": "[supplier_name]" },
    "goods-verify": { "title": "[wcl_item_no]", "meta": "[shelf_code] · [box_id]" },
    "verify":     { "title": "[shipping_box_id]", "meta": "[order_nos] · [destination_country]" },
    "measuring":  { "title": "[box_id]",   "meta": "[order_nos]" }
  }
}
```

- Top-level value: object; keys must be known list keys (unknown list → 400).
  A missing list keeps the defaults above (= today's rendering).
- Per-list value: object with optional `title` / `meta`; each a non-empty string
  when present. A missing field keeps that field's default.
- Defaults reproduce today's hardcoded rows exactly, so out of the box nothing
  changes.

### Placeholder semantics (same rules as the part-1 templates)

- A placeholder whose field is null/empty renders `""` (no dangling separator).
- Text outside brackets is literal; unknown `[tokens]` stay literal.
- Array fields (`order_nos`) render comma-joined.
- Numbers render as-is. Date fields (`delivery_date`, `task_date`) render
  `YYYY-MM-DD`; timestamp fields (`created_date`, `verified_at`) render
  `YYYY-MM-DD HH:mm` (24 h).
- **Title all-empty → fallback** (a row never shows blank): re-render with the
  list's *default* title template; if that is also empty, use the raw primary id
  (receiving `[name]`, picking `order_no`, put-away `batch_no`,
  goods-verify `wcl_item_no`→`part_no`, verify `shipping_box_id`,
  measuring `box_id`). Put-away's fallback is `displayName`→`batch_no` (its
  `[name]` is the receiving order's name, same as receiving).
- **Meta all-empty → the meta line is hidden.** (Today the rows show i18n
  placeholders like "No supplier"; with a template the admin controls content,
  so an empty meta simply collapses.)
- "All-empty" is judged by content, not whitespace: a render with no letters or
  digits at all (e.g. `[supplier_name] · [delivery_date]` with both fields
  empty → `" · "`) counts as empty for both rules.

### `[name]` on the receiving list

`[name]` is the backend-computed `displayName` from the part-1
`receivingOrderNameTemplate` (already present on the list rows). That keeps one
order-name policy everywhere; the admin can still override the *list* title with
raw fields (`[invoice_no] · [batch_no]`) without touching the name template used
by detail headers / admin.

## Field catalogs (placeholders per list)

Derived from the list-row DTOs (`apps/web/services/types.ts`); the catalog in
code is authoritative:

- **receiving** — `name`, `batch_no`, `invoice_no` (comma-joined invoice
  numbers), `invoice_no_first` (only the first invoice number), `supplier_code`,
  `supplier_name`, `delivery_date`, `date_code`,
  `status`, `org_id`, `invoice_count`, `item_count`, `remaining_items`,
  `pending_picking_orders`
- **picking** — `order_no`, `status`, `allocation_status`, `customer_code`,
  `po_no`, `ship_to`, `delivery_date`, `item_count`, `total_qty`, `picked_qty`,
  `working_by_name`, `org_id`, `sub_inventory_code`
- **put-away** — `name` (the receiving order's backend-computed `displayName`,
  same as receiving), `batch_no`, `invoice_no`, `invoice_no_first`,
  `supplier_code`,
  `supplier_name`, `delivery_date`, `date_code`, `status`, `org_id`,
  `sub_inventory_code`, `unboxed_items`, `received_items`
  (`received_items` only on task rows; candidates render it empty). One config
  covers both the task-mode list and the manual candidates list — both backend
  queries carry `displayName`/`invoiceNos`/`deliveryDate`/`dateCode` from the
  receiving order.
- **goods-verify** — `wcl_item_no`, `part_no`, `shelf_code`, `box_id`,
  `task_date`, `expected_qty`, `status`, `verified_by`, `verified_at`
- **verify** — `shipping_box_id`, `box_status`, `order_nos`,
  `destination_country`, `package_count`, `verify_verified_count`
- **measuring** — `box_id`, `status`, `order_nos`, `package_count`,
  `verified_count`

## Application: PDA client-side

Unlike part 1 (backend-computed `displayName`), these templates are **applied in
the PDA app**: every list row already carries all catalog fields, so no response
shape changes are needed.

- Backend: `FlowConfig.pdaListTemplates` + validation in `mergeFlowConfigJson`
  (unknown list key / non-object / empty-string field rejected → 400 on PUT);
  `GET /config` gains a `listTemplates` field with the resolved per-list
  `{title, meta}` (defaults filled).
- PDA: `GET /config` is already fetched at login; a new composable
  `useListTemplates()` exposes `formatRow(listKey, "title" | "meta", row)`
  built on a small formatter util (`apps/web/utils/listRowTemplate.ts`) that
  maps snake_case placeholders → the row's camelCase fields, with the
  title-fallback rule. Defaults render until the config arrives.
- List pages (`receiving`, `picking`, `put-away`, `goods-verify`, `verify`,
  `measuring` — `apps/web/pages/*/index.vue`) replace their hardcoded title/meta
  interpolation with `formatRow(...)`. Aside/badges, filters, search and sorting
  are untouched.

## Admin editor

`apps/admin/pages/display-config.vue` gains a third card, "PDA list rows": a
list picker (six lists), one input each for title and meta, placeholder chips
for the selected list's catalog (insert at cursor, like the existing cards), and
a live preview of a sample row for that list (title + meta lines, including a
missing-fields sample showing the title fallback / hidden meta). The page saves
all template keys merged over the stored row via `PUT /admin/flow-config`.

## Out of scope

- Aside/badge configuration (status, remaining items, ship-to, lock holder,
  progress counts).
- Stock-search (card structure, not a `list-row`), detail pages, admin tables.
- Per-user (not per-warehouse) layouts; reordering/hiding of whole lists.
