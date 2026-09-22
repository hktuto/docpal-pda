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
const selected = ref<Set<string>>(new Set());

const STATUSES = ["pending", "allocated", "skip", "picking", "finished", "issue", "shipped"];
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
    selected.value = new Set();
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

// Batch "Set status": one override per selected order (the API helper
// attempts every id and lists per-order failures on `failed`, same as the
// shipping batch). The modal is shared with the detail page.
const selectedIds = computed(() => [...selected.value]);
const selectedRows = computed(() => rows.value.filter((r) => selected.value.has(r.id)));
const overrideOpen = ref(false);
const overriding = ref(false);

async function onOverrideStatus(payload: { status: string; reason: string }) {
  const ids = selectedIds.value;
  if (ids.length === 0 || overriding.value) return;
  overriding.value = true;
  error.value = "";
  try {
    await flow.overridePickingOrdersStatus(ids, payload.status, payload.reason);
    overrideOpen.value = false;
    await load();
  } catch (e: any) {
    // Partial failure: failed lists the per-order failures.
    const failed: { id: string; message: string }[] = e?.failed ?? [];
    error.value =
      failed.length > 0
        ? t("admin.pages.pickingOrders.overrideFailed", {
            orders: failed.map((f) => rows.value.find((r) => r.id === f.id)?.orderNo ?? f.id).join(", "),
          })
        : e.message;
    await load();
  } finally {
    overriding.value = false;
  }
}

// Reload when picking data changes elsewhere (PDA picks, sync, allocation).
// Busy while a selection is active (load() clears it): banner instead of
// silent reload.
const changeBusy = computed(() => selected.value.size > 0);
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
  load,
  { busy: changeBusy }
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
        <button
          class="btn"
          :disabled="selectedIds.length === 0 || overriding"
          @click="overrideOpen = true"
        >
          {{
            selectedIds.length
              ? $t("admin.pages.pickingOrders.overrideStatusSelected", { n: selectedIds.length })
              : $t("admin.pages.pickingOrders.overrideStatus")
          }}
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
      v-model:selected="selected"
      :table="table"
      selectable
      :row-id="(r: PickingOrderRow) => r.id"
      :empty-text="$t('admin.pages.pickingOrders.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-orderNo="{ row }">
        <span class="clickable" @click="navigateTo(`/picking-orders/${row.id}`)">{{ row.orderNo }}</span>
      </template>
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
    <PickingOrdersStatusOverrideModal
      :open="overrideOpen"
      :order-nos="selectedRows.map((r) => r.orderNo)"
      :current-statuses="selectedRows.map((r) => r.status)"
      @close="overrideOpen = false"
      @apply="onOverrideStatus"
    />
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
}
.filter-type {
  width: 11.25rem;
}
.clickable {
  cursor: pointer;
  color: #0b5cab;
}
.alloc-done-banner {
  margin-bottom: 0.75rem;
  padding: 0.5625rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  background: #e9f7ef;
  border: 1px solid #b5e2c8;
  color: #1e7a46;
}
</style>
