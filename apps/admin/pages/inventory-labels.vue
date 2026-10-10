<script setup lang="ts">
// Inventory Labels admin page — custom form (InventoryLabelForm) with a
// single location dropdown, instead of the generic CrudTable/CrudForm.

const api = useApi();
const { t } = useI18n();

interface LabelRow {
  id: string;
  orgId: number;
  subInventoryCode: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  remark: string | null;
}

interface LocationOption {
  orgId: number;
  secondaryInventoryName: string;
  subinvDescription: string | null;
  officeCode: string | null;
}

const labels = ref<LabelRow[]>([]);
const locationOptions = ref<LocationOption[]>([]);
const loading = ref(true);
const loadError = ref("");
const saving = ref(false);
const saveError = ref("");
const showForm = ref(false);
const editingRow = ref<LabelRow | null>(null);

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const [labelRows, locRows] = await Promise.all([
      api.get<LabelRow[]>("/admin/inventory-labels"),
      api.get<LocationOption[]>("/admin/sub-inventories"),
    ]);
    labels.value = labelRows;
    locationOptions.value = locRows;
  } catch (e: any) {
    loadError.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function startNew() {
  editingRow.value = null;
  saveError.value = "";
  showForm.value = true;
}

function startEdit(row: LabelRow) {
  editingRow.value = row;
  saveError.value = "";
  showForm.value = true;
}

async function onSave(payload: { orgId: number; subInventoryCode: string; label: string; sortOrder: number; isActive: boolean; remark: string | null }) {
  saving.value = true;
  saveError.value = "";
  try {
    if (editingRow.value) {
      await api.patch(`/admin/inventory-labels/${editingRow.value.id}`, payload);
    } else {
      await api.post("/admin/inventory-labels", payload);
    }
    showForm.value = false;
    await load();
  } catch (e: any) {
    saveError.value = e?.message ?? String(e);
  } finally {
    saving.value = false;
  }
}

async function onDelete(row: LabelRow) {
  if (!confirm(t("admin.common.deleteConfirm", { id: `${row.orgId}:${row.subInventoryCode}` }))) return;
  loadError.value = "";
  try {
    await api.del(`/admin/inventory-labels/${row.id}`);
    await load();
  } catch (e: any) {
    loadError.value = e?.message ?? String(e);
  }
}

function formatActive(value: unknown): string {
  return value ? "✔" : "✘";
}
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.entities.inventoryLabels.title") }}</h1>
      <div class="head-actions">
        <button class="btn" :disabled="loading" @click="load">{{ $t("admin.common.refresh") }}</button>
        <button class="btn btn-primary" @click="startNew">{{ $t("admin.common.new") }}</button>
      </div>
    </div>
    <div v-if="loadError" class="error-banner">{{ loadError }}</div>
    <div v-if="loading && labels.length === 0" class="loading">{{ $t("admin.common.loading") }}</div>
    <template v-else>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("admin.fields.orgId") }}</th>
              <th>{{ $t("admin.fields.subInventoryCode") }}</th>
              <th>{{ $t("admin.fields.label") }}</th>
              <th>{{ $t("admin.fields.sortOrder") }}</th>
              <th>{{ $t("admin.fields.isActive") }}</th>
              <th>{{ $t("admin.fields.remark") }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in labels" :key="row.id">
              <td>{{ row.orgId }}</td>
              <td>{{ row.subInventoryCode }}</td>
              <td>{{ row.label }}</td>
              <td>{{ row.sortOrder }}</td>
              <td>{{ formatActive(row.isActive) }}</td>
              <td>{{ row.remark ?? "—" }}</td>
              <td class="actions-cell">
                <button class="btn-link" @click="startEdit(row)">{{ $t("admin.common.edit") }}</button>
                <button class="btn-link" @click="onDelete(row)">{{ $t("admin.common.delete") }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <InventoryLabelForm
        v-if="showForm"
        :title="editingRow ? $t('admin.common.editTitle', { title: $t('admin.entities.inventoryLabels.title') }) : $t('admin.common.newTitle', { title: $t('admin.entities.inventoryLabels.title') })"
        :location-options="locationOptions"
        :initial="editingRow"
        :server-error="saveError"
        @save="onSave"
        @cancel="showForm = false"
      />
    </template>
  </div>
</template>

<style scoped>
.table-wrap {
  overflow-x: auto;
}
.data {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.data th,
.data td {
  text-align: left;
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid #e2e8f0;
}
.data th {
  font-weight: 600;
  color: #475569;
  background: #f8fafc;
}
.actions-cell {
  white-space: nowrap;
}
.btn-link {
  background: none;
  border: none;
  color: #2563eb;
  cursor: pointer;
  font-size: 0.875rem;
  padding: 0;
  margin-right: 0.75rem;
}
.btn-link:hover {
  text-decoration: underline;
}
.error-banner {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #dc2626;
  padding: 0.5rem 0.75rem;
  border-radius: 0.25rem;
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}
.loading {
  padding: 1rem;
  color: #64748b;
}
</style>