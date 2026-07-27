<script setup lang="ts">
import type { EntityConfig } from "~/utils/entities";

const props = defineProps<{ config: EntityConfig }>();

const { t } = useI18n();
const api = useApi();
const rows = ref<any[]>([]);
const loading = ref(false);
const error = ref("");

// Client-side paging (default) vs server-side paging (config.serverPaging —
// large tables fetch { rows, total } page by page).
const serverMode = computed(() => !!props.config.serverPaging);

// Column sorting (none → asc → desc → none). Client mode sorts in memory;
// server mode sends sort/dir params and reloads.
const { sortKey, sortDir, toggleSort, sortRows } = useColumnSort();

const q = ref("");
// Server mode only: extra query-param filters (config.filterFields).
const filterValues = reactive<Record<string, string>>({});

// Client mode: sort + optional clientSearch filter happen before paging.
const processed = computed(() => {
  let list = sortRows(rows.value);
  if (!serverMode.value && props.config.clientSearch) {
    const needle = q.value.trim().toLowerCase();
    if (needle) {
      const keys = columns.value.map((c) => c.key);
      list = list.filter((row) =>
        keys.some((k) =>
          String(row[k] ?? "")
            .toLowerCase()
            .includes(needle)
        )
      );
    }
  }
  return list;
});

const { page: cPage, pageSize: cPageSize, total: cTotal, paged: cPaged } = usePaging(processed);
const sPage = ref(1);
const sPageSize = ref(50);
const sTotal = ref(0);

const page = computed({
  get: () => (serverMode.value ? sPage.value : cPage.value),
  set: (v: number) => {
    if (serverMode.value) sPage.value = v;
    else cPage.value = v;
  },
});
const pageSize = computed({
  get: () => (serverMode.value ? sPageSize.value : cPageSize.value),
  set: (v: number) => {
    if (serverMode.value) {
      sPageSize.value = v;
      sPage.value = 1;
    } else {
      cPageSize.value = v;
    }
  },
});
const total = computed(() => (serverMode.value ? sTotal.value : cTotal.value));
const paged = computed(() => (serverMode.value ? rows.value : cPaged.value));

const showForm = ref(false);
const editing = ref<any | null>(null);
const saveError = ref("");

const columns = computed(() => {
  const labels: Record<string, string> = {};
  labels[props.config.pk] = t(props.config.pk === "id" ? "admin.fields.id" : "admin.fields.code");
  for (const f of props.config.fields) labels[f.key] = t(f.label);
  const fieldKeys = props.config.fields.map((f) => f.key);
  // A synthetic pk (deriveId) is not a real column — don't render it. Internal
  // UUID pks ("id") are hidden too: they carry no business meaning.
  const keys =
    props.config.pk === "id" || (props.config.deriveId && !fieldKeys.includes(props.config.pk))
      ? fieldKeys
      : [props.config.pk, ...fieldKeys];
  const cols = [...new Set(keys)].map((key) => ({ key, label: labels[key] ?? key, sortable: true }));
  for (const extra of props.config.extraColumns ?? [])
    cols.push({ key: extra.key, label: t(extra.label), sortable: extra.sortable !== false });
  return cols;
});

const showSearch = computed(() => serverMode.value || !!props.config.clientSearch);

function canSort(c: { key: string; sortable?: boolean }): boolean {
  return props.config.sortable !== false && c.sortable !== false;
}

const formTitle = computed(() =>
  editing.value
    ? t("admin.common.editTitle", { title: t(props.config.title) })
    : t("admin.common.newTitle", { title: t(props.config.title) })
);

/** Row identity for keys and /:id URLs; falls back to deriveId for composite-key rows. */
function rowId(row: any): string {
  return row[props.config.pk] ?? props.config.deriveId?.(row);
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    if (serverMode.value) {
      const params = new URLSearchParams({
        page: String(sPage.value),
        pageSize: String(sPageSize.value),
      });
      if (q.value.trim()) params.set("q", q.value.trim());
      if (sortKey.value) {
        params.set("sort", sortKey.value);
        params.set("dir", sortDir.value);
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
watch([sPage, sPageSize], () => {
  if (serverMode.value) load();
});
let qTimer: ReturnType<typeof setTimeout> | undefined;
watch(q, () => {
  if (!serverMode.value) return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    sPage.value = 1;
    load();
  }, 300);
});
watch(
  () => ({ ...filterValues }),
  () => {
    if (!serverMode.value) return;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      sPage.value = 1;
      load();
    }, 300);
  }
);
// Sort change: server mode reloads from page 1 (client mode is reactive).
watch([sortKey, sortDir], () => {
  if (!serverMode.value) return;
  sPage.value = 1;
  load();
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
    </div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading && rows.length === 0" class="loading">{{ $t("admin.common.loading") }}</div>
    <div v-else class="table-wrap" :class="{ 'is-loading': loading }">
      <table class="data">
        <thead>
          <tr>
            <th
              v-for="c in columns"
              :key="c.key"
              :class="{ sortable: canSort(c), sorted: sortKey === c.key }"
              @click="canSort(c) && toggleSort(c.key)"
            >
              {{ c.label }}
              <span v-if="sortKey === c.key" class="sort-arrow">{{ sortDir === "asc" ? "▲" : "▼" }}</span>
            </th>
            <th>{{ $t("admin.common.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in paged" :key="rowId(row)">
            <td v-for="c in columns" :key="c.key">{{ formatCell(row[c.key]) }}</td>
            <td class="actions">
              <slot name="row-actions" :row="row" />
              <button v-if="!config.noEdit" class="btn-link" @click="startEdit(row)">
                {{ $t("admin.common.edit") }}
              </button>
              <button class="btn-link" @click="onDelete(row)">{{ $t("admin.common.delete") }}</button>
            </td>
          </tr>
          <tr v-if="paged.length === 0">
            <td :colspan="columns.length + 1" class="muted">{{ $t("admin.common.noRecords") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
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
.table-wrap.is-loading {
  opacity: 0.5;
  pointer-events: none;
}
</style>
