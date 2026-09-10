<script setup lang="ts">
import type { PickingOrderRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<PickingOrderRow[]>([]);
const loading = ref(false);
const error = ref("");
const status = ref("");
const search = ref("");

const STATUSES = ["", "pending", "picking", "finished", "issue", "shipped"];

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) =>
      r.orderNo.toLowerCase().includes(q) ||
      (r.customerCode ?? "").toLowerCase().includes(q) ||
      (r.poNo ?? "").toLowerCase().includes(q) ||
      (r.shipTo ?? "").toLowerCase().includes(q)
  );
});

// accessors resolve the derived display values used for sorting.
const columnDefs = computed<AdminColumnDef<PickingOrderRow>[]>(() => [
  { key: "prioritySeq", label: "#", size: 50 },
  { key: "orderNo", label: t("admin.pages.pickingOrders.orderNo"), size: 150 },
  { key: "status", label: t("admin.pages.pickingOrders.status"), size: 100 },
  { key: "customerCode", label: t("admin.pages.pickingOrders.customer"), size: 110 },
  { key: "poNo", label: t("admin.pages.pickingOrders.poNo"), size: 130 },
  { key: "shipTo", label: t("admin.pages.pickingOrders.shipTo"), size: 200 },
  {
    key: "deliveryDate",
    label: t("admin.pages.pickingOrders.deliveryDate"),
    accessor: (r) => r.deliveryDate ?? "",
    size: 120,
  },
  { key: "itemCount", label: t("admin.pages.pickingOrders.items"), size: 80 },
  {
    key: "pickedRatio",
    label: t("admin.pages.pickingOrders.pickedTotal"),
    accessor: (r) => (r.totalQty > 0 ? r.pickedQty / r.totalQty : 0),
    size: 100,
  },
  {
    key: "allocation",
    label: t("admin.pages.pickingOrders.allocation"),
    accessor: (r) => (r.totalQty > 0 ? r.allocatedQty / r.totalQty : 0),
    size: 170,
  },
  { key: "workingByName", label: t("admin.pages.pickingOrders.lockedBy"), size: 110 },
  { key: "createdDate", label: t("admin.fields.createdDate"), size: 170 },
  { key: "lastUpdateDate", label: t("admin.fields.lastUpdateDate"), size: 170 },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "picking-list",
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
    rows.value = await flow.listPickingOrders(status.value || undefined);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(status, load);
onMounted(load);

// Reload when picking data changes elsewhere (PDA picks, sync, allocation).
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(
  [
    "picking_order.created",
    "picking_order.updated",
    "picking_order.deleted",
    "picking.reordered",
    "allocation.computed",
  ],
  load
);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.pickingOrders.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <NuxtLink to="/picking/reorder" class="btn">{{ $t("admin.pages.pickingOrders.reorderPriority") }}</NuxtLink>
      </div>
    </div>

    <div class="filters">
      <select v-model="status">
        <option v-for="s in STATUSES" :key="s" :value="s">
          {{ s ? $t(`status.picking.${s}`) : $t("admin.common.allStatuses") }}
        </option>
      </select>
      <input v-model="search" :placeholder="$t('admin.pages.pickingOrders.searchPlaceholder')" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :empty-text="$t('admin.pages.pickingOrders.none')"
      :on-reset-columns="resetColumnState"
      @row-click="(r) => navigateTo(`/picking-orders/${r.id}`)"
    >
      <template #cell-status="{ row }">{{ $t(`status.picking.${row.status}`) }}</template>
      <template #cell-prioritySeq="{ row }">
        <span class="muted">{{ row.prioritySeq }}</span>
      </template>
      <template #cell-deliveryDate="{ row }">
        {{ row.deliveryDate ? new Date(row.deliveryDate).toLocaleDateString() : "—" }}
      </template>
      <template #cell-pickedRatio="{ row }">{{ row.pickedQty }} / {{ row.totalQty }}</template>
      <template #cell-allocation="{ row }">
        {{ $t(`admin.pages.pickingOrders.allocationLabels.${row.allocationStatus}`) }}
        ({{ row.allocatedQty }} / {{ row.totalQty }})
      </template>
      <template #cell-workingByName="{ row }">{{ row.workingByName ?? "" }}</template>
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
