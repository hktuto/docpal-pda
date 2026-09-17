<script setup lang="ts">
import type { FlowConfigState } from "~/utils/flowApi";
import { formatDateCodeDisplay } from "~/utils/dateCodeDisplay";

// Date-code display template editor (spec
// docs/superpowers/specs/2026-09-17-date-code-display-template-design.md):
// configures the flow-config key dateCodeDisplayTemplate — how lot date code /
// lot code / COO / COW render in the receiving and picking detail screens.
// Saves through the same /admin/flow-config endpoint; the backend PUT stores
// the raw body as the whole row, so we merge our key over the stored JSON.

const flow = useFlowApi();
const { t } = useI18n();

const PLACEHOLDERS = ["date_code", "lot_code", "coo", "cow"] as const;

// Preview samples: a full lot and one with no COO/COW (shows the empty-
// placeholder behavior — no dangling separator).
const SAMPLE_FULL = { dateCode: "3626", lotCode: "L01", coo: "cn", cow: "tw" };
const SAMPLE_PARTIAL = { dateCode: "3626", lotCode: "L01", coo: null, cow: null };

const state = ref<FlowConfigState | null>(null);
const templateText = ref("");
const templateInput = ref<HTMLInputElement | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const saved = ref(false);

const previewFull = computed(() => formatDateCodeDisplay(SAMPLE_FULL, templateText.value) || "—");
const previewPartial = computed(() => formatDateCodeDisplay(SAMPLE_PARTIAL, templateText.value) || "—");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    state.value = await flow.getFlowConfig();
    templateText.value = state.value.config.dateCodeDisplayTemplate ?? "[date_code][coo]";
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function insertPlaceholder(name: (typeof PLACEHOLDERS)[number]) {
  const token = `[${name}]`;
  const el = templateInput.value;
  if (!el) {
    templateText.value += token;
    return;
  }
  const start = el.selectionStart ?? templateText.value.length;
  const end = el.selectionEnd ?? start;
  templateText.value = templateText.value.slice(0, start) + token + templateText.value.slice(end);
  nextTick(() => {
    el.focus();
    el.setSelectionRange(start + token.length, start + token.length);
  });
}

async function save() {
  if (templateText.value.trim() === "") {
    error.value = t("admin.pages.displayConfig.templateInvalid");
    return;
  }
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    state.value = await flow.saveFlowConfig({
      ...(state.value?.stored ?? {}),
      dateCodeDisplayTemplate: templateText.value,
    });
    saved.value = true;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("admin.pages.displayConfig.title") }}</h1>
    </div>

    <p v-if="loading">{{ $t("admin.common.loading") }}</p>
    <template v-else-if="state">
      <div v-if="state.envOverride" class="warn-banner">
        {{ $t("admin.pages.displayConfig.envOverrideWarning") }}
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.displayConfig.templateSection") }}</h2>
        <div class="form-row">
          <label for="dc-template">{{ $t("admin.pages.displayConfig.template") }}</label>
          <input id="dc-template" ref="templateInput" v-model="templateText" type="text" class="template-input" />
        </div>
        <div class="chip-row">
          <button
            v-for="p in PLACEHOLDERS"
            :key="p"
            type="button"
            class="btn chip"
            :title="$t(`admin.pages.displayConfig.placeholderLabels.${p}`)"
            @click="insertPlaceholder(p)"
          >
            [{{ p }}]
          </button>
        </div>
        <p class="hint-text">{{ $t("admin.pages.displayConfig.templateHint") }}</p>

        <h2>{{ $t("admin.pages.displayConfig.previewSection") }}</h2>
        <div class="preview-row">
          <span class="preview-label">{{ $t("admin.pages.displayConfig.previewFull") }}</span>
          <code class="preview-value">{{ previewFull }}</code>
        </div>
        <div class="preview-row">
          <span class="preview-label">{{ $t("admin.pages.displayConfig.previewNoCoo") }}</span>
          <code class="preview-value">{{ previewPartial }}</code>
        </div>
      </div>

      <div class="actions-row">
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
        </button>
        <span v-if="saved" class="ok-text">{{ $t("admin.pages.displayConfig.saved") }}</span>
        <span v-if="error" class="error-text">{{ error }}</span>
      </div>
    </template>
    <p v-else class="error-text">{{ error }}</p>
  </div>
</template>

<style scoped>
.form-card {
  margin-bottom: 1rem;
}

.form-card h2 {
  margin: 0 0 0.75rem;
  font-size: 1rem;
}

.form-card h2 + .preview-row,
.form-row + .chip-row {
  margin-top: 0.5rem;
}

.form-card h2:not(:first-child) {
  margin-top: 1.25rem;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.template-input {
  width: 24rem;
  font-family: ui-monospace, monospace;
}

.chip-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.chip {
  font-family: ui-monospace, monospace;
  font-size: 0.8125rem;
  padding: 0.25rem 0.625rem;
}

.preview-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.25rem 0;
}

.preview-label {
  min-width: 14rem;
  font-size: 0.875rem;
}

.preview-value {
  padding: 0.125rem 0.5rem;
  background: #f2f5f8;
  border-radius: 0.25rem;
}

.hint-text {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
  color: var(--muted, #666);
}

.warn-banner {
  background: #fff8e1;
  border: 1px solid #f0c36d;
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
}

.actions-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.ok-text {
  color: var(--ok, #2e7d32);
}

.error-text {
  color: var(--danger, #c62828);
}
</style>
