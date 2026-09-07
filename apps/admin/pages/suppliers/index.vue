<script setup lang="ts">
import { entities } from "~/utils/entities";

const api = useApi();

// Supplier profiles (one per supplierCode), edited on the detail page
// /suppliers/<code>; loaded here only for the row-action tooltip.
const profiles = ref<any[]>([]);

async function loadProfiles() {
  try {
    profiles.value = await api.get("/admin/supplier-profiles");
  } catch {
    profiles.value = [];
  }
}

function profileFor(supplierCode: string) {
  return profiles.value.find((p) => p.supplierCode === supplierCode);
}

onMounted(loadProfiles);
</script>

<template>
  <div>
    <CrudTable :config="entities.suppliers">
      <template #row-actions="{ row }">
        <button
          class="btn-link"
          :title="profileFor(row.code)?.qrTemplate || $t('admin.pages.suppliers.noProfileYet')"
          @click="navigateTo(`/suppliers/${encodeURIComponent(row.code)}`)"
        >
          {{ $t("admin.pages.suppliers.editProfile") }}
        </button>
      </template>
    </CrudTable>
  </div>
</template>
