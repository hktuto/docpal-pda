<script setup lang="ts">
const route = useRoute();
const code = route.params.code as string;
const api = useApi();

// The PDA-local supplier profile (one per supplierCode), or null when this
// supplier has none yet — saving then creates it.
const profile = ref<any | null>(null);
const loaded = ref(false);
const error = ref("");
const saveError = ref("");

async function load() {
  try {
    const profiles = await api.get("/admin/supplier-profiles");
    profile.value = profiles.find((p: any) => p.supplierCode === code) ?? null;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loaded.value = true;
  }
}

async function save(payload: Record<string, unknown>) {
  saveError.value = "";
  try {
    if (profile.value) {
      await api.patch(`/admin/supplier-profiles/${profile.value.id}`, payload);
    } else {
      await api.post("/admin/supplier-profiles", payload);
    }
    navigateTo("/suppliers");
  } catch (e: any) {
    saveError.value = e.message;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.supplierProfile.title", { code }) }}</h1>
      <div class="head-actions">
        <NuxtLink to="/suppliers" class="btn">{{ $t("admin.common.back") }}</NuxtLink>
      </div>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-else-if="!loaded" class="loading">{{ $t("admin.common.loading") }}</div>
    <SupplierProfileEditor
      v-else
      :supplier-code="code"
      :profile="profile"
      :server-error="saveError"
      @save="save"
      @cancel="navigateTo('/suppliers')"
    />
  </div>
</template>
