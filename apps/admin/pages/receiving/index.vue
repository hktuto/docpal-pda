<script setup lang="ts">
import type { ReceivingOrderRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<ReceivingOrderRow[]>([]);
const loading = ref(false);
const error = ref("");
const status = ref("");
const search = ref("");
const selected = ref<Set<string>>(new Set());

const STATUSES = ["pending", "in_hand", "provisional_received", "clear"];

const statusOptions = computed<SearchableSelectOption[]>(() =>
  STATUSES.map((s) => ({ value: s, label: t(`status.receiving.${s}`) }))
);

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (r) =>
      r.batchNo.toLowerCase().includes(q) ||
      (r.supplierCode ?? "").toLowerCase().includes(q) ||
      (r.supplierName ?? "").toLowerCase().includes(q) ||
      (r.invoiceNos ?? "").toLowerCase().includes(q)
  );
});

// accessors resolve the derived display values used for sorting.
const columnDefs = computed<AdminColumnDef<ReceivingOrderRow>[]>(() => [
  {
    key: "batchNo",
    label: t("admin.pages.receiving.batchNo"),
    // Renders the configured display name (receivingOrderNameTemplate);
    // search above and sorting still use the raw batch_no / invoice fields.
    accessor: (r) => r.displayName ?? r.batchNo,
    size: 200,
  },
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
  {
    key: "invoiceNos",
    label: t("admin.pages.receiving.invoiceNos"),
    accessor: (r) => r.invoiceNos ?? "",
    size: 200,
  },
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
    selected.value = new Set();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(status, load);
onMounted(load);

// Batch "Set status": one override per selected order (the API helper
// attempts every id and lists per-order failures on `failed`, same as the
// picking batch). The modal is shared with the detail page.
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
    await flow.overrideReceivingOrdersStatus(ids, payload.status, payload.reason);
    overrideOpen.value = false;
    await load();
  } catch (e: any) {
    // Partial failure: failed lists the per-order failures.
    const failed: { id: string; message: string }[] = e?.failed ?? [];
    error.value =
      failed.length > 0
        ? t("admin.pages.receiving.overrideFailed", {
            orders: failed.map((f) => {
              const row = rows.value.find((r) => r.id === f.id);
              return row ? (row.displayName ?? row.batchNo) : f.id;
            }).join(", "),
          })
        : e.message;
    await load();
  } finally {
    overriding.value = false;
  }
}

// Reload when receiving data changes elsewhere (PDA scans, sync, confirms).
// Busy while a selection is active (load() clears it): banner instead of
// silent reload.
const changeBusy = computed(() => selected.value.size > 0);
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(["receiving_order.upserted", "receiving_order.deleted", "allocation.finished"], load, {
  busy: changeBusy,
});
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.receiving.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <button
          class="btn"
          :disabled="selectedIds.length === 0 || overriding"
          @click="overrideOpen = true"
        >
          {{
            selectedIds.length
              ? $t("admin.pages.receiving.overrideStatusSelected", { n: selectedIds.length })
              : $t("admin.pages.receiving.overrideStatus")
          }}
        </button>
      </div>
    </div>

    <div class="filters">
      <SearchableSelect
        v-model="status"
        :options="statusOptions"
        :all-label="$t('admin.common.allStatuses')"
        :aria-label="$t('admin.pages.receiving.status')"
        :multiple="false"
      />
      <input v-model="search" :placeholder="$t('admin.pages.receiving.searchPlaceholder')" />
      <UserScopeFilterButton @saved="load" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      v-model:selected="selected"
      :table="table"
      selectable
      :row-id="(r: ReceivingOrderRow) => r.id"
      :empty-text="$t('admin.pages.receiving.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-batchNo="{ row }">
        <span class="clickable" @click="navigateTo(`/receiving/${row.id}`)">{{ row.displayName ?? row.batchNo }}</span>
      </template>
      <template #cell-status="{ row }">{{ $t(`status.receiving.${row.status}`) }}</template>
      <template #cell-deliveryDate="{ row }">
        {{ row.deliveryDate ? formatDate(row.deliveryDate) : "—" }}
      </template>
      <template #cell-supplier="{ row }">{{ row.supplierName ?? row.supplierCode ?? "—" }}</template>
      <template #cell-createdDate="{ row }">{{ formatDateTime(row.createdDate) }}</template>
      <template #cell-lastUpdateDate="{ row }">{{ formatDateTime(row.lastUpdateDate) }}</template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
    <ReceivingStatusOverrideModal
      :open="overrideOpen"
      :order-nos="selectedRows.map((r) => r.displayName ?? r.batchNo)"
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
.head-actions {
  display: flex;
  gap: 0.625rem;
}
.clickable {
  cursor: pointer;
  color: #0b5cab;
}
</style>
