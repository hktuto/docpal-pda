<script setup lang="ts">
import type { ReceivingOrderRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<ReceivingOrderRow[]>([]);
const loading = ref(false);
const error = ref("");
const status = ref("");
const search = ref("");

const STATUSES = ["", "pending", "in_hand", "provisional_received", "clear"];

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) =>
      r.batchNo.toLowerCase().includes(q) ||
      (r.supplierCode ?? "").toLowerCase().includes(q) ||
      (r.supplierName ?? "").toLowerCase().includes(q)
  );
});

// accessors resolve the derived display values used for sorting.
const columnDefs = computed<AdminColumnDef<ReceivingOrderRow>[]>(() => [
  { key: "batchNo", label: t("admin.pages.receiving.batchNo"), size: 130 },
  { key: "status", label: t("admin.pages.receiving.status"), size: 160 },
  {
    key: "supplier",
    label: t("admin.pages.receiving.supplier"),
    accessor: (r) => r.supplierName ?? r.supplierCode ?? "",
    size: 180,
  },
  {
    key: "deliveryDate",
    label: t("admin.pages.receiving.deliveryDate"),
    accessor: (r) => r.deliveryDate ?? "",
    size: 120,
  },
  { key: "invoiceCount", label: t("admin.pages.receiving.invoices"), size: 90 },
  { key: "itemCount", label: t("admin.pages.receiving.items"), size: 80 },
  { key: "remainingItems", label: t("admin.pages.receiving.remaining"), size: 100 },
  { key: "pendingPickingOrders", label: t("admin.pages.receiving.pendingPicking"), size: 130 },
  { key: "createdDate", label: t("admin.fields.createdDate"), size: 170 },
  { key: "lastUpdateDate", label: t("admin.fields.lastUpdateDate"), size: 170 },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "receiving-list",
  columns: columnDefs,
  rows: filtered,
  getRowId: (r) => r.id,
});

// Pager uses a 1-based page; the table uses a 0-based pageIndex.
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
const total = computed(() => filtered.value.length);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await flow.listReceivingOrders(status.value || undefined);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(status, load);
onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.receiving.title") }}</h1>
      <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
    </div>

    <div class="filters">
      <select v-model="status">
        <option v-for="s in STATUSES" :key="s" :value="s">{{ s || $t("admin.common.allStatuses") }}</option>
      </select>
      <input v-model="search" :placeholder="$t('admin.pages.receiving.searchPlaceholder')" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :empty-text="$t('admin.pages.receiving.none')"
      :on-reset-columns="resetColumnState"
      @row-click="(r) => navigateTo(`/receiving/${r.id}`)"
    >
      <template #cell-supplier="{ row }">{{ row.supplierName ?? row.supplierCode ?? "—" }}</template>
      <template #cell-deliveryDate="{ row }">
        {{ row.deliveryDate ? new Date(row.deliveryDate).toLocaleDateString() : "—" }}
      </template>
      <template #cell-createdDate="{ row }">{{ new Date(row.createdDate).toLocaleString() }}</template>
      <template #cell-lastUpdateDate="{ row }">{{ new Date(row.lastUpdateDate).toLocaleString() }}</template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
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
</style>
