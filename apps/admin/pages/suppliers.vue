<script setup lang="ts">
import { entities } from "~/utils/entities";

const api = useApi();

// Supplier profiles (one per supplierCode), edited via the QR-template editor dialog.
const profiles = ref<any[]>([]);
const showProfileForm = ref(false);
const profileError = ref("");
const currentSupplier = ref<any | null>(null);
const currentProfile = ref<any | null>(null);

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

function editProfile(row: any) {
  currentSupplier.value = row;
  currentProfile.value = profileFor(row.code) ?? null;
  profileError.value = "";
  showProfileForm.value = true;
}

async function saveProfile(payload: Record<string, unknown>) {
  profileError.value = "";
  try {
    const existing = profileFor(currentSupplier.value.code);
    if (existing) {
      await api.patch(`/admin/supplier-profiles/${existing.id}`, payload);
    } else {
      await api.post("/admin/supplier-profiles", payload);
    }
    showProfileForm.value = false;
    await loadProfiles();
  } catch (e: any) {
    profileError.value = e.message;
  }
}

onMounted(loadProfiles);
</script>

<template>
  <div>
    <CrudTable :config="entities.suppliers">
      <template #row-actions="{ row }">
        <button
          class="btn-link"
          :title="profileFor(row.code)?.qrTemplate || 'No profile yet'"
          @click="editProfile(row)"
        >
          Edit profile
        </button>
      </template>
    </CrudTable>
    <QrTemplateEditorDialog
      v-if="showProfileForm"
      :supplier-code="currentSupplier?.code ?? ''"
      :profile="currentProfile"
      :server-error="profileError"
      @save="saveProfile"
      @cancel="showProfileForm = false"
    />
  </div>
</template>
