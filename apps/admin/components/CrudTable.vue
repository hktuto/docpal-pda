<script setup lang="ts">
import type { EntityConfig } from "~/utils/entities";

const props = defineProps<{ config: EntityConfig }>();

const api = useApi();
const rows = ref<any[]>([]);
const loading = ref(false);
const error = ref("");

// Client-side paging (default) vs server-side paging (config.serverPaging —
// large tables fetch { rows, total } page by page).
const serverMode = computed(() => !!props.config.serverPaging);
const { page: cPage, pageSize: cPageSize, total: cTotal, paged: cPaged } = usePaging(rows);
const sPage = ref(1);
const sPageSize = ref(50);
const sTotal = ref(0);
const q = ref("");

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
  labels[props.config.pk] = props.config.pk === "id" ? "ID" : "Code";
  for (const f of props.config.fields) labels[f.key] = f.label;
  const fieldKeys = props.config.fields.map((f) => f.key);
  // A synthetic pk (deriveId) is not a real column — don't render it. Internal
  // UUID pks ("id") are hidden too: they carry no business meaning.
  const keys =
    props.config.pk === "id" || (props.config.deriveId && !fieldKeys.includes(props.config.pk))
      ? fieldKeys
      : [props.config.pk, ...fieldKeys];
  const cols = [...new Set(keys)].map((key) => ({ key, label: labels[key] ?? key }));
  for (const extra of props.config.extraColumns ?? []) cols.push(extra);
  return cols;
});

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
  if (!confirm(`Delete ${pkVal}?`)) return;
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
      <h1>{{ config.title }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">Refresh</button>
        <button class="btn btn-primary" @click="startNew">New</button>
      </div>
    </div>
    <div v-if="serverMode" class="search-bar">
      <input
        v-model="q"
        type="search"
        class="search-input"
        :placeholder="`Search ${config.title.toLowerCase()}…`"
      />
    </div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading && rows.length === 0" class="loading">Loading…</div>
    <div v-else class="table-wrap" :class="{ 'is-loading': loading }">
      <table class="data">
        <thead>
          <tr>
            <th v-for="c in columns" :key="c.key">{{ c.label }}</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in paged" :key="rowId(row)">
            <td v-for="c in columns" :key="c.key">{{ formatCell(row[c.key]) }}</td>
            <td class="actions">
              <slot name="row-actions" :row="row" />
              <button v-if="!config.noEdit" class="btn-link" @click="startEdit(row)">Edit</button>
              <button class="btn-link" @click="onDelete(row)">Delete</button>
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td :colspan="columns.length + 1" class="muted">No records.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <Pager v-model:page="page" v-model:page-size="pageSize" :total="total" />
    <CrudForm
      v-if="showForm"
      :title="editing ? `Edit ${config.title}` : `New ${config.title}`"
      :fields="config.fields"
      :initial="editing"
      :server-error="saveError"
      @save="onSave"
      @cancel="showForm = false"
    />
  </div>
</template>

<style scoped>
.search-bar {
  margin: 0 0 12px;
}
.search-input {
  width: 320px;
  max-width: 100%;
  padding: 8px 10px;
  border: 1px solid #b6c2cd;
  border-radius: 4px;
}
.table-wrap.is-loading {
  opacity: 0.5;
  pointer-events: none;
}
</style>
