<script setup lang="ts">
import type { EntityConfig } from "~/utils/entities";

const props = defineProps<{ config: EntityConfig }>();

const api = useApi();
const rows = ref<any[]>([]);
const loading = ref(false);
const error = ref("");

const showForm = ref(false);
const editing = ref<any | null>(null);
const saveError = ref("");

const columns = computed(() => {
  const labels: Record<string, string> = {};
  labels[props.config.pk] = props.config.pk === "id" ? "ID" : "Code";
  for (const f of props.config.fields) labels[f.key] = f.label;
  const fieldKeys = props.config.fields.map((f) => f.key);
  // A synthetic pk (deriveId) is not a real column — don't render it.
  const keys = props.config.deriveId && !fieldKeys.includes(props.config.pk)
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
    rows.value = await api.get(`/admin/${props.config.path}`);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

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
      <button class="btn btn-primary" @click="startNew">New</button>
    </div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">Loading…</div>
    <div v-else class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th v-for="c in columns" :key="c.key">{{ c.label }}</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="rowId(row)">
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
