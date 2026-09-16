<script setup lang="ts">
import type { PickingOrderRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<PickingOrderRow[]>([]);
const loading = ref(false);
const error = ref("");
const status = ref("");
const orderTypes = ref<string[]>([]);
const search = ref("");

const STATUSES = ["pending", "picking", "finished", "issue", "shipped"];
const ORDER_TYPES = ["invoice", "tn"];

const statusOptions = computed<SearchableSelectOption[]>(() =>
  STATUSES.map((s) => ({ value: s, label: t(`status.picking.${s}`) }))
);

const orderTypeOptions = computed<SearchableSelectOption[]>(() =>
  ORDER_TYPES.map((v) => ({ value: v, label: v }))
);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  let list = rows.value;
  if (orderTypes.value.length) {
    list = list.filter((r) => r.pickingOrderType !== null && orderTypes.value.includes(r.pickingOrderType));
  }
  if (!q) return list;
  return list.filter(
    (r) =>
      r.orderNo.toLowerCase().includes(q) ||
      (r.customerCode ?? "").toLowerCase().includes(q) ||
      (r.poNo ?? "").toLowerCase().includes(q) ||
      (r.shipTo ?? "").toLowerCase().includes(q)
  );
});

// accessors resolve the derived display values used for sorting.
const columnDefs = computed<AdminColumnDef<PickingOrderRow>[]>(() => [
  { key: "orderNo", label: t("admin.pages.pickingOrders.orderNo"), size: 150 },
  { key: "status", label: t("admin.pages.pickingOrders.status"), size: 100 },
  {
    key: "pickingOrderType",
    label: t("admin.pages.pickingOrders.type"),
    accessor: (r) => r.pickingOrderType ?? "",
    size: 90,
  },
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
  {
    key: "remark",
    label: t("admin.pages.pickingOrders.remark"),
    accessor: (r) => r.remark ?? "",
    size: 200,
  },
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

// "Allocate all": awaited full-fleet recompute. Work-locked orders (open on
// a PDA) are skipped by the engine — the confirm text says so.
const allocating = ref(false);
const allocDoneMs = ref(0);
let allocDoneTimer: ReturnType<typeof setTimeout> | undefined;

async function allocateAllNow() {
  if (allocating.value) return;
  if (!window.confirm(t("admin.pages.pickingOrders.allocateAllConfirm"))) return;
  allocating.value = true;
  error.value = "";
  const startedAt = Date.now();
  try {
    await flow.allocateAll();
    await load();
    clearTimeout(allocDoneTimer);
    allocDoneMs.value = Date.now() - startedAt;
    allocDoneTimer = setTimeout(() => {
      allocDoneMs.value = 0;
    }, 8000);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    allocating.value = false;
  }
}

onBeforeUnmount(() => clearTimeout(allocDoneTimer));

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
        <button class="btn" :disabled="allocating" @click="allocateAllNow">
          {{ allocating ? $t("admin.common.saving") : $t("admin.pages.pickingOrders.allocateAll") }}
        </button>
        <NuxtLink to="/picking/reorder" class="btn">{{ $t("admin.pages.pickingOrders.reorderPriority") }}</NuxtLink>
      </div>
    </div>

    <div class="filters">
      <SearchableSelect
        v-model="status"
        :options="statusOptions"
        :all-label="$t('admin.common.allStatuses')"
        :aria-label="$t('admin.pages.pickingOrders.status')"
        :multiple="false"
      />
      <SearchableSelect
        v-model="orderTypes"
        :options="orderTypeOptions"
        :all-label="$t('admin.pages.pickingOrders.allTypes')"
        :aria-label="$t('admin.pages.pickingOrders.type')"
        class="filter-type"
      />
      <input v-model="search" :placeholder="$t('admin.pages.pickingOrders.searchPlaceholder')" />
      <UserScopeFilterButton @saved="load" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="allocDoneMs" class="alloc-done-banner">
      {{ $t("admin.pages.pickingOrders.allocationDoneIn", { ms: allocDoneMs }) }}
    </div>
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
      <template #cell-pickingOrderType="{ row }">{{ row.pickingOrderType ?? "" }}</template>
      <template #cell-prioritySeq="{ row }">
        <span class="muted">{{ row.prioritySeq }}</span>
      </template>
      <template #cell-deliveryDate="{ row }">
        {{ row.deliveryDate ? formatDate(row.deliveryDate) : "—" }}
      </template>
      <template #cell-pickedRatio="{ row }">{{ row.pickedQty }} / {{ row.totalQty }}</template>
      <template #cell-allocation="{ row }">
        {{ $t(`admin.pages.pickingOrders.allocationLabels.${row.allocationStatus}`) }}
        ({{ row.allocatedQty }} / {{ row.totalQty }})
      </template>
      <template #cell-workingByName="{ row }">{{ row.workingByName ?? "" }}</template>
      <template #cell-remark="{ row }">{{ row.remark ?? "" }}</template>
      <template #cell-createdDate="{ row }">{{ formatDateTime(row.createdDate) }}</template>
      <template #cell-lastUpdateDate="{ row }">{{ formatDateTime(row.lastUpdateDate) }}</template>
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
.filters input {
  flex: 1;
}
.filter-type {
  width: 180px;
}
.alloc-done-banner {
  margin-bottom: 12px;
  padding: 9px 12px;
  border-radius: 6px;
  font-size: 14px;
  background: #e9f7ef;
  border: 1px solid #b5e2c8;
  color: #1e7a46;
}
</style>
