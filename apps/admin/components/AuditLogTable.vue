<script setup lang="ts">
import type { OrderLogsPage, TransactionLogRow } from "~/utils/flowApi";
import type { AdminColumnDef } from "~/composables/useAdminTable";

// Shared audit-log table for the receiving / picking order detail pages.
// Server-paged: the parent passes a fetcher; page/search/sort state lives
// here and is sent to the backend. Bump `refreshKey` after mutations that
// write logs to reload. States render through the shared logStates.* labels
// with a raw fallback.

const props = defineProps<{
  fetchLogs: (params: { page: number; pageSize: number; q: string; sort: string; dir: "asc" | "desc" }) => Promise<OrderLogsPage>;
  refreshKey?: number;
}>();

const { t, te } = useI18n();

const rows = ref<TransactionLogRow[]>([]);
const total = ref(0);
const searchInput = ref("");
const q = ref("");
const loading = ref(false);

function stateLabel(code: string | null): string {
  if (!code) return t("logStates.none");
  return te(`logStates.${code}`) ? t(`logStates.${code}`) : code;
}

// Sorting is server-side; the `toState` column displays the full
// "from → to" transition but sorts on the destination state, as before.
const columnDefs = computed<AdminColumnDef<TransactionLogRow>[]>(() => [
  { key: "createdDate", label: t("admin.pages.auditLog.time"), size: 170 },
  {
    key: "actorName",
    label: t("admin.pages.auditLog.actor"),
    accessor: (log) => log.actorName ?? log.actorId ?? "",
    size: 150,
  },
  { key: "toState", label: t("admin.pages.auditLog.transition"), size: 210 },
  { key: "item", label: t("admin.pages.auditLog.item"), sortable: false, size: 160 },
  { key: "details", label: t("admin.pages.auditLog.details"), sortable: false, size: 240 },
]);

const { table, sorting, pagination, resetColumnState } = useAdminTable({
  tableId: "audit-log",
  columns: columnDefs,
  rows,
  getRowId: (log) => log.id,
  server: { total },
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

async function loadLogs() {
  loading.value = true;
  const sort = sorting.value[0];
  try {
    const res = await props.fetchLogs({
      page: page.value,
      pageSize: pageSize.value,
      q: q.value,
      sort: sort?.id ?? "createdDate",
      dir: sort ? (sort.desc ? "desc" : "asc") : "desc",
    });
    rows.value = res.rows;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

// Search applies debounced; sort changes apply immediately. Both reset to
// page 1 before refetching.
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(searchInput, (v) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    q.value = v.trim();
    page.value = 1;
  }, 300);
});
watch(sorting, () => {
  page.value = 1;
});
watch([page, pageSize, q, sorting, () => props.refreshKey], loadLogs, { immediate: true });

// Known metadata keys rendered compactly; field/from/to get a dedicated
// "field: from → to" rendering; anything else (incl. {}) renders nothing.
const META_KEYS = [
  "reason",
  "mismatchQty",
  "wrongPartNo",
  "note",
  "resolutionNote",
  "qty",
  "packSize",
  "partNo",
  "poNo",
  "poLine",
];

function metadataText(log: TransactionLogRow): string {
  const m = log.metadata ?? {};
  const parts: string[] = [];
  if (m.field) parts.push(`${m.field}: ${m.from ?? "—"} → ${m.to ?? "—"}`);
  for (const k of META_KEYS) {
    const v = m[k];
    if (v === null || v === undefined || v === "") continue;
    parts.push(`${k}: ${k === "reason" ? stateLabel(String(v)) : v}`);
  }
  return parts.join(" · ");
}

function itemText(log: TransactionLogRow): string {
  const m = log.metadata ?? {};
  const partNo = m.partNo;
  if (!partNo) return "—";
  return m.poLine ? `${partNo} / ${m.poLine}` : String(partNo);
}
</script>

<template>
  <h2 class="section-title">{{ t("admin.pages.auditLog.title") }}</h2>
  <div class="search-bar">
    <input
      v-model="searchInput"
      type="search"
      class="search-input"
      :placeholder="t('admin.pages.auditLog.searchPlaceholder')"
    />
  </div>
  <DataTable
    :table="table"
    :loading="loading"
    :empty-text="t('admin.pages.auditLog.empty')"
    :on-reset-columns="resetColumnState"
  >
    <template #cell-createdDate="{ row }">{{ new Date(row.createdDate).toLocaleString() }}</template>
    <template #cell-actorName="{ row }">{{ row.actorName ?? row.actorId ?? "—" }}</template>
    <template #cell-toState="{ row }">{{ stateLabel(row.fromState) }} → {{ stateLabel(row.toState) }}</template>
    <template #cell-item="{ row }">{{ itemText(row) }}</template>
    <template #cell-details="{ row }">{{ metadataText(row) }}</template>
  </DataTable>
  <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
</template>

<style scoped>
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
  color: #52606d;
}
.search-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}
</style>
