<script setup lang="ts">
import type { FlowConfigState } from "~/utils/flowApi";

// Flow config editor (spec 2026-08-12-admin-flow-config-design.md): a
// structured form over the warehouse_config row "flow". Saves apply at
// runtime on the backend unless the FLOW_CONFIG env override is active.

const flow = useFlowApi();

const STEPS = ["receiving", "put-away", "picking", "goods-verify", "measuring", "verify", "stock-search"] as const;

const state = ref<FlowConfigState | null>(null);
const stepEnabled = reactive<Record<string, boolean>>({});
const allowDockStock = ref(true);
const autoCreateTasks = ref(false);
const suggestShelf = ref<"existing-stock" | "off">("existing-stock");

const loading = ref(true);
const saving = ref(false);
const error = ref("");
const saved = ref(false);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    state.value = await flow.getFlowConfig();
    for (const s of STEPS) stepEnabled[s] = state.value.config.steps[s]?.enabled ?? true;
    allowDockStock.value = state.value.config.pickingAllocation.allowDockStock;
    autoCreateTasks.value = state.value.config.putAway.autoCreateTasks;
    suggestShelf.value = state.value.config.putAway.suggestShelf;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    // Fully-expanded steps JSON — same shape the boot merge produces.
    const steps: Record<string, unknown> = {};
    for (const s of STEPS) steps[s] = { enabled: !!stepEnabled[s] };
    steps["picking"] = { ...steps["picking"], allocation: { allowDockStock: allowDockStock.value } };
    steps["put-away"] = {
      ...steps["put-away"],
      autoCreateTasks: autoCreateTasks.value,
      suggestShelf: suggestShelf.value,
    };
    state.value = await flow.saveFlowConfig({ steps });
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
      <h1>{{ $t("admin.pages.flowConfig.title") }}</h1>
    </div>

    <p v-if="loading">{{ $t("admin.common.loading") }}</p>
    <template v-else-if="state">
      <div v-if="state.envOverride" class="warn-banner">
        {{ $t("admin.pages.flowConfig.envOverrideWarning") }}
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.flowConfig.stepsSection") }}</h2>
        <label v-for="s in STEPS" :key="s" class="check-row">
          <input v-model="stepEnabled[s]" type="checkbox" />
          {{ $t(`admin.pages.flowConfig.steps.${s}`) }}
        </label>
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.flowConfig.pickingSection") }}</h2>
        <label class="check-row">
          <input v-model="allowDockStock" type="checkbox" />
          {{ $t("admin.pages.flowConfig.allowDockStock") }}
        </label>
      </div>

      <div class="card form-card">
        <h2>{{ $t("admin.pages.flowConfig.putAwaySection") }}</h2>
        <label class="check-row">
          <input v-model="autoCreateTasks" type="checkbox" />
          {{ $t("admin.pages.flowConfig.autoCreateTasks") }}
        </label>
        <div class="form-row">
          <label for="fc-suggest">{{ $t("admin.pages.flowConfig.suggestShelf") }}</label>
          <select id="fc-suggest" v-model="suggestShelf">
            <option value="existing-stock">{{ $t("admin.pages.flowConfig.suggestShelfOn") }}</option>
            <option value="off">{{ $t("admin.pages.flowConfig.suggestShelfOff") }}</option>
          </select>
        </div>
      </div>

      <div class="actions-row">
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? $t("admin.common.saving") : $t("admin.common.save") }}
        </button>
        <span v-if="saved" class="ok-text">{{ $t("admin.pages.flowConfig.saved") }}</span>
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

.check-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
}

.form-row {
  margin-top: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.warn-banner {
  background: #fff8e1;
  border: 1px solid #f0c36d;
  border-radius: 6px;
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
