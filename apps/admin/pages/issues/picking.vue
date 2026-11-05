<script setup lang="ts">
import type { PickingOrderRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const flow = useFlowApi();
const { t } = useI18n();

// issue_* are plain picking_orders columns carried on the list rows
// (audit 2026-11-06 #8) — no per-order detail fetch.
type IssueRow = PickingOrderRow;

const rows = ref<IssueRow[]>([]);
const loading = ref(false);
const error = ref("");
const resolving = ref<Record<string, boolean>>({});

// accessors resolve the order-derived values used for sorting.
const columnDefs = computed<AdminColumnDef<IssueRow>[]>(() => [
  { key: "orderNo", label: t("admin.pages.issues.orderNo"), accessor: (r) => r.orderNo, size: 140 },
  {
    key: "customer",
    label: t("admin.pages.issues.customer"),
    accessor: (r) => r.customerCode ?? "",
    size: 150,
  },
  { key: "reason", label: t("admin.pages.issues.reason"), accessor: (r) => r.issueReason ?? "", size: 150 },
  { key: "qty", label: t("admin.pages.issues.qty"), accessor: (r) => r.issueQty ?? 0, size: 80 },
  {
    key: "packSize",
    label: t("admin.pages.issues.packSize"),
    accessor: (r) => r.issuePackSize ?? "",
    size: 100,
  },
  { key: "note", label: t("admin.pages.issues.note"), accessor: (r) => r.issueNote ?? "", size: 200 },
  {
    key: "reportedAt",
    label: t("admin.pages.issues.reportedAt"),
    accessor: (r) => r.issueReportedAt ?? "",
    size: 170,
  },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "issues-picking",
  columns: columnDefs,
  rows,
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
const total = computed(() => rows.value.length);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = (await flow.listPickingOrders({ status: ["issue"] })).rows;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// Resolve returns the order to pending and re-runs allocation; the underlying
// cause (stock, pack size, …) must be fixed before resolving.
async function resolve(row: IssueRow) {
  const note = window.prompt(t("admin.pages.issues.resolvePrompt"));
  if (note === null) return;
  resolving.value[row.id] = true;
  error.value = "";
  try {
    await flow.resolvePickingIssue(row.id, note);
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    delete resolving.value[row.id];
  }
}

onMounted(load);

// Reload when a picking issue is reported or the order changes elsewhere.
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(["picking_order.issue_reported", "picking_order.updated"], load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.issues.pickingTitle") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
      </div>
    </div>

    <p class="muted explainer">{{ $t("admin.pages.issues.pickingExplainer") }}</p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :empty-text="$t('admin.pages.issues.noPickingIssues')"
      :on-reset-columns="resetColumnState"
      @row-click="(r: IssueRow) => navigateTo(`/picking-orders/${r.id}`)"
    >
      <template #cell-customer="{ row }">{{ row.customerCode ?? "—" }}</template>
      <template #cell-reason="{ row }">{{ row.issueReason ?? "—" }}</template>
      <template #cell-qty="{ row }">{{ row.issueQty ?? "—" }}</template>
      <template #cell-packSize="{ row }">{{ row.issuePackSize ?? "—" }}</template>
      <template #cell-note="{ row }">{{ row.issueNote ?? "—" }}</template>
      <template #cell-reportedAt="{ row }">
        {{ row.issueReportedAt ? formatDateTime(row.issueReportedAt) : "—" }}
      </template>
      <template #actions="{ row }">
        <button
          class="btn btn-small btn-primary"
          :disabled="resolving[row.id]"
          @click="resolve(row)"
        >
          {{ resolving[row.id] ? $t("admin.common.saving") : $t("admin.pages.issues.resolve") }}
        </button>
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
.explainer {
  margin: 0 0 0.75rem;
}
</style>
