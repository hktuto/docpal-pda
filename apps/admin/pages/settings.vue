<script setup lang="ts">
import type { SubInventoryScope } from "~/utils/userScope";

// Personal settings (spec 2026-09-11-user-subinventory-scope-design.md): the
// logged-in user's own sub-inventory scope, via /auth/me/profile. Linked from
// the user popover in app.vue.

interface MeProfile {
  username: string;
  subInventoryScopes: SubInventoryScope[];
}

const api = useApi();

const scopes = ref<SubInventoryScope[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const saved = ref(false);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const profile = await api.get<MeProfile>("/auth/me/profile");
    scopes.value = profile.subInventoryScopes ?? [];
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    const profile = await api.put<MeProfile>("/auth/me/profile", { subInventoryScopes: scopes.value });
    scopes.value = profile.subInventoryScopes ?? [];
    saved.value = true;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.settings.title") }}</h1>
    </div>

    <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>
    <template v-else>
      <h2 class="section-head">{{ $t("admin.pages.settings.scopeSection") }}</h2>
      <p class="muted explainer">{{ $t("admin.pages.settings.scopeExplainer") }}</p>

      <div class="scope-card">
        <SubInventoryScopePicker v-model="scopes" />
      </div>

      <div v-if="error" class="error-banner">{{ error }}</div>
      <div v-if="saved" class="success-banner">{{ $t("admin.common.saved") }}</div>

      <div class="actions">
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.section-head {
  margin: 0 0 8px;
  font-size: 16px;
}

.explainer {
  margin: 0 0 12px;
  font-size: 13px;
}

.scope-card {
  max-width: 560px;
  margin-bottom: 12px;
}

.actions {
  margin-top: 12px;
}

.success-banner {
  max-width: 560px;
  padding: 8px 12px;
  border: 1px solid #86c8a0;
  border-radius: 6px;
  background: #ecf9f1;
  color: #1e7a46;
  font-size: 13px;
}
</style>
