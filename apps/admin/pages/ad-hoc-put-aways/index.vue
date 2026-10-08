<script setup lang="ts">
import type { AdminColumnDef } from "~/composables/useAdminTable";

const { t } = useI18n();
const api = useApi();

const rows = ref<any[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref("");

// Filters
const filterSupplier = ref("");
const filterShelf = ref("");
const filterFrom = ref("");
const filterTo = ref("");

// Supplier options for the filter dropdown
const supplierOptions = ref<{ value: string; label: string }[]>([]);
const shelfOptions = ref<{ value: string; label: string }[]>([]);

const columnDefs = computed<AdminColumnDef<any>[]>(() => [
  { key: "id", label: t("admin.pages.adHocPutAways.id"), size: 100 },
  { key: "supplierCode", label: t("admin.pages.adHocPutAways.supplier"), size: 120 },
  { key: "shelfCode", label: t("admin.pages.adHocPutAways.shelf"), size: 110 },
  { key: "orgId", label: t("admin.pages.adHocPutAways.org"), size: 60 },
  { key: "subInventoryCode", label: t("admin.pages.adHocPutAways.subInventory"), size: 120 },
  { key: "itemCount", label: t("admin.pages.adHocPutAways.itemCount"), size: 80 },
  { key: "totalQty", label: t("admin.pages.adHocPutAways.totalQty"), size: 90 },
  { key: "actorId", label: t("admin.pages.adHocPutAways.actor"), size: 100 },
  { key: "createdDate", label: t("admin.pages.adHocPutAways.created"), size: 170 },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "ad-hoc-put-aways-list",
  columns: columnDefs,
  rows,
  getRowId: (r) => r.id,
});

const page = computed({
  get: () => pagination.value.pageIndex + 1,
  set: (v: number) => {
    pagination.value = { ...pagination.value, pageIndex: v - 1 };
  },
});

const pageSize = computed({
  get: () => pagination.value.pageSize,
  set: (v: number) => {
    pagination.value = { pageIndex: 0, pageSize: v };
  },
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams();
    params.set("page", String(page.value));
    params.set("pageSize", String(pageSize.value));
    if (filterSupplier.value) params.set("supplierCode", filterSupplier.value);
    if (filterShelf.value) params.set("shelfCode", filterShelf.value);
    if (filterFrom.value) params.set("from", filterFrom.value);
    if (filterTo.value) params.set("to", filterTo.value);
    const result = await api.get<{ rows: any[]; total: number }>(
      `/admin/ad-hoc-put-aways?${params}`
    );
    rows.value = result.rows;
    total.value = result.total;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function loadFilterOptions() {
  try {
    const [sups, shs] = await Promise.all([
      api.get<any[]>("/admin/suppliers"),
      api.get<any[]>("/admin/shelves"),
    ]);
    supplierOptions.value = sups.map((s) => ({ value: s.code, label: s.name || s.code }));
    shelfOptions.value = shs.map((s) => ({ value: s.code, label: s.code }));
  } catch {
    // Non-critical — filters just won't have options
  }
}

function applyFilters() {
  pagination.value = { ...pagination.value, pageIndex: 0 };
  load();
}

onMounted(() => {
  load();
  loadFilterOptions();
});
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.adHocPutAways.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">
          {{ $t("admin.common.refresh") }}
        </button>
      </div>
    </div>

    <!-- Filters -->
    <div class="filters">
      <SearchableSelect
        v-model="filterSupplier"
        :options="supplierOptions"
        :all-label="$t('admin.pages.adHocPutAways.filterSupplier')"
        :aria-label="$t('admin.pages.adHocPutAways.filterSupplier')"
        :multiple="false"
        @update:model-value="applyFilters"
      />
      <SearchableSelect
        v-model="filterShelf"
        :options="shelfOptions"
        :all-label="$t('admin.pages.adHocPutAways.filterShelf')"
        :aria-label="$t('admin.pages.adHocPutAways.filterShelf')"
        :multiple="false"
        @update:model-value="applyFilters"
      />
      <label class="filter-date">
        <span>{{ $t("admin.pages.adHocPutAways.filterFrom") }}</span>
        <input v-model="filterFrom" type="date" @change="applyFilters" />
      </label>
      <label class="filter-date">
        <span>{{ $t("admin.pages.adHocPutAways.filterTo") }}</span>
        <input v-model="filterTo" type="date" @change="applyFilters" />
      </label>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
    <DataTable
      v-else
      :table="table"
      :row-id="(r: any) => r.id"
      :empty-text="$t('admin.pages.adHocPutAways.noResults')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-id="{ row }">
        <NuxtLink :to="`/ad-hoc-put-aways/${row.id}`" :title="row.id">
          {{ row.id.slice(0, 8) }}
        </NuxtLink>
      </template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  gap: 0.75rem;
  align-items: flex-end;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.filter-date {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8125rem;
}
.filter-date input {
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.875rem;
}
</style>
