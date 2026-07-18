<script setup lang="ts">
import { entities } from "~/utils/entities";

const api = useApi();

// Supplier profiles (one per supplierCode), edited inline from the suppliers table.
const profiles = ref<any[]>([]);
const showProfileForm = ref(false);
const profileInitial = ref<Record<string, any> | null>(null);
const profileError = ref("");
const currentSupplier = ref<any | null>(null);

const profileFields = entities["supplier-profiles"].fields.map((f) =>
  f.key === "supplierCode" ? { ...f, readonlyOnEdit: true } : f
);

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
  const existing = profileFor(row.code);
  profileInitial.value = existing
    ? { ...existing }
    : { supplierCode: row.code, name: "", qrTemplate: "", qtyEncoding: "", remark: "" };
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
    <CrudForm
      v-if="showProfileForm"
      :title="`Supplier profile — ${currentSupplier?.code ?? ''}`"
      :fields="profileFields"
      :initial="profileInitial"
      :server-error="profileError"
      @save="saveProfile"
      @cancel="showProfileForm = false"
    />
  </div>
</template>
