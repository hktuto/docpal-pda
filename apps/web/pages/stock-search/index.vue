<template>
  <div class="stock-search">
    <div
      class="filters-panel card"
      :class="{ 'filters-panel--flush-top': route.meta.props?.noPadding }"
    >
      <div class="filters-panel__header" @click="filtersExpanded = !filtersExpanded">
        <input
          v-model="partNo"
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
          <span>{{ $t('stockSearch.filterShelf') }}</span>
          <input
            v-model="shelfCode"
            type="search"
            class="search-input"
            :placeholder="$t('stockSearch.shelfPlaceholder')"
          />
        </label>
      </div>
    </div>

    <EmptyState v-if="pending && parts.length === 0">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <div v-else class="part-list">
      <EmptyState v-if="parts.length === 0">{{ $t('stockSearch.noResults') }}</EmptyState>

      <div v-for="part in parts" :key="part.id" class="part-item">
        <div class="part-item__header">
          <strong>{{ part.partNo }}</strong>
          <span class="part-item__qty">{{ $t('stockSearch.onHand', { qty: part.onHandQty }) }}</span>
        </div>

        <div v-if="partMeta(part)" class="part-item__meta">{{ partMeta(part) }}</div>

        <ul class="part-item__lots">
          <li v-for="(lot, index) in lotsByPart[part.id] ?? []" :key="index" class="lot-row">
            <span class="lot-row__location">{{ locationLabel(lot) }}</span>
            <span class="lot-row__qty">{{ $t('stockSearch.lotQty', { available: lot.availableQty, total: lot.totalQty }) }}</span>
            <span v-if="batchLabel(lot)" class="lot-row__meta">{{ batchLabel(lot) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import EmptyState from "~/components/EmptyState.vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import type {
  StockSearchLot,
  StockSearchPart,
  SupplierListRow,
} from "~/services/types";

definePageMeta({ title: "meta.stockSearch", props: { noPadding: true } });

const { t } = useI18n();
const route = useRoute();
const warehouse = useWarehouse();
const errorMessage = useErrorMessage();

useHead({ title: t("stockSearch.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const suppliers = ref<SupplierListRow[]>([]);
const parts = ref<StockSearchPart[]>([]);
const lots = ref<StockSearchLot[]>([]);

const partNo = ref("");
const selectedSupplierId = ref("");
const shelfCode = ref("");
const filtersExpanded = ref(false);

const lotsByPart = computed(() => {
  const map: Record<string, StockSearchLot[]> = {};
  for (const lot of lots.value) {
    const list = map[lot.partId] ?? [];
    list.push(lot);
    map[lot.partId] = list;
  }
  return map;
});

// Stale-response guard: the search re-fires on every filter keystroke, so a
// slower earlier request must not overwrite newer results.
let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  error.value = null;
  try {
    const result = await warehouse.searchStock({
      supplierId: selectedSupplierId.value || undefined,
      partNo: partNo.value.trim() || undefined,
      shelfCode: shelfCode.value.trim() || undefined,
    });
    if (seq !== loadSeq) return;
    parts.value = result.parts;
    lots.value = result.lots;
  } catch (e) {
    if (seq !== loadSeq) return;
    error.value = errorMessage(e);
  } finally {
    if (seq === loadSeq) pending.value = false;
  }
}

onMounted(async () => {
  try {
    suppliers.value = await warehouse.getSuppliers();
  } catch (e) {
    error.value = errorMessage(e);
  }
});

watch([partNo, selectedSupplierId, shelfCode], load);

useVisibleReload(load);

function partMeta(part: StockSearchPart): string {
  return [part.wclItemNo, part.description, part.defaultCoo]
    .filter(Boolean)
    .join(" · ");
}

// Three-level location (warehouse → section → sub-inventory) + shelf + box;
// the API returns fields, the client formats the label.
function locationLabel(lot: StockSearchLot): string {
  return [
    lot.warehouseCode,
    lot.warehouseSectionCode,
    lot.subInventoryCode,
    lot.shelfCode,
    lot.boxId,
  ]
    .filter(Boolean)
    .join(" · ");
}

function batchLabel(lot: StockSearchLot): string {
  return [lot.dateCode, lot.lotCode, lot.coo, lot.cow]
    .filter(Boolean)
    .join(" / ");
}
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

.field select {
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}

.part-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.part-item {
  padding: 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
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

.part-item__meta {
  color: var(--muted);
  font-size: 0.75rem;
  margin-bottom: 0.5rem;
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
  flex-wrap: wrap;
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
