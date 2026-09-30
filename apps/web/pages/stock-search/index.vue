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
          <select v-model="selectedSupplierCode">
            <option value="">{{ $t('stockSearch.allSuppliers') }}</option>
            <option v-for="s in suppliers" :key="s.id" :value="s.code">{{ s.name }}</option>
          </select>
        </label>

        <div class="field">
          <span>{{ $t('stockSearch.brand') }}</span>
          <FilterChipGroup
            v-model="selectedBrands"
            :options="brandOptions"
            :search-placeholder="$t('stockSearch.filterPlaceholder')"
            :aria-label="$t('stockSearch.brand')"
          />
        </div>

        <div class="field">
          <span>{{ $t('stockSearch.location') }}</span>
          <FilterChipGroup
            v-model="selectedLocations"
            :options="locationOptions"
            :search-placeholder="$t('stockSearch.filterPlaceholder')"
            :aria-label="$t('stockSearch.location')"
          />
        </div>

        <div class="field">
          <span>{{ $t('stockSearch.filterShelf') }}</span>
          <FilterChipGroup
            v-model="selectedShelves"
            :options="shelfOptions"
            :search-placeholder="$t('stockSearch.filterPlaceholder')"
            :aria-label="$t('stockSearch.filterShelf')"
          />
        </div>

        <label class="field">
          <span>{{ $t('stockSearch.drawingNo') }}</span>
          <input
            v-model="drawingNo"
            type="search"
            class="search-input"
            :placeholder="$t('stockSearch.drawingNoPlaceholder')"
          />
        </label>

        <div class="field">
          <span>{{ $t('stockSearch.dateCode') }}</span>
          <div class="date-range">
            <input v-model="dcFrom" type="date" class="search-input" :aria-label="$t('stockSearch.dateCodeFrom')" />
            <span class="date-range__sep">{{ $t('stockSearch.dateCodeTo') }}</span>
            <input v-model="dcTo" type="date" class="search-input" :aria-label="$t('stockSearch.dateCodeTo')" />
            <button v-if="dcActive" type="button" class="date-range__clear" @click="clearDateRange">
              {{ $t('stockSearch.dateCodeClear') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <p v-if="summary" class="summary-strip">
      {{ $t('stockSearch.summaryItems') }}: {{ summary.partCount.toLocaleString() }} ·
      {{ $t('stockSearch.summaryOnHandQty') }}: {{ summary.totalQty.toLocaleString() }} ·
      {{ $t('stockSearch.summaryAvailableQty') }}: {{ summary.availableQty.toLocaleString() }}
    </p>

    <EmptyState v-if="pending && rows.length === 0">{{ $t('common.loading') }}</EmptyState>
    <EmptyState v-else-if="error" error>{{ $t('common.errorPrefix', { message: error }) }}</EmptyState>

    <div v-else class="part-list">
      <EmptyState v-if="total === 0">{{ $t('stockSearch.noResults') }}</EmptyState>

      <div v-for="group in partGroups" :key="group.key" class="part-item">
        <div class="part-item__header">
          <strong>{{ group.wclItemNo ?? group.partNo }}</strong>
          <span class="part-item__qty">{{ $t('stockSearch.onHand', { qty: group.onHandQty }) }}</span>
        </div>

        <div v-if="groupMeta(group)" class="part-item__meta">{{ groupMeta(group) }}</div>

        <ul class="part-item__lots">
          <li v-for="(lot, index) in group.lots" :key="index" class="lot-row">
            <span class="lot-row__location">{{ locationLabel(lot) }}</span>
            <span class="lot-row__qty">{{ $t('stockSearch.lotQty', { available: lot.availableQty, total: lot.totalQty }) }}</span>
            <span v-if="batchLabel(lot)" class="lot-row__meta">{{ batchLabel(lot) }}</span>
          </li>
        </ul>
      </div>

      <div v-if="total > 0" class="pager">
        <p class="pager__info">{{ $t('common.showingOf', { shown: rows.length, total }) }}</p>
        <button
          v-if="rows.length < total"
          type="button"
          class="pager__more"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{ loadingMore ? $t('common.loading') : $t('common.loadMore') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import EmptyState from "~/components/EmptyState.vue";
import FilterChipGroup, { type FilterChipOption } from "~/components/FilterChipGroup.vue";
import { useVisibleReload } from "~/composables/useVisibleReload";
import { useErrorMessage } from "~/composables/errorMessage";
import { useWarehouse } from "~/composables/useWarehouse";
import { dateToDateCode } from "~/utils/dateCode";
import type {
  StockSearchFilters,
  StockSearchLot,
  StockSearchOptions,
  StockSearchSummary,
  SupplierListRow,
} from "~/services/types";

definePageMeta({ title: "meta.stockSearch", props: { noPadding: true } });

const { t } = useI18n();
const route = useRoute();
const warehouse = useWarehouse();
const errorMessage = useErrorMessage();

useHead({ title: t("stockSearch.title") });

// The list is server-paged (GET /stock-search?page=&pageSize= → {rows,total})
// and accumulates pages client-side via the "load more" button.
const PAGE_SIZE = 50;

const pending = ref(true);
const error = ref<string | null>(null);
const suppliers = ref<SupplierListRow[]>([]);
const rows = ref<StockSearchLot[]>([]);
const total = ref(0);
const page = ref(1);
const loadingMore = ref(false);
const summary = ref<StockSearchSummary | null>(null);
const options = ref<StockSearchOptions | null>(null);

const partNo = ref("");
const selectedSupplierCode = ref("");
const selectedBrands = ref<string[]>([]);
const selectedLocations = ref<string[]>([]);
const selectedShelves = ref<string[]>([]);
const drawingNo = ref("");
// Date-code range (WWYY): native date pickers converted to WWYY codes, same
// pattern as the admin stock-search page.
const dcFrom = ref("");
const dcTo = ref("");
const dcActive = computed(() => !!dcFrom.value || !!dcTo.value);
const filtersExpanded = ref(false);

// Restrict the hardware decoder to the selected supplier's barcode-type
// whitelist (no-op when no supplier is chosen or the profile has none).
useSupplierSymbologyScope(computed(() => selectedSupplierCode.value || undefined));

const brandOptions = computed<FilterChipOption[]>(() =>
  (options.value?.brands ?? []).map((b) => ({ value: b, label: b }))
);

// Combined location options: one chip per org_info (org, sub-inventory) pair,
// grouped by org. The value is the exact "orgId:code" pair the backend
// matches on; the backend already limits locations to the caller's
// user_profiles sub-inventory scope.
const locationOptions = computed<FilterChipOption[]>(() => {
  const out: FilterChipOption[] = [];
  for (const l of options.value?.locations ?? []) {
    if (l.orgId === null || !l.subInventoryCode) continue;
    const orgLabel = l.officeCode ?? String(l.orgId);
    out.push({
      value: `${l.orgId}:${l.subInventoryCode}`,
      label: l.description ? `${orgLabel} / ${l.subInventoryCode} — ${l.description}` : `${orgLabel} / ${l.subInventoryCode}`,
      group: orgLabel,
    });
  }
  return out;
});

const shelfOptions = computed<FilterChipOption[]>(() =>
  (options.value?.shelves ?? []).map((s) => ({
    value: s.code,
    label: s.zone ? `${s.displayName ?? s.code} — ${s.zone}` : (s.displayName ?? s.code),
  }))
);

// Loaded lot rows grouped by part for the card list. Default row order sorts
// by part first, so a part's lots arrive (mostly) contiguously; onHandQty is
// the Σ totalQty of the lots loaded so far — the summary strip above the
// list carries the authoritative filtered totals.
const partGroups = computed(() => {
  const map = new Map<string, {
    key: string;
    partNo: string;
    wclItemNo: string | null;
    description: string | null;
    onHandQty: number;
    lots: StockSearchLot[];
  }>();
  for (const lot of rows.value) {
    let group = map.get(lot.partNo);
    if (!group) {
      group = {
        key: lot.partNo,
        partNo: lot.partNo,
        wclItemNo: lot.wclItemNo,
        description: lot.description,
        onHandQty: 0,
        lots: [],
      };
      map.set(lot.partNo, group);
    }
    group.onHandQty += lot.totalQty;
    group.lots.push(lot);
  }
  return [...map.values()];
});

function currentFilters(): StockSearchFilters {
  return {
    supplierCode: selectedSupplierCode.value || undefined,
    partNo: partNo.value.trim() || undefined,
    drawingNo: drawingNo.value.trim() || undefined,
    brand: selectedBrands.value.length ? selectedBrands.value : undefined,
    location: selectedLocations.value.length ? selectedLocations.value : undefined,
    shelfCode: selectedShelves.value.length ? selectedShelves.value : undefined,
    dateCodeFrom: dcFrom.value ? dateToDateCode(new Date(`${dcFrom.value}T00:00:00`)) : undefined,
    dateCodeTo: dcTo.value ? dateToDateCode(new Date(`${dcTo.value}T00:00:00`)) : undefined,
  };
}

function clearDateRange() {
  dcFrom.value = "";
  dcTo.value = "";
}

async function loadOptions() {
  try {
    options.value = await warehouse.getStockSearchOptions();
  } catch {
    options.value = null;
  }
}

// Stale-response guard: the search re-fires on every filter change, so a
// slower earlier request must not overwrite newer results.
let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  error.value = null;
  page.value = 1;
  loadingMore.value = false;
  const filters = currentFilters();
  try {
    const [result, totals] = await Promise.all([
      warehouse.searchStockPage(filters, 1, PAGE_SIZE),
      warehouse.getStockSearchSummary(filters),
    ]);
    if (seq !== loadSeq) return;
    rows.value = result.rows;
    total.value = result.total;
    summary.value = totals;
  } catch (e) {
    if (seq !== loadSeq) return;
    error.value = errorMessage(e);
  } finally {
    if (seq === loadSeq) pending.value = false;
  }
}

async function loadMore() {
  const seq = loadSeq;
  loadingMore.value = true;
  try {
    const result = await warehouse.searchStockPage(currentFilters(), page.value + 1, PAGE_SIZE);
    if (seq !== loadSeq) return;
    page.value += 1;
    rows.value = [...rows.value, ...result.rows];
    total.value = result.total;
  } catch (e) {
    if (seq === loadSeq) error.value = errorMessage(e);
  } finally {
    if (seq === loadSeq) loadingMore.value = false;
  }
}

onMounted(async () => {
  loadOptions();
  try {
    suppliers.value = await warehouse.getSuppliers();
  } catch (e) {
    error.value = errorMessage(e);
  }
});

watch(
  [partNo, selectedSupplierCode, selectedBrands, selectedLocations, selectedShelves, drawingNo, dcFrom, dcTo],
  load
);

useVisibleReload(() => {
  loadOptions();
  load();
});

function groupMeta(group: { partNo: string; wclItemNo: string | null; description: string | null }): string {
  return [
    group.partNo !== (group.wclItemNo ?? group.partNo) ? group.partNo : null,
    group.description,
  ]
    .filter(Boolean)
    .join(" · ");
}

// Org (office) + sub-inventory + shelf + box; the API returns fields, the
// client formats the label.
function locationLabel(lot: StockSearchLot): string {
  return [
    lot.officeCode ?? (lot.orgId != null ? `Org ${lot.orgId}` : null),
    lot.subInventoryCode,
    lot.shelfCode,
    lot.boxId,
  ]
    .filter(Boolean)
    .join(" · ");
}

function batchLabel(lot: StockSearchLot): string {
  return [lot.dateCode, lot.lotCode, lot.coo, lot.cow, lot.drawingNo]
    .filter(Boolean)
    .join(" / ");
}
</script>

<style scoped>
.stock-search {
  padding: 1rem 0;
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

.date-range {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.date-range input {
  flex: 1;
  min-width: 0;
}

.date-range__sep {
  color: var(--muted);
  flex-shrink: 0;
}

.date-range__clear {
  flex-basis: 100%;
  padding: 0.375rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--muted);
  font-size: 0.875rem;
  cursor: pointer;
}

.summary-strip {
  margin: 0 0 0.75rem;
  color: var(--muted);
  font-size: 0.8125rem;
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

.pager {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0 1rem;
}

.pager__info {
  margin: 0;
  color: var(--muted);
  font-size: 0.8125rem;
}

.pager__more {
  width: 100%;
  min-height: 2.75rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--text);
  font-size: 0.9375rem;
  cursor: pointer;
}

.pager__more:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
