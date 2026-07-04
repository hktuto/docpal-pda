# Stock Search Design

> **Status:** Draft — awaiting review.
>
> **Goal:** Add a standalone Stock Search page so operators can search products by supplier or item ID and see current stock quantities with locations.
>
> **Scope:** New page, menu item, DB helper, and related documentation updates.

---

## 1. Problem Statement

Warehouse operators often need to answer:

- "Do we have part X in stock?"
- "Where is supplier Y's inventory located?"
- "How much of item Z is available?"

Currently the app only shows inventory inside specific flows (picking, put-away, measuring, goods-verify). There is no global, searchable stock overview.

## 2. Proposed Approach

Add a new **Stock Search** menu item that opens a dedicated page. The page shows all suppliers by default as expandable sections. Expanding a supplier loads the items (parts) associated with that supplier and their inventory breakdown.

A top search bar and two-level supplier/item filter let operators narrow the list. A toggle hides items with zero inventory.

## 3. Page Layout

### 3.1 Route and menu

- Route: `/stock-search`
- Add a **Stock Search** card to the home screen (`pages/index.vue`).

### 3.2 Header controls

At the top of the page:

1. **Keyword search** — free-text input that filters suppliers and parts by:
   - Supplier name or code
   - Part number (`partNo`)
   - Internal code (`internalCode`)
   - Description (if populated)

2. **Supplier filter** — dropdown of all suppliers. Default: "All suppliers".

3. **Item filter** — dropdown of parts. Disabled when "All suppliers" is selected. When a supplier is selected, this dropdown shows only parts associated with that supplier.

4. **"Show only items with inventory"** toggle — when on, hides parts with no `inventory_lots` rows.

### 3.3 Supplier list

Below the filters, show a scrollable list of supplier cards.

- Each card has the supplier name/code and a chevron.
- Tapping a card expands it and loads/shows the supplier's items.
- Only one supplier expanded at a time, or multiple allowed (decision below).

### 3.4 Item row inside supplier

For each part associated with the supplier:

- Part number (`partNo`)
- Internal code (if any)
- Total quantity across all lots
- Location list:
  - Shelf code
  - Box ID (if in a shelf box or shipping box)
  - Quantity at that location
  - Date code / lot code / COO / COW (optional, shown if present)

## 4. Data Model

### 4.1 Supplier-part relationship

There is no direct `supplier_parts` table. Derive the relationship from historical orders:

```sql
SELECT DISTINCT s.id AS supplier_id, p.id AS part_id
FROM suppliers s
LEFT JOIN receiving_orders ro ON ro.supplier_id = s.id
LEFT JOIN receiving_invoices ri ON ri.receiving_order_id = ro.id
LEFT JOIN receiving_invoice_items rii ON rii.receiving_invoice_id = ri.id
LEFT JOIN parts p ON p.id = rii.part_id

UNION

SELECT DISTINCT s.id AS supplier_id, p.id AS part_id
FROM suppliers s
LEFT JOIN picking_orders po ON po.supplier_id = s.id
LEFT JOIN picking_items pi ON pi.picking_order_id = po.id
LEFT JOIN parts p ON p.id = pi.part_id
```

This gives every `(supplier, part)` pair that has ever appeared in a receiving or picking order.

### 4.2 Inventory aggregation

For each part, query `inventory_lots`:

```sql
SELECT
  part_id,
  date_code,
  lot_code,
  coo,
  cow,
  shelf_code,
  box_id,
  total_qty,
  allocated_qty,
  available_qty
FROM inventory_lots
WHERE part_id = ?
ORDER BY shelf_code, box_id
```

Group by part in the UI to show total and per-location rows.

## 5. Implementation

### 5.1 New files

- `pages/stock-search/index.vue` — the stock search page.
- `db/stockSearch.ts` — DB helpers:
  - `getSuppliersWithParts(db, filters)`
  - `getInventoryForPart(db, partId)`
  - `getPartsBySupplier(db, supplierId)`
- Update `pages/index.vue` — add Stock Search card.
- Update `i18n/locales/*.ts` — add translation keys.
- Update `docs/app-docs/flows/index.md` and related docs.

### 5.2 Query strategy

Because PGlite runs in the browser, keep queries lightweight:

1. Load suppliers once on mount.
2. Load supplier-part mapping once (or derive on the fly).
3. When a supplier is expanded, load parts + inventory for that supplier only.
4. Apply keyword and filter matching in memory to avoid complex parameterized queries.

### 5.3 Component structure

```text
pages/stock-search/index.vue
├── StockSearchHeader
│   ├── keyword input
│   ├── supplier filter
│   ├── item filter
│   └── inventory-only toggle
└── SupplierList
    └── SupplierCard (expandable)
        └── PartInventoryList
            └── PartInventoryItem
```

Keep components inline in the page file unless they grow large; follow existing project conventions.

## 6. Decisions to Confirm

### 6.1 Single vs multiple expanded suppliers

Recommend **single expanded supplier** to keep the mobile UI simple. A second tap collapses the first.

### 6.2 Inventory display detail

Recommend showing:

- Total qty
- Per-location rows with shelf/box and qty
- Optional lot/date/COO/COW shown in a muted subtitle

### 6.3 Supplier-part source

Derive from `receiving_invoice_items` and `picking_items` via their parent order's `supplier_id`. No schema change needed.

## 7. Out of Scope

- Editing inventory from the search page.
- Real-time live query (manual reload on mount/focus is fine per project conventions).
- Advanced filters (zone, date range, allocation status).
- Export or print.

## 8. Verification

- `pnpm nuxt prepare` runs cleanly.
- `pnpm test` passes.
- Manual check: log in, open Stock Search, expand a supplier, confirm parts and quantities match `inventory_lots`.
- Verify supplier filter narrows item filter options.
- Verify "inventory only" toggle hides parts with no lots.

## 9. Documentation Updates

- Update `docs/app-docs/README.md` quick links if a new top-level concept/utility page is added.
- Add `docs/app-docs/flows/stock-search/overview.md` and `ai-scope.md`.
- Update `docs/app-docs/ai/feature-registry.md` and `docs/app-docs/ai/code-map.md`.
