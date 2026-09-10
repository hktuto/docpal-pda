<script setup lang="ts">
import type { MismatchListRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const flow = useFlowApi();
const { t } = useI18n();
const rows = ref<MismatchListRow[]>([]);
const loading = ref(false);
const error = ref("");

// Per-row action in flight: itemId -> "confirm" | "cancel".
const acting = ref<Record<string, string>>({});

// accessors resolve the derived display values used for sorting.
const columnDefs = computed<AdminColumnDef<MismatchListRow>[]>(() => [
  { key: "batchNo", label: t("admin.pages.issues.batchNo"), size: 140 },
  { key: "invoiceNo", label: t("admin.pages.issues.invoiceNo"), size: 130 },
  {
    key: "partNo",
    label: t("admin.pages.issues.partNo"),
    accessor: (r) => r.wclItemNo ?? r.partNo,
    size: 130,
  },
  { key: "supplier", label: t("admin.pages.issues.supplier"), accessor: (r) => r.supplierCode ?? "", size: 150 },
  { key: "reason", label: t("admin.pages.issues.reason"), accessor: (r) => r.reason ?? "", size: 120 },
  { key: "qty", label: t("admin.pages.issues.qty"), accessor: (r) => r.mismatchQty ?? "", size: 80 },
  { key: "wrongPartNo", label: t("admin.pages.issues.wrongPartNo"), accessor: (r) => r.wrongPartNo ?? "", size: 130 },
  { key: "note", label: t("admin.pages.issues.note"), accessor: (r) => r.note ?? "", size: 200 },
]);

const { table, pagination, resetColumnState } = useAdminTable({
  tableId: "issues-receiving-mismatches",
  columns: columnDefs,
  rows,
  getRowId: (r) => r.itemId,
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
    rows.value = await flow.listReceivingMismatches();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// Confirm acknowledges the report (flag stays, audit log written); Cancel
// clears the mismatch, so the row disappears from this list.
async function act(row: MismatchListRow, action: "confirm" | "cancel") {
  acting.value[row.itemId] = action;
  error.value = "";
  try {
    if (action === "confirm") await flow.confirmReceivingMismatch(row.itemId);
    else await flow.cancelReceivingMismatch(row.itemId);
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    delete acting.value[row.itemId];
  }
}

onMounted(load);

// Reload when a receiving mismatch is reported or resolved elsewhere.
const {
  pending: changePending,
  justUpdated: changeUpdated,
  refreshNow,
  dismiss,
} = useChangeNotice(
  [
    "receiving.mismatch_reported",
    "receiving.mismatch_updated",
    "receiving.mismatch_confirmed",
    "receiving.mismatch_cancelled",
  ],
  load
);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.issues.receivingTitle") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
      </div>
    </div>

    <p class="muted explainer">{{ $t("admin.pages.issues.receivingExplainer") }}</p>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <ChangeNotice :pending="changePending" :just-updated="changeUpdated" @refresh="refreshNow" @dismiss="dismiss" />
    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

    <DataTable
      v-else
      :table="table"
      :empty-text="$t('admin.pages.issues.noReceivingIssues')"
      :on-reset-columns="resetColumnState"
      @row-click="(r) => navigateTo(`/receiving/${r.receivingOrderId}`)"
    >
      <template #cell-partNo="{ row }">{{ row.wclItemNo ?? row.partNo }}</template>
      <template #cell-supplier="{ row }">{{ row.supplierCode ?? "—" }}</template>
      <template #cell-reason="{ row }">{{ row.reason ?? "—" }}</template>
      <template #cell-qty="{ row }">{{ row.mismatchQty ?? "—" }}</template>
      <template #cell-wrongPartNo="{ row }">{{ row.wrongPartNo ?? "—" }}</template>
      <template #cell-note="{ row }">{{ row.note ?? "—" }}</template>
      <template #actions="{ row }">
        <button
          class="btn btn-small btn-primary"
          :disabled="!!acting[row.itemId]"
          @click="act(row, 'confirm')"
        >
          {{ acting[row.itemId] === "confirm" ? $t("admin.common.saving") : $t("admin.pages.issues.confirm") }}
        </button>
        <button class="btn btn-small" :disabled="!!acting[row.itemId]" @click="act(row, 'cancel')">
          {{ acting[row.itemId] === "cancel" ? $t("admin.common.saving") : $t("admin.common.cancel") }}
        </button>
      </template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 10px;
}
.explainer {
  margin: 0 0 12px;
}
:deep(td.actions) {
  white-space: nowrap;
}
:deep(td.actions .btn + .btn) {
  margin-left: 6px;
}
</style>
