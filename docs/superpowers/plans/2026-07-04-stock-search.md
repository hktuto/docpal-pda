# Stock Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/stock-search` page where operators can search products by supplier or item and see current stock with locations.

**Architecture:** Standalone Nuxt page with a DB helper that derives supplier-part relationships from existing order tables and aggregates `inventory_lots`. No schema changes. Manual reload on mount/visibility per project convention.

**Tech Stack:** Vue 3, Nuxt 3, PGlite/Drizzle, plain CSS, i18n.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `pages/stock-search/index.vue` | New stock search page: filters, supplier list, expandable items. |
| `db/stockSearch.ts` | DB helpers: suppliers with parts, parts by supplier, inventory for parts. |
| `pages/index.vue` | Add Stock Search card to home menu. |
| `i18n/locales/en-US.ts` | English labels for search, filters, results. |
| `i18n/locales/zh-CN.ts` | Chinese (Simplified) labels. |
| `i18n/locales/zh-HK.ts` | Chinese (Traditional) labels. |
| `docs/app-docs/flows/stock-search/overview.md` | User guide for the new flow. |
| `docs/app-docs/flows/stock-search/ai-scope.md` | AI scope for the new flow. |
| `docs/app-docs/flows/index.md` | Add stock-search row to flow matrix. |
| `docs/app-docs/README.md` | Add Stock Search to quick links. |
| `docs/app-docs/ai/feature-registry.md` | Register stock search feature. |
| `docs/app-docs/ai/code-map.md` | Add `/stock-search` route mapping. |

---

### Task 1: Add Stock Search card to home menu

**Files:**
- Modify: `pages/index.vue`

- [ ] **Step 1: Add route entry**

Find the existing menu cards in `pages/index.vue` and add a new card after Picking or Measuring:

```vue
<NuxtLink to="/stock-search" class="menu-card">
  <h2>{{ $t('home.stockSearch') }}</h2>
  <p>{{ $t('home.stockSearchDesc') }}</p>
</NuxtLink>
```

Match the existing card markup and CSS classes exactly.

- [ ] **Step 2: Verify link renders**

Run `pnpm dev` or inspect `pages/index.vue` to confirm the new card appears in the markup.

---

### Task 2: Add i18n translation keys

**Files:**
- Modify: `i18n/locales/en-US.ts`
- Modify: `i18n/locales/zh-CN.ts`
- Modify: `i18n/locales/zh-HK.ts`

- [ ] **Step 1: Add English keys**

Add to `i18n/locales/en-US.ts` inside the `home` object:

```typescript
stockSearch: 'Stock Search',
stockSearchDesc: 'Search inventory by supplier or item',
```

Add a new top-level `stockSearch` object:

```typescript
stockSearch: {
  title: 'Stock Search',
  searchPlaceholder: 'Search supplier or item...',
  allSuppliers: 'All suppliers',
  allItems: 'All items',
  filterSupplier: 'Supplier',
  filterItem: 'Item',
  onlyWithInventory: 'Only items with inventory',
  noResults: 'No results found.',
  noItems: 'No items for this supplier.',
  noInventory: 'No inventory',
  totalQty: 'Total: {qty}',
  location: 'Location',
  shelf: 'Shelf',
  box: 'Box',
  receivingArea: 'Receiving area',
}
```

- [ ] **Step 2: Add Chinese (Simplified) keys**

Add equivalent keys to `i18n/locales/zh-CN.ts`.

- [ ] **Step 3: Add Chinese (Traditional) keys**

Add equivalent keys to `i18n/locales/zh-HK.ts`.

---

### Task 3: Create DB helper for stock search

**Files:**
- Create: `db/stockSearch.ts`

- [ ] **Step 1: Write `db/stockSearch.ts`**

