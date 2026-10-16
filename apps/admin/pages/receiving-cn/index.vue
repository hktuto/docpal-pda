<script setup lang="ts">
import type { CnWorkflowRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<CnWorkflowRow[]>([]);
const loading = ref(false);
const error = ref("");
const status = ref("");

const STATUSES = ["workflow_running", "completed", "failed", "cancelled"];

const statusOptions = computed<SearchableSelectOption[]>(() =>
  STATUSES.map((s) => ({ value: s, label: t(`admin.pages.receivingCn.statuses.${s}`) }))
);

const columnDefs = computed<AdminColumnDef<CnWorkflowRow>[]>(() => [
  { key: "invoiceNo", label: t("admin.pages.receivingCn.invoiceNo"), size: 160 },
  { key: "supplier", label: t("admin.pages.receivingCn.supplier"), size: 140 },
  { key: "phase", label: t("admin.pages.receivingCn.phase"), size: 90 },
  { key: "status", label: t("admin.pages.receivingCn.status"), size: 150 },
  {
    key: "docpalBusinessKey",
    label: t("admin.pages.receivingCn.businessKey"),
    accessor: (r) => r.docpalBusinessKey ?? "",
    size: 180,
  },
  { key: "filename", label: t("admin.pages.receivingCn.filename"), size: 200 },
  { key: "createdBy", label: t("admin.pages.receivingCn.createdBy"), size: 120 },
  { key: "createdDate", label: t("admin.fields.createdDate"), size: 170 },
]);

// Server mode: paging/filtering are driven by query-param reloads.
const total = ref(0);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "receiving-cn",
  columns: columnDefs,
  rows,
  getRowId: (r) => r.id,
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

// URL query params keep filter/pagination across navigation.
useUrlQueryState({
  status: { state: status, defaultValue: "" },
  page: { state: page, defaultValue: 1, parse: parsePositiveInt(1) },
  pageSize: { state: pageSize, defaultValue: 50, parse: parsePositiveInt(50) },
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const res = await flow.listCnWorkflows({
      status: status.value || undefined,
      page: pagination.value.pageIndex + 1,
      pageSize: pagination.value.pageSize,
    });
    rows.value = res.rows;
    total.value = res.total;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(pagination, load);

// Filter changes reload from page 1.
function resetPageAndLoad() {
  if (pagination.value.pageIndex !== 0) {
    pagination.value = { ...pagination.value, pageIndex: 0 };
  } else {
    load();
  }
}

watch(status, resetPageAndLoad);

onMounted(load);

// Reload when a workflow the cron tracks reaches a terminal state (SSE).
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(["receiving_cn.completed", "receiving_cn.failed", "receiving_cn.cancelled"], load);

function statusClass(s: string): string {
  return {
    workflow_running: "chip chip-info",
    completed: "chip chip-ok",
    failed: "chip chip-err",
    cancelled: "chip chip-muted",
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
      <SearchableSelect
        v-model="status"
        :options="statusOptions"
        :all-label="$t('admin.common.allStatuses')"
        :aria-label="$t('admin.pages.receivingCn.status')"
        :multiple="false"
      />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :empty-text="$t('admin.pages.receivingCn.none')"
      :on-reset-columns="resetColumnState"
    >
      <template #cell-invoiceNo="{ row }">{{ row.invoiceNo }}</template>
      <template #cell-supplier="{ row }">{{ row.supplier || "—" }}</template>
      <template #cell-phase="{ row }">{{ $t(`admin.pages.receivingCn.phases.${row.phase}`) }}</template>
      <template #cell-status="{ row }">
        <span :class="statusClass(row.status)">{{ $t(`admin.pages.receivingCn.statuses.${row.status}`) }}</span>
      </template>
      <template #cell-docpalBusinessKey="{ row }">{{ row.docpalBusinessKey ?? "—" }}</template>
      <template #cell-filename="{ row }">{{ row.filename }}</template>
      <template #cell-createdBy="{ row }">{{ row.createdBy }}</template>
      <template #cell-createdDate="{ row }">{{ formatDateTime(row.createdDate) }}</template>
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
.head-actions {
  display: flex;
  gap: 0.625rem;
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
.chip-err {
  background: #fee2e2;
  color: #b91c1c;
}
.chip-muted {
  background: #e5e7eb;
  color: #52606d;
}
</style>
