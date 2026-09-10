<script setup lang="ts">
import type { StockSearchLot, StockSearchPart, StockSearchResult } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const api = useApi();
const flow = useFlowApi();
const { t } = useI18n();

const suppliers = ref<{ id: string; code: string; name: string }[]>([]);
const supplierCode = ref("");
const partNo = ref("");

const result = ref<StockSearchResult | null>(null);
const searched = ref(false);
const loading = ref(false);
const error = ref("");

const partsRows = computed(() => result.value?.parts ?? []);
const lotsRows = computed(() => result.value?.lots ?? []);

const partsColumnDefs = computed<AdminColumnDef<StockSearchPart>[]>(() => [
  {
    key: "wclItemNo",
    label: t("admin.pages.stockSearch.wclItemNo"),
    accessor: (p) => p.wclItemNo ?? p.partNo,
    size: 140,
  },
  { key: "partNo", label: t("admin.pages.stockSearch.partNo"), size: 150 },
  {
    key: "description",
    label: t("admin.pages.stockSearch.description"),
    accessor: (p) => p.description ?? "",
    size: 220,
  },
  { key: "onHandQty", label: t("admin.pages.stockSearch.onHandQty"), size: 90 },
]);

const lotsColumnDefs = computed<AdminColumnDef<StockSearchLot>[]>(() => [
  {
    key: "partNo",
    label: t("admin.pages.stockSearch.partNo"),
    accessor: (l) => l.wclItemNo ?? l.partNo,
    size: 150,
  },
  {
    key: "dateCode",
    label: t("admin.pages.stockSearch.dateCode"),
    accessor: (l) => l.dateCode ?? "",
    size: 100,
  },
  {
    key: "lotCode",
    label: t("admin.pages.stockSearch.lotCode"),
    accessor: (l) => l.lotCode ?? "",
    size: 110,
  },
  {
    key: "shelfCode",
    label: t("admin.pages.stockSearch.shelf"),
    accessor: (l) => l.shelfCode ?? "",
    size: 90,
  },
  {
    key: "boxId",
    label: t("admin.pages.stockSearch.box"),
    accessor: (l) => l.boxId ?? "",
    size: 100,
  },
  {
    key: "orgSubInventory",
    label: t("admin.pages.stockSearch.orgSubInventory"),
    accessor: (l) => `${l.orgId ?? "—"} / ${l.subInventoryCode ?? "—"}`,
    size: 130,
  },
  { key: "totalQty", label: t("admin.pages.stockSearch.totalQty"), size: 90 },
  { key: "allocatedQty", label: t("admin.pages.stockSearch.allocatedQty"), size: 100 },
  { key: "availableQty", label: t("admin.pages.stockSearch.availableQty"), size: 100 },
]);

const { table: partsTable, pagination: partsPagination, resetColumnState: resetPartsColumns } = useAdminTable({
  tableId: "stock-search-parts",
  columns: partsColumnDefs,
  rows: partsRows,
  getRowId: (p) => p.id,
});

const { table: lotsTable, pagination: lotsPagination, resetColumnState: resetLotsColumns } = useAdminTable({
  tableId: "stock-search-lots",
  columns: lotsColumnDefs,
  rows: lotsRows,
});

// Pager uses a 1-based page; the table uses a 0-based pageIndex.
const partsPage = computed({
  get: () => partsPagination.value.pageIndex + 1,
  set: (v: number) => {
    partsPagination.value = { ...partsPagination.value, pageIndex: v - 1 };
  },
});
const partsPageSize = computed({
  get: () => partsPagination.value.pageSize,
  set: (v: number) => {
    partsPagination.value = { pageIndex: 0, pageSize: v };
  },
});
const lotsPage = computed({
  get: () => lotsPagination.value.pageIndex + 1,
  set: (v: number) => {
    lotsPagination.value = { ...lotsPagination.value, pageIndex: v - 1 };
  },
});
const lotsPageSize = computed({
  get: () => lotsPagination.value.pageSize,
  set: (v: number) => {
    lotsPagination.value = { pageIndex: 0, pageSize: v };
  },
});

async function loadSuppliers() {
  try {
    suppliers.value = await api.get("/admin/suppliers");
  } catch {
    suppliers.value = [];
  }
}

async function search() {
  loading.value = true;
  error.value = "";
  try {
    result.value = await flow.stockSearch({
      supplierCode: supplierCode.value || undefined,
      partNo: partNo.value.trim() || undefined,
    });
    searched.value = true;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(loadSuppliers);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.stockSearch.title") }}</h1>
    </div>

    <div class="filters">
      <select v-model="supplierCode" :aria-label="$t('admin.pages.stockSearch.supplier')">
        <option value="">{{ $t("admin.pages.stockSearch.allSuppliers") }}</option>
        <option v-for="s in suppliers" :key="s.id" :value="s.code">{{ s.code }} — {{ s.name }}</option>
      </select>
      <input
        v-model="partNo"
        :placeholder="$t('admin.pages.stockSearch.partNoPlaceholder')"
        @keyup.enter="search"
      />
      <button class="btn btn-primary" :disabled="loading" @click="search">
        {{ $t("admin.common.search") }}
      </button>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
    <p v-else-if="!searched" class="muted">{{ $t("admin.pages.stockSearch.hint") }}</p>

    <template v-else-if="result">
      <h2 class="section-title">{{ $t("admin.pages.stockSearch.parts") }}</h2>
      <DataTable
        :table="partsTable"
        :empty-text="$t('admin.pages.stockSearch.noParts')"
        :on-reset-columns="resetPartsColumns"
      >
        <template #cell-description="{ row }">
          <span class="wrap">{{ row.description ?? "—" }}</span>
        </template>
      </DataTable>
      <Pager v-model:page="partsPage" v-model:page-size="partsPageSize" :total="partsRows.length" />

      <h2 class="section-title">{{ $t("admin.pages.stockSearch.lots") }}</h2>
      <DataTable
        :table="lotsTable"
        :empty-text="$t('admin.pages.stockSearch.noLots')"
        :on-reset-columns="resetLotsColumns"
      />
      <Pager v-model:page="lotsPage" v-model:page-size="lotsPageSize" :total="lotsRows.length" />
    </template>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}
.filters select,
.filters input {
  padding: 7px 9px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
  font-size: 14px;
}
.filters input {
  flex: 1;
}
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
  color: #52606d;
}
.wrap {
  white-space: normal;
}
</style>