```typescript
import { eq, sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";

export type DbType = PgliteDatabase<typeof schema>;

export interface StockSearchSupplier {
  id: string;
  code: string;
  name: string;
}

export interface StockSearchPart {
  id: string;
  partNo: string;
  internalCode: string | null;
  description: string | null;
  defaultCoo: string | null;
}

export interface StockSearchInventoryLot {
  partId: string;
  dateCode: string | null;
  lotCode: string | null;
  coo: string | null;
  cow: string | null;
  shelfCode: string | null;
  boxId: string | null;
  totalQty: number;
  allocatedQty: number;
  availableQty: number;
  locationLabel: string;
}

export interface StockSearchSupplierPart {
  part: StockSearchPart;
  lots: StockSearchInventoryLot[];
  totalQty: number;
}

export async function getAllSuppliers(db: DbType): Promise<StockSearchSupplier[]> {
  return db.query.suppliers.findMany({
    orderBy: (suppliers, { asc }) => asc(suppliers.name),
  });
}

export async function getPartsBySupplierId(
  db: DbType,
  supplierId: string
): Promise<StockSearchPart[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT p.id, p.part_no, p.internal_code, p.description, p.default_coo
    FROM parts p
    WHERE p.id IN (
      SELECT rii.part_id
      FROM receiving_invoice_items rii
      JOIN receiving_invoices ri ON ri.id = rii.receiving_invoice_id
      JOIN receiving_orders ro ON ro.id = ri.receiving_order_id
      WHERE ro.supplier_id = ${supplierId}

      UNION

      SELECT pi.part_id
      FROM picking_items pi
      JOIN picking_orders po ON po.id = pi.picking_order_id
      WHERE po.supplier_id = ${supplierId}
    )
    ORDER BY p.part_no
  `);

  return result.rows.map((row) => ({
    id: String(row.id),
    partNo: String(row.part_no),
    internalCode: row.internal_code ? String(row.internal_code) : null,
    description: row.description ? String(row.description) : null,
    defaultCoo: row.default_coo ? String(row.default_coo) : null,
  }));
}

export async function getInventoryLotsForParts(
  db: DbType,
  partIds: string[]
): Promise<StockSearchInventoryLot[]> {
  if (partIds.length === 0) return [];

  const result = await db.execute(sql`
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
    WHERE part_id = ANY(${partIds}::text[])
    ORDER BY shelf_code NULLS LAST, box_id NULLS LAST
  `);

  return result.rows.map((row) => ({
    partId: String(row.part_id),
    dateCode: row.date_code ? String(row.date_code) : null,
    lotCode: row.lot_code ? String(row.lot_code) : null,
    coo: row.coo ? String(row.coo) : null,
    cow: row.cow ? String(row.cow) : null,
    shelfCode: row.shelf_code ? String(row.shelf_code) : null,
    boxId: row.box_id ? String(row.box_id) : null,
    totalQty: Number(row.total_qty),
    allocatedQty: Number(row.allocated_qty),
    availableQty: Number(row.available_qty),
    locationLabel: buildLocationLabel(row.shelf_code, row.box_id),
  }));
}

