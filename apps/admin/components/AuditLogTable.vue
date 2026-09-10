<script setup lang="ts">
import type { OrderLogsPage, TransactionLogRow } from "~/utils/flowApi";

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
const page = ref(1);
const pageSize = ref(20);
const searchInput = ref("");
const q = ref("");
const loading = ref(false);

const { sortKey, sortDir, toggleSort } = useColumnSort();

async function loadLogs() {
  loading.value = true;
  try {
    const res = await props.fetchLogs({
      page: page.value,
      pageSize: pageSize.value,
      q: q.value,
      sort: sortKey.value ?? "createdDate",
      dir: sortKey.value ? sortDir.value : "desc",
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
watch([sortKey, sortDir], () => {
  page.value = 1;
});
watch([page, pageSize, q, sortKey, sortDir, () => props.refreshKey], loadLogs, { immediate: true });

function stateLabel(code: string | null): string {
  if (!code) return t("logStates.none");
  return te(`logStates.${code}`) ? t(`logStates.${code}`) : code;
}

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
  <div class="table-wrap">
    <table class="data">
      <thead>
        <tr>
          <th class="sortable" @click="toggleSort('createdDate')">
            {{ t("admin.pages.auditLog.time") }}
            <span v-if="sortKey === 'createdDate'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
          </th>
          <th class="sortable" @click="toggleSort('actorName')">
            {{ t("admin.pages.auditLog.actor") }}
            <span v-if="sortKey === 'actorName'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
          </th>
          <th class="sortable" @click="toggleSort('toState')">
            {{ t("admin.pages.auditLog.transition") }}
            <span v-if="sortKey === 'toState'" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
          </th>
          <th>{{ t("admin.pages.auditLog.item") }}</th>
          <th>{{ t("admin.pages.auditLog.details") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="log in rows" :key="log.id">
          <td>{{ new Date(log.createdDate).toLocaleString() }}</td>
          <td>{{ log.actorName ?? log.actorId ?? "—" }}</td>
          <td>{{ stateLabel(log.fromState) }} → {{ stateLabel(log.toState) }}</td>
          <td>{{ itemText(log) }}</td>
          <td>{{ metadataText(log) }}</td>
        </tr>
        <tr v-if="rows.length === 0 && !loading">
          <td colspan="5" class="muted">{{ t("admin.pages.auditLog.empty") }}</td>
        </tr>
      </tbody>
    </table>
  </div>
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
th.sortable {
  cursor: pointer;
  user-select: none;
}
th.sortable:hover {
  color: var(--brand-teal-dark);
}
.sort-arrow {
  font-size: 9px;
  margin-left: 3px;
}
</style>
