<script setup lang="ts">
import type { SubInventoryScope } from "~/utils/userScope";

// Personal settings (spec 2026-09-11-user-subinventory-scope-design.md,
// 2026-09-16-admin-date-format-setting-design.md): the logged-in user's own
// sub-inventory scope and date format preferences, via /auth/me/profile.
// Linked from the user popover in app.vue.

interface MeProfile {
  username: string;
  subInventoryScopes: SubInventoryScope[];
  dateFormat?: string;
  dateTimeFormat?: string;
}

const api = useApi();

const scopes = ref<SubInventoryScope[]>([]);
const dateFormat = ref(DEFAULT_DATE_FORMAT);
const dateTimeFormat = ref(DEFAULT_DATE_TIME_FORMAT);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const saved = ref(false);

const DATE_PRESETS = ["dd/MMM/yyyy", "yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy"];
const DATE_TIME_PRESETS = ["dd/MMM/yyyy HH:mm", "dd/MMM/yyyy hh:mm a", "yyyy-MM-dd HH:mm"];

// Keep the stored value selectable even when it is not one of the presets.
const datePresets = computed(() =>
  DATE_PRESETS.includes(dateFormat.value) ? DATE_PRESETS : [dateFormat.value, ...DATE_PRESETS]
);
const dateTimePresets = computed(() =>
  DATE_TIME_PRESETS.includes(dateTimeFormat.value)
    ? DATE_TIME_PRESETS
    : [dateTimeFormat.value, ...DATE_TIME_PRESETS]
);

function preview(pattern: string): string {
  return formatWithPattern(new Date(), pattern);
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const profile = await api.get<MeProfile>("/auth/me/profile");
    scopes.value = profile.subInventoryScopes ?? [];
    dateFormat.value = profile.dateFormat || DEFAULT_DATE_FORMAT;
    dateTimeFormat.value = profile.dateTimeFormat || DEFAULT_DATE_TIME_FORMAT;
    applyDatePreferences(profile);
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
    const profile = await api.put<MeProfile>("/auth/me/profile", {
      subInventoryScopes: scopes.value,
      dateFormat: dateFormat.value,
      dateTimeFormat: dateTimeFormat.value,
    });
    scopes.value = profile.subInventoryScopes ?? [];
    applyDatePreferences(profile);
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
      <h2 class="section-head">{{ $t("admin.pages.settings.dateSection") }}</h2>
      <p class="muted explainer">{{ $t("admin.pages.settings.dateExplainer") }}</p>

      <div class="scope-card">
        <label class="field">
          <span>{{ $t("admin.pages.settings.dateFormat") }}</span>
          <select v-model="dateFormat">
            <option v-for="p in datePresets" :key="p" :value="p">{{ p }}</option>
          </select>
          <span class="muted">{{ $t("admin.pages.settings.preview") }}: {{ preview(dateFormat) }}</span>
        </label>
        <label class="field">
          <span>{{ $t("admin.pages.settings.dateTimeFormat") }}</span>
          <select v-model="dateTimeFormat">
            <option v-for="p in dateTimePresets" :key="p" :value="p">{{ p }}</option>
          </select>
          <span class="muted">{{ $t("admin.pages.settings.preview") }}: {{ preview(dateTimeFormat) }}</span>
        </label>
      </div>

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

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  font-size: 13px;
}

.field select {
  padding: 6px 8px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 13px;
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
