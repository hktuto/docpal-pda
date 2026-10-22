<script setup lang="ts">
import type { CnOrderRow, CnPendingRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

// CN receiving orders (synced receiving_orders_cn rows), with uploads whose
// DocPal workflow is still running merged on top as non-clickable pending
// rows. Order rows drill into /receiving-cn/:batchNo.

type CnMergedRow = CnOrderRow | CnPendingRow;

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<CnMergedRow[]>([]);
const loading = ref(false);
const error = ref("");
const search = ref("");

const columnDefs = computed<AdminColumnDef<CnMergedRow>[]>(() => [
  { key: "batchNo", label: t("admin.pages.receivingCn.batchNo"), size: 160 },
  { key: "invoiceNo", label: t("admin.pages.receivingCn.invoiceNo"), size: 160 },
  { key: "supplier", label: t("admin.pages.receivingCn.supplier"), size: 140 },
  {
    key: "deliveryDate",
    label: t("admin.pages.receivingCn.deliveryDate"),
    accessor: (r) => (r.kind === "order" ? r.deliveryDate : null),
    size: 120,
  },
  { key: "status", label: t("admin.pages.receivingCn.status"), size: 130 },
  { key: "putAwayStatus", label: t("admin.pages.receivingCn.putAwayStatus"), size: 110 },
  { key: "createdDate", label: t("admin.fields.createdDate"), size: 170 },
]);

// Server mode: paging is driven by query-param reloads. `total` counts order
// rows only — pending rows are merged in extra.
const total = ref(0);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "receiving-cn-orders",
  columns: columnDefs,
  rows,
  getRowId: (r) => (r.kind === "order" ? `o:${r.batchNo}` : `p:${r.batchNo}`),
  server: { total },
  defaultPageSize: 50,
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

// URL query params keep search/pagination across navigation.
useUrlQueryState({
  search: { state: search, defaultValue: "" },
  page: { state: page, defaultValue: 1, parse: parsePositiveInt(1) },
  pageSize: { state: pageSize, defaultValue: 50, parse: parsePositiveInt(50) },
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await flow.listCnOrders({
      search: search.value.trim() || undefined,
      page: pagination.value.pageIndex + 1,
      pageSize: pagination.value.pageSize,
    });
    rows.value = [...res.pending, ...res.rows];
    total.value = res.total;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(pagination, load);

// Search/filter changes reload from page 1 (300 ms debounce, same as the
// standard receiving list).
function resetPageAndLoad() {
  if (pagination.value.pageIndex !== 0) {
    pagination.value = { ...pagination.value, pageIndex: 0 };
  } else {
    load();
  }
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(resetPageAndLoad, 300);
});

onMounted(load);

// Reload when a workflow the cron tracks reaches a terminal state (SSE) —
// the completed upload flips from a pending row into an order row.
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(["receiving_cn.completed", "receiving_cn.failed", "receiving_cn.cancelled"], load);

function orderStatusClass(s: string): string {
  return {
    pending: "chip chip-muted",
    in_hand: "chip chip-info",
    clear: "chip chip-ok",
  }[s] ?? "chip";
}

function putAwayStatusClass(s: string): string {
  return {
    pending: "chip chip-info",
    completed: "chip chip-ok",
  }[s] ?? "chip";
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.receivingCn.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <button class="btn btn-primary" @click="navigateTo('/receiving-cn/new')">
          {{ $t("admin.pages.receivingCn.newUpload") }}
        </button>
      </div>
    </div>

    <div class="filters">
      <input v-model="search" :placeholder="$t('admin.pages.receivingCn.searchPlaceholder')" />
    </div>

    <p v-if="rows.some((r) => r.kind === 'pending')" class="hint-text">
      {{ $t("admin.pages.receivingCn.pendingHint") }}
    </p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :empty-text="$t('admin.pages.receivingCn.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-batchNo="{ row }">
        <span
          v-if="row.kind === 'order'"
          class="clickable"
          @click="navigateTo(`/receiving-cn/${encodeURIComponent(row.batchNo)}`)"
        >{{ row.batchNo }}</span>
        <span v-else class="pending-batch">{{ row.batchNo }}</span>
      </template>
      <template #cell-invoiceNo="{ row }">
        <span :class="{ 'pending-text': row.kind === 'pending' }">{{ row.invoiceNo }}</span>
      </template>
      <template #cell-supplier="{ row }">
        <span :class="{ 'pending-text': row.kind === 'pending' }">{{ row.supplier || "—" }}</span>
      </template>
      <template #cell-deliveryDate="{ row }">
        <span :class="{ 'pending-text': row.kind === 'pending' }">
          {{ row.kind === "order" && row.deliveryDate ? formatDate(row.deliveryDate) : "—" }}
        </span>
      </template>
      <template #cell-status="{ row }">
        <span v-if="row.kind === 'pending'" class="chip chip-processing">
          {{ $t("admin.pages.receivingCn.statuses.processing") }}
        </span>
        <span v-else :class="orderStatusClass(row.status)">{{ $t(`status.receiving.${row.status}`) }}</span>
      </template>
      <template #cell-putAwayStatus="{ row }">
        <span v-if="row.kind === 'pending'" class="pending-text">—</span>
        <span v-else-if="row.putAwayStatus" :class="putAwayStatusClass(row.putAwayStatus)">
          {{ $t(`status.putAway.${row.putAwayStatus}`) }}
        </span>
        <span v-else>—</span>
      </template>
      <template #cell-createdDate="{ row }">
        <span :class="{ 'pending-text': row.kind === 'pending' }">{{ formatDateTime(row.createdDate) }}</span>
      </template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 0.625rem;
}
.filters {
  display: flex;
  gap: 0.625rem;
  margin-bottom: 0.75rem;
}
.filters input {
  flex: 1;
  max-width: 24rem;
}
.hint-text {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  color: var(--muted, #666);
}
.clickable {
  cursor: pointer;
  color: #0b5cab;
}
.pending-batch,
.pending-text {
  color: #9aa5b1;
}
.chip {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  white-space: nowrap;
}
.chip-info {
  background: #dbeafe;
  color: #1d4ed8;
}
.chip-ok {
  background: #dcfce7;
  color: #15803d;
}
.chip-muted {
  background: #e5e7eb;
  color: #52606d;
}
.chip-processing {
  background: #fef3c7;
  color: #b45309;
}
</style>
