<template>
  <div class="stock-search">
    <div
      class="filters-panel card"
      :class="{ 'filters-panel--flush-top': route.meta.props?.noPadding }"
    >
      <div class="filters-panel__header" @click="filtersExpanded = !filtersExpanded">
        <input
          v-model="keyword"
          type="search"
          class="search-input filters-panel__search"
          :placeholder="$t('stockSearch.searchPlaceholder')"
          @click.stop
        />
        <button
          type="button"
          class="filters-panel__toggle"
          :aria-label="$t('actions.toggleDetails')"
          @click.stop="filtersExpanded = !filtersExpanded"
        >
          {{ filtersExpanded ? '▲' : '▼' }}
        </button>
      </div>

      <div v-if="filtersExpanded" class="filters-panel__body">
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
          <span class="supplier-card__counts">{{ $t('stockSearch.supplierCounts', { withInventory: supplier.partsWithInventory, total: supplier.totalParts }) }}</span>
          <span class="supplier-card__chevron">{{ expandedSupplierId === supplier.id ? '▾' : '▸' }}</span>
        </button>

        <div v-if="expandedSupplierId === supplier.id" class="supplier-card__body">
          <EmptyState v-if="loadingSupplierId === supplier.id">{{ $t('common.loading') }}</EmptyState>
          <EmptyState v-else-if="supplierPartInventory.length === 0">{{ $t('stockSearch.noItems') }}</EmptyState>

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
                <span class="lot-row__qty">{{ $t('stockSearch.lotQty', { available: lot.availableQty, total: lot.totalQty }) }}</span>
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
import EmptyState from "~/components/EmptyState.vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import {
  getSuppliersWithInventoryStats,
  getPartsBySupplierId,
  getInventoryLotsForParts,
  type StockSearchSupplierWithStats,
  type StockSearchPart,
  type StockSearchInventoryLot,
} from "~/db/stockSearch";

definePageMeta({ title: "meta.stockSearch", props: { noPadding: true } });

const { t } = useI18n();
const route = useRoute();
const db = await useDb();
const errorMessage = useErrorMessage();

useHead({ title: t("stockSearch.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const suppliers = ref<StockSearchSupplierWithStats[]>([]);
const partsBySupplier = ref<Record<string, StockSearchPart[]>>({});
const lotsByPart = ref<Record<string, StockSearchInventoryLot[]>>({});
const expandedSupplierId = ref<string | null>(null);
const loadingSupplierId = ref<string | null>(null);

const keyword = ref("");
const selectedSupplierId = ref("");
const selectedPartId = ref("");
const onlyWithInventory = ref(false);
const filtersExpanded = ref(false);

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

  if (onlyWithInventory.value) {
    list = list.filter((s) => s.partsWithInventory > 0);
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
    suppliers.value = await getSuppliersWithInventoryStats(db);
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
    loadingSupplierId.value = supplierId;
    try {
      const parts = await getPartsBySupplierId(db, supplierId);
      partsBySupplier.value[supplierId] = parts;

      const partIds = parts.map((p) => p.id);
      if (partIds.length > 0) {
        const lots = await getInventoryLotsForParts(db, partIds);
        const nextLots: Record<string, StockSearchInventoryLot[]> = {};
        for (const lot of lots) {
          const list = nextLots[lot.partId] ?? [];
          list.push(lot);
          nextLots[lot.partId] = list;
        }
        lotsByPart.value = { ...lotsByPart.value, ...nextLots };
      }
    } catch (e) {
      error.value = errorMessage(e);
      expandedSupplierId.value = null;
    } finally {
      loadingSupplierId.value = null;
    }
  }
}

watch(selectedSupplierId, () => {
  selectedPartId.value = "";
  if (selectedSupplierId.value) {
    expandedSupplierId.value = selectedSupplierId.value;
    toggleSupplier(selectedSupplierId.value);
  } else {
    expandedSupplierId.value = null;
  }
});

useVisibleReload(load);
</script>

<style scoped>
.stock-search {
  padding: 0 1rem 1rem;
}

.filters-panel {
  margin-bottom: 1rem;
  background: var(--surface);
}

.filters-panel--flush-top {
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}

.filters-panel__header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  cursor: pointer;
}

.filters-panel__search {
  flex: 1;
  min-width: 0;
}

.filters-panel__toggle {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 0.875rem;
  cursor: pointer;
  padding: 0.25rem;
}

.filters-panel__body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0 1rem 0.75rem;
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
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
  justify-content: flex-start;
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

.supplier-card__counts {
  margin-left: auto;
  margin-right: 0.75rem;
  color: var(--muted);
  font-size: 0.875rem;
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
