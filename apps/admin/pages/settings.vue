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

const { fontSize, setFontSize } = useFontSize();

function onSliderInput(event: Event) {
  setFontSize((event.target as HTMLInputElement).valueAsNumber);
}

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

    <h2 class="section-head">{{ $t("settings.textSize") }}</h2>
    <p class="muted explainer">{{ $t("settings.textSizeHint") }}</p>

    <div class="scope-card">
      <div class="size-control">
        <button
          class="btn btn-small"
          :disabled="fontSize <= FONT_SIZE_MIN"
          @click="setFontSize(fontSize - 1)"
        >
          A−
        </button>
        <input
          type="range"
          class="size-slider"
          :min="FONT_SIZE_MIN"
          :max="FONT_SIZE_MAX"
          step="1"
          :value="fontSize"
          :aria-label="$t('settings.textSize')"
          @input="onSliderInput"
        />
        <button
          class="btn btn-small"
          :disabled="fontSize >= FONT_SIZE_MAX"
          @click="setFontSize(fontSize + 1)"
        >
          A+
        </button>
        <span class="muted size-value">{{ $t("settings.currentValue", { px: fontSize }) }}</span>
      </div>
      <p class="muted size-preview">
        {{ $t("settings.preview") }}: <strong>IC-LM358DR</strong> — 2,500 pcs · A-01-01 · BOX-000123
      </p>
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
  margin: 0 0 0.5rem;
  font-size: 1rem;
}

.explainer {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
}

.scope-card {
  max-width: 35rem;
  margin-bottom: 0.75rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
  font-size: 0.8125rem;
}

.field select {
  padding: 0.375rem 0.5rem;
  border: 1px solid #cbd5e1;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
}

.actions {
  margin-top: 0.75rem;
}

.size-control {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  max-width: 35rem;
}

.size-slider {
  flex: 1;
  accent-color: var(--brand-teal);
}

.size-value {
  min-width: 4.5rem;
  text-align: right;
  font-size: 0.8125rem;
}

.size-preview {
  margin: 0.625rem 0 0;
  font-size: 0.8125rem;
}

.success-banner {
  max-width: 35rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid #86c8a0;
  border-radius: 0.375rem;
  background: #ecf9f1;
  color: #1e7a46;
  font-size: 0.8125rem;
}
</style>
