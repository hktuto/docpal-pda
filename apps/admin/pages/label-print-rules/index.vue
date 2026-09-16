<script setup lang="ts">
import { entities } from "~/utils/entities";

// Label print rules: which print template to use per label type, matched by
// a flat AND/OR condition list. Standard CRUD via CrudTable plus a per-row
// Activate/Deactivate toggle (PATCH { active }).
const api = useApi();
const table = ref<{ reload: () => Promise<void> } | null>(null);
const error = ref("");

async function toggleActive(row: any) {
  error.value = "";
  try {
    await api.patch(`/admin/label-print-rules/${row.id}`, { active: !row.active });
    await table.value?.reload();
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>

<template>
  <div>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <CrudTable ref="table" :config="entities.labelPrintRules">
      <template #row-actions="{ row }">
        <NuxtLink :to="`/label-print-rules/${row.id}`" class="btn-link">{{ $t("admin.common.edit") }}</NuxtLink>
        <button class="btn-link" @click="toggleActive(row)">
          {{ row.active ? $t("admin.pages.labelPrintRules.deactivate") : $t("admin.pages.labelPrintRules.activate") }}
        </button>
      </template>
    </CrudTable>
  </div>
</template>
