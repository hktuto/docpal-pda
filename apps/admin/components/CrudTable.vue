<script setup lang="ts">
import type { EntityConfig } from "~/utils/entities";
import type { AdminColumnDef } from "~/composables/useAdminTable";

const props = defineProps<{ config: EntityConfig }>();

const { t } = useI18n();
const api = useApi();
const rows = ref<any[]>([]);
const loading = ref(false);
const error = ref("");

// Client-side paging (default) vs server-side paging (config.serverPaging —
// large tables fetch { rows, total } page by page).
const serverMode = computed(() => !!props.config.serverPaging);

const q = ref("");
// Server mode only: extra query-param filters (config.filterFields).
const filterValues = reactive<Record<string, string>>({});
// Client mode only: dropdown exact-match filters (config.clientFilters).
const clientFilterValues = reactive<Record<string, string>>({});

/** Distinct non-empty values of a column across the loaded rows (dropdown options). */
function clientFilterOptions(key: string): string[] {
  return [...new Set(rows.value.map((r) => String(r[key] ?? "")).filter(Boolean))].sort();
}

// Column defs from the entity config: a synthetic pk (deriveId) is not a real
// column, and internal UUID pks ("id") are hidden — they carry no business
// meaning. extraColumns append after the form fields.
const columnDefs = computed<AdminColumnDef[]>(() => {
  const labels: Record<string, string> = {};
  labels[props.config.pk] = t(props.config.pk === "id" ? "admin.fields.id" : "admin.fields.code");
  for (const f of props.config.fields) labels[f.key] = t(f.label);
  const fieldKeys = props.config.fields.map((f) => f.key);
  const keys =
    props.config.pk === "id" || (props.config.deriveId && !fieldKeys.includes(props.config.pk))
      ? fieldKeys
      : [props.config.pk, ...fieldKeys];
  const sortable = props.config.sortable !== false;
  const cols: AdminColumnDef[] = [...new Set(keys)].map((key) => ({
    key,
    label: labels[key] ?? key,
    sortable,
  }));
  for (const extra of props.config.extraColumns ?? [])
    cols.push({ key: extra.key, label: t(extra.label), sortable: sortable && extra.sortable !== false });
  return cols;
});

// Client mode: clientSearch/clientFilters filtering happens before the table;
// sorting and paging are owned by the table itself.
const processed = computed(() => {
  let list = rows.value;
  if (!serverMode.value && props.config.clientSearch) {
    const needle = q.value.trim().toLowerCase();
    if (needle) {
      const keys = columnDefs.value.map((c) => c.key);
      list = list.filter((row) =>
        keys.some((k) =>
          String(row[k] ?? "")
            .toLowerCase()
            .includes(needle)
        )
      );
    }
  }
  if (!serverMode.value) {
    for (const f of props.config.clientFilters ?? []) {
      const v = clientFilterValues[f.key];
      if (v) list = list.filter((row) => String(row[f.key] ?? "") === v);
    }
  }
  return list;
});

const sTotal = ref(0);

const { table, sorting, pagination, resetColumnState } = useAdminTable({
  tableId: `crud-${props.config.path}`,
  columns: columnDefs,
  rows: processed,
  getRowId: rowId,
  server: serverMode.value ? { total: sTotal } : undefined,
  defaultPageSize: serverMode.value ? 50 : 20,
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
const total = computed(() => (serverMode.value ? sTotal.value : processed.value.length));

const showForm = ref(false);
const editing = ref<any | null>(null);
const saveError = ref("");

const showSearch = computed(
  () => serverMode.value || !!props.config.clientSearch || !!props.config.clientFilters?.length
);

const formTitle = computed(() =>
  editing.value
    ? t("admin.common.editTitle", { title: t(props.config.title) })
    : t("admin.common.newTitle", { title: t(props.config.title) })
);

/** Row identity for keys and /:id URLs; falls back to deriveId for composite-key rows. */
function rowId(row: any): string {
  return row[props.config.pk] ?? props.config.deriveId?.(row);
}

// Multi-row selection (config.selectable): the checkbox column lives in
// DataTable; the `bulk-actions` slot receives the selected rows.
const selected = ref<Set<string>>(new Set());
const selectedRows = computed(() => rows.value.filter((r) => selected.value.has(rowId(r))));

function clearSelection() {
  selected.value = new Set();
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    if (serverMode.value) {
      const params = new URLSearchParams({
        page: String(pagination.value.pageIndex + 1),
        pageSize: String(pagination.value.pageSize),
      });
      if (q.value.trim()) params.set("q", q.value.trim());
      const sort = sorting.value[0];
      if (sort) {
        params.set("sort", sort.id);
        params.set("dir", sort.desc ? "desc" : "asc");
      }
      for (const f of props.config.filterFields ?? []) {
        const v = (filterValues[f.param] ?? "").trim();
        if (v) params.set(f.param, v);
      }
      const res = await api.get(`/admin/${props.config.path}?${params}`);
      rows.value = res.rows;
      sTotal.value = res.total;
    } else {
      rows.value = await api.get(`/admin/${props.config.path}`);
    }
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

// Server mode: reload on page/page-size change, debounced reload on search.
watch(pagination, () => {
  if (serverMode.value) load();
});

function resetPageAndLoad() {
  if (pagination.value.pageIndex !== 0) {
    // The pagination watcher above performs the reload.
    pagination.value = { ...pagination.value, pageIndex: 0 };
  } else {
    load();
  }
}

let qTimer: ReturnType<typeof setTimeout> | undefined;
watch(q, () => {
  if (!serverMode.value) return;
  clearTimeout(qTimer);
  qTimer = setTimeout(resetPageAndLoad, 300);
});
watch(
  () => ({ ...filterValues }),
  () => {
    if (!serverMode.value) return;
    clearTimeout(qTimer);
    qTimer = setTimeout(resetPageAndLoad, 300);
  }
);
// Sort change: server mode reloads from page 1 (client mode is reactive).
watch(sorting, () => {
  if (!serverMode.value) return;
  resetPageAndLoad();
});

function startNew() {
  editing.value = null;
  saveError.value = "";
  showForm.value = true;
}

function startEdit(row: any) {
  editing.value = row;
  saveError.value = "";
  showForm.value = true;
}

async function onSave(payload: Record<string, unknown>) {
  saveError.value = "";
  try {
    if (editing.value) {
      await api.patch(`/admin/${props.config.path}/${rowId(editing.value)}`, payload);
    } else {
      await api.post(`/admin/${props.config.path}`, payload);
    }
    showForm.value = false;
    await load();
  } catch (e: any) {
    saveError.value = e.message;
  }
}

async function onDelete(row: any) {
  const pkVal = rowId(row);
  if (!confirm(t("admin.common.deleteConfirm", { id: pkVal }))) return;
  error.value = "";
  try {
    await api.del(`/admin/${props.config.path}/${pkVal}`);
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t(config.title) }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <button class="btn btn-primary" @click="startNew">{{ $t("admin.common.new") }}</button>
      </div>
    </div>
    <div v-if="showSearch" class="search-bar">
      <input
        v-model="q"
        type="search"
        class="search-input"
        :placeholder="$t('admin.common.searchPlaceholder', { entity: $t(config.title) })"
      />
      <input
        v-for="f in config.filterFields ?? []"
        :key="f.param"
        v-model="filterValues[f.param]"
        type="search"
        class="search-input filter-input"
        :placeholder="$t(f.label)"
      />
      <select
        v-for="f in config.clientFilters ?? []"
        :key="f.key"
        v-model="clientFilterValues[f.key]"
        class="search-input filter-input"
      >
        <option value="">{{ $t("admin.common.all") }} — {{ $t(f.label) }}</option>
        <option v-for="opt in clientFilterOptions(f.key)" :key="opt" :value="opt">{{ opt }}</option>
      </select>
    </div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="config.selectable && selected.size" class="bulk-bar">
      <span>{{ $t("admin.print.selectedCount", { count: selected.size }) }}</span>
      <slot name="bulk-actions" :rows="selectedRows" :clear="clearSelection" />
    </div>
    <div v-if="loading && rows.length === 0" class="loading">{{ $t("admin.common.loading") }}</div>
    <DataTable
      v-else
      v-model:selected="selected"
      :table="table"
      :selectable="config.selectable"
      :row-id="rowId"
      :loading="loading"
      :on-reset-columns="resetColumnState"
    >
      <template #actions="{ row }">
        <slot name="row-actions" :row="row" />
        <button v-if="!config.noEdit" class="btn-link" @click="startEdit(row)">
          {{ $t("admin.common.edit") }}
        </button>
        <button class="btn-link" @click="onDelete(row)">{{ $t("admin.common.delete") }}</button>
      </template>
    </DataTable>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
    <CrudForm
      v-if="showForm"
      :title="formTitle"
      :fields="config.fields"
      :initial="editing"
      :server-error="saveError"
      @save="onSave"
      @cancel="showForm = false"
    />
  </div>
</template>

<style scoped>
.filter-input {
  width: 200px;
  margin-left: 8px;
}
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 13px;
}
</style>