function buildLocationLabel(
  shelfCode: string | null,
  boxId: string | null
): string {
  if (shelfCode && boxId) return `${shelfCode} / ${boxId}`;
  if (shelfCode) return shelfCode;
  if (boxId) return boxId;
  return "receiving-area";
}
```

- [ ] **Step 2: Verify types**

Run `pnpm nuxt prepare` and confirm no TypeScript errors in `db/stockSearch.ts`.

---

### Task 4: Create the stock search page

**Files:**
- Create: `pages/stock-search/index.vue`

- [ ] **Step 1: Write the page**

```vue
<template>
  <div class="stock-search">
    <AppHeader :title="$t('stockSearch.title')" />

    <div class="filters">
      <input
        v-model="keyword"
        type="search"
        class="search-input"
        :placeholder="$t('stockSearch.searchPlaceholder')"
      />

      <label class="field">
        <span>{{ $t('stockSearch.filterSupplier') }}</span>
        <select v-model="selectedSupplierId">
          <option value="">{{ $t('stockSearch.allSuppliers') }}</option>
          <option v-for="s in suppliers" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>

      <label class="field">
        <span>{{ $t('stockSearch.filterItem') }}</span>
        <select v-model="selectedPartId" :disabled="!selectedSupplierId">
          <option value="">{{ $t('stockSearch.allItems') }}</option>
          <option v-for="p in supplierParts" :key="p.id" :value="p.id">{{ p.partNo }}</option>
        </select>
      </label>

      <label class="field field--checkbox">
        <input v-model="onlyWithInventory" type="checkbox" />
        <span>{{ $t('stockSearch.onlyWithInventory') }}</span>
      </label>
    </div>

    <EmptyState v-if="pending">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <div v-else class="supplier-list">
      <EmptyState v-if="filteredSuppliers.length === 0">{{ $t('stockSearch.noResults') }}</EmptyState>

      <div
        v-for="supplier in filteredSuppliers"
        :key="supplier.id"
        class="supplier-card"
        :class="{ 'supplier-card--expanded': expandedSupplierId === supplier.id }"
      >
        <button
          type="button"
          class="supplier-card__header"
          @click="toggleSupplier(supplier.id)"
        >
          <span class="supplier-card__name">{{ supplier.name }}</span>
          <span class="supplier-card__chevron">{{ expandedSupplierId === supplier.id ? '▾' : '▸' }}</span>
        </button>

        <div v-if="expandedSupplierId === supplier.id" class="supplier-card__body">
          <EmptyState v-if="supplierPartInventory.length === 0">{{ $t('stockSearch.noItems') }}</EmptyState>

          <div
            v-for="item in supplierPartInventory"
            :key="item.part.id"
            class="part-item"
          >
            <div class="part-item__header">
              <strong>{{ item.part.partNo }}</strong>
              <span class="part-item__qty">{{ $t('stockSearch.totalQty', { qty: item.totalQty }) }}</span>
            </div>

            <div v-if="item.lots.length === 0" class="part-item__empty">
              {{ $t('stockSearch.noInventory') }}
            </div>

            <ul v-else class="part-item__lots">
              <li v-for="(lot, index) in item.lots" :key="index" class="lot-row">
                <span class="lot-row__location">{{ lot.locationLabel }}</span>
                <span class="lot-row__qty">{{ lot.availableQty }} / {{ lot.totalQty }}</span>
                <span v-if="lot.dateCode || lot.lotCode" class="lot-row__meta">
                  {{ lot.dateCode }} / {{ lot.lotCode }}
                </span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppHeader from "~/components/AppHeader.vue";
import EmptyState from "~/components/EmptyState.vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import {
  getAllSuppliers,
  getPartsBySupplierId,
  getInventoryLotsForParts,
  type StockSearchSupplier,
  type StockSearchPart,
  type StockSearchInventoryLot,
} from "~/db/stockSearch";

definePageMeta({ title: "meta.stockSearch" });

const { t } = useI18n();
const db = await useDb();
const errorMessage = useErrorMessage();

