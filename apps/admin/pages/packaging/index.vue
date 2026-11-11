<script setup lang="ts">
// Packaging queue (打包, spec 2026-11-10-packaging-shipping-steps-design.md):
// verified orders awaiting the weight + box/pallet confirm. The admin twin of
// the PDA queue — confirm here or on the device, both hit the same endpoint.
import type { PackagingOrderRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<PackagingOrderRow[]>([]);
const loading = ref(false);
const error = ref("");
const search = ref("");

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) =>
      r.orderNo.toLowerCase().includes(q) ||
      (r.customerCode ?? "").toLowerCase().includes(q) ||
      (r.shipTo ?? "").toLowerCase().includes(q)
  );
});

const columnDefs = computed<AdminColumnDef<PackagingOrderRow>[]>(() => [
  { key: "orderNo", label: t("admin.pages.packaging.orderNo") },
  { key: "customerCode", label: t("admin.pages.packaging.customer"), accessor: (r) => r.customerCode ?? "" },
  { key: "shipTo", label: t("admin.pages.packaging.shipTo"), accessor: (r) => r.shipTo ?? "" },
  { key: "poNo", label: t("admin.pages.packaging.poNo"), accessor: (r) => r.poNo ?? "" },
  { key: "boxCount", label: t("admin.pages.packaging.boxes"), size: 90 },
  { key: "packageCount", label: t("admin.pages.packaging.packages"), size: 100 },
  { key: "grossWeightHint", label: t("admin.pages.packaging.grossHint"), size: 120 },
  { key: "assignee", label: t("admin.pages.packaging.assignee"), size: 120 },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "packaging-list",
  columns: columnDefs,
  rows: filtered,
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
const total = computed(() => filtered.value.length);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await flow.listPackagingOrders("pending");
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(["picking.packaged", "picking_order.updated"], load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.packaging.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
      </div>
    </div>

    <div class="filters">
      <input v-model="search" :placeholder="$t('admin.pages.packaging.searchPlaceholder')" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :row-id="(r: PackagingOrderRow) => r.id"
      :empty-text="$t('admin.pages.packaging.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-orderNo="{ row }">
        <span class="clickable" @click="navigateTo(`/packaging/${row.id}`)">{{ row.orderNo }}</span>
      </template>
      <template #cell-customerCode="{ row }">{{ row.customerCode ?? "—" }}</template>
      <template #cell-shipTo="{ row }">{{ row.shipTo ?? "—" }}</template>
      <template #cell-poNo="{ row }">{{ row.poNo ?? "—" }}</template>
      <template #cell-grossWeightHint="{ row }">{{ row.grossWeightHint ?? "—" }}</template>
      <template #cell-assignee="{ row }">{{ row.assignee ?? "—" }}</template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  gap: 0.625rem;
  margin-bottom: 0.75rem;
}
.filters input {
  flex: 1;
  padding: 0.4375rem 0.5625rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}
.head-actions {
  display: flex;
  gap: 0.625rem;
}
.clickable {
  cursor: pointer;
  color: #0b5cab;
}
</style>