useHead({ title: t("stockSearch.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const suppliers = ref<StockSearchSupplier[]>([]);
const partsBySupplier = ref<Record<string, StockSearchPart[]>>({});
const lotsByPart = ref<Record<string, StockSearchInventoryLot[]>>({});
const expandedSupplierId = ref<string | null>(null);

const keyword = ref("");
const selectedSupplierId = ref("");
const selectedPartId = ref("");
const onlyWithInventory = ref(false);

const lowerKeyword = computed(() => keyword.value.trim().toLowerCase());

const filteredSuppliers = computed(() => {
  let list = suppliers.value;

  if (selectedSupplierId.value) {
    list = list.filter((s) => s.id === selectedSupplierId.value);
  }

  if (lowerKeyword.value) {
    list = list.filter((s) =>
      s.name.toLowerCase().includes(lowerKeyword.value) ||
      s.code.toLowerCase().includes(lowerKeyword.value) ||
      (partsBySupplier.value[s.id] ?? []).some((p) =>
        p.partNo.toLowerCase().includes(lowerKeyword.value) ||
        (p.internalCode?.toLowerCase().includes(lowerKeyword.value) ?? false) ||
        (p.description?.toLowerCase().includes(lowerKeyword.value) ?? false)
      )
    );
  }

  return list;
});

const supplierParts = computed(() => {
  if (!selectedSupplierId.value) return [];
  return partsBySupplier.value[selectedSupplierId.value] ?? [];
});

const supplierPartInventory = computed(() => {
  if (!expandedSupplierId.value) return [];
  const parts = partsBySupplier.value[expandedSupplierId.value] ?? [];

  let items = parts.map((part) => {
    const lots = lotsByPart.value[part.id] ?? [];
    return {
      part,
      lots,
      totalQty: lots.reduce((sum, lot) => sum + lot.totalQty, 0),
    };
  });

  if (selectedPartId.value) {
    items = items.filter((item) => item.part.id === selectedPartId.value);
  }

  if (onlyWithInventory.value) {
    items = items.filter((item) => item.totalQty > 0);
  }

  return items;
});

async function load() {
  pending.value = true;
  error.value = null;
  try {
    suppliers.value = await getAllSuppliers(db);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}

async function toggleSupplier(supplierId: string) {
  if (expandedSupplierId.value === supplierId) {
    expandedSupplierId.value = null;
    return;
  }

  expandedSupplierId.value = supplierId;

  if (!partsBySupplier.value[supplierId]) {
    try {
      const parts = await getPartsBySupplierId(db, supplierId);
      partsBySupplier.value[supplierId] = parts;

      const partIds = parts.map((p) => p.id);
      if (partIds.length > 0) {
        const lots = await getInventoryLotsForParts(db, partIds);
        for (const lot of lots) {
          const list = lotsByPart.value[lot.partId] ?? [];
          list.push(lot);
          lotsByPart.value[lot.partId] = list;
        }
      }
    } catch (e) {
      error.value = errorMessage(e);
      expandedSupplierId.value = null;
    }
  }
}

watch(selectedSupplierId, () => {
  selectedPartId.value = "";
  expandedSupplierId.value = selectedSupplierId.value || null;
  if (selectedSupplierId.value) {
    toggleSupplier(selectedSupplierId.value);
  }
});

useVisibleReload(load);
</script>

<style scoped>
.stock-search {
  padding: 1rem;
}

.filters {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.search-input {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
}

.field--checkbox {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
}

.field select {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}

.supplier-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.supplier-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}

.supplier-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 0.75rem 1rem;
  background: transparent;
  border: none;
  color: var(--text);
  font-size: 1rem;
  text-align: left;
  cursor: pointer;
}

.supplier-card__body {
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border);
}

.part-item {
  padding: 0.75rem;
  background: var(--bg);
  border-radius: var(--radius);
  margin-bottom: 0.5rem;
}

.part-item__header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.part-item__qty {
  color: var(--muted);
  font-size: 0.875rem;
}

.part-item__empty {
  color: var(--muted);
  font-size: 0.875rem;
}

.part-item__lots {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.lot-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.875rem;
}

.lot-row__location {
  flex: 1;
}

.lot-row__qty {
  color: var(--muted);
}

.lot-row__meta {
  width: 100%;
  color: var(--muted);
  font-size: 0.75rem;
}
</style>
```

- [ ] **Step 2: Add route meta translation**

Add to i18n locale files under `meta`:

```typescript
stockSearch: 'Stock Search',
```

---

### Task 5: Update documentation

**Files:**
- Modify: `docs/app-docs/README.md`
- Modify: `docs/app-docs/flows/index.md`
- Create: `docs/app-docs/flows/stock-search/overview.md`
- Create: `docs/app-docs/flows/stock-search/ai-scope.md`
- Modify: `docs/app-docs/ai/feature-registry.md`
- Modify: `docs/app-docs/ai/code-map.md`

- [ ] **Step 1: Update `docs/app-docs/README.md`**

Add Stock Search to the operator flow list:

```markdown
6. [Stock Search](./flows/stock-search/overview.md)
```

- [ ] **Step 2: Update `docs/app-docs/flows/index.md`**

Add a row to the flow matrix:

```markdown
| [Stock Search](./stock-search/overview.md) | Search inventory by supplier or item and see locations. | `/stock-search` | [Overview](./stock-search/overview.md) | [Scope](./stock-search/ai-scope.md) |
```

- [ ] **Step 3: Create `docs/app-docs/flows/stock-search/overview.md`**

```markdown
# Stock Search Overview

Stock Search lets operators look up inventory across the warehouse.

## When to use it

Use Stock Search when you need to know:

- Whether a part is in stock.
- How much of a part is available.
- Where a part is located (shelf, box, or receiving area).

## Concept

1. Open Stock Search from the home screen.
2. Use the search bar or filters to narrow suppliers and items.
3. Tap a supplier card to expand it and see its items.
4. Each item shows total quantity and a list of inventory locations.

## Filters

- **Keyword search** — search by supplier name/code, part number, internal code, or description.
- **Supplier filter** — show only one supplier.
- **Item filter** — show only one item (available after selecting a supplier).
- **Only items with inventory** — hide items that currently have no stock.

## Related guides

- [AI scope](./ai-scope.md)
```

- [ ] **Step 4: Create `docs/app-docs/flows/stock-search/ai-scope.md`**

```markdown
# Stock Search — AI Scope and Remarks

## In scope

- List all suppliers as expandable cards.
- Search/filter by keyword, supplier, and item.
- Show parts associated with a supplier (derived from receiving and picking history).
- Show inventory-lot breakdown per part (location and quantity).
- Toggle to hide items with no inventory.

## Out of scope

- Editing inventory from the search page.
- Real-time live query (manual reload on mount/visibility).
- Advanced filters (zone, date range, allocation status).
- Export or print.

## Key files

- `pages/stock-search/index.vue` — search page.
- `db/stockSearch.ts` — query helpers.
- `pages/index.vue` — home menu card.

## Known limitations

- Supplier-part relationship is inferred from historical receiving/picking orders, not a formal catalog.
- No image or scan evidence shown here.

## Related specs/plans

- `docs/superpowers/specs/2026-07-04-stock-search-design.md`
```

- [ ] **Step 5: Update `docs/app-docs/ai/feature-registry.md`**

Add a row:

```markdown
| Stock Search | — | Shipped | `pages/stock-search/index.vue`, `db/stockSearch.ts` | [ai-scope](../flows/stock-search/ai-scope.md) |
```

- [ ] **Step 6: Update `docs/app-docs/ai/code-map.md`**

Add to the Pages table:

```markdown
| Stock Search | `/stock-search` | `pages/stock-search/index.vue` |
```

---

### Task 6: Verify

**Files:**
- All files above

- [ ] **Step 1: Run type generation**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm nuxt prepare
```

Expected: types generated without errors.

- [ ] **Step 2: Run tests**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
pnpm test
```

Expected: all tests pass.

- [ ] **Step 3: Manual browser check**

1. Run `pnpm dev`.
2. Log in as `operator` / `DocPal2026!`.
3. Tap **Stock Search** on the home screen.
4. Confirm all suppliers are listed.
5. Expand a supplier that has inventory (e.g., KOA) and confirm parts + quantities appear.
6. Test keyword search, supplier filter, item filter, and inventory-only toggle.

---

## Self-Review Checklist

- **Spec coverage:**
  - Home menu card — Task 1.
  - i18n keys — Task 2.
  - DB helpers — Task 3.
  - Stock search page — Task 4.
  - Documentation — Task 5.
  - Verification — Task 6.
- **Placeholder scan:** no TBD/TODO; all content is concrete.
- **Type consistency:** `DbType` reused from existing project patterns; types align with `db/stockSearch.ts` exports.
