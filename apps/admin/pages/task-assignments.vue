<script setup lang="ts">
import type { AdminUserRow, TaskAssignmentFlow, TaskAssignmentRow, TaskLifecycleStep } from "~/utils/flowApi";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// Per-flow task assignee editing (spec 2026-11-01): one tab per PDA task
// queue, each a table of open tasks with an inline assignee picker. Changes
// save immediately via PATCH /admin/task-assignment (optimistic, rolled back
// on error). Context columns beyond id/label/status/assignee are rendered
// from whatever extra fields the backend row carries. The "Lifecycle" tab
// (CR-048) shows one order/batch number's open tasks across all flows.
const flow = useFlowApi();
const { t } = useI18n();

const FLOWS: TaskAssignmentFlow[] = [
  "receiving-cn",
  "picking",
  "label-printing",
  "labeling",
  "put-away",
  "put-away-cn",
  "measuring",
  "verify",
];

type Tab = "lifecycle" | TaskAssignmentFlow;
const TABS: Tab[] = ["lifecycle", ...FLOWS];
const activeTab = ref<Tab>("receiving-cn");
const isLifecycle = computed(() => activeTab.value === "lifecycle");
const activeFlow = computed(() => activeTab.value as TaskAssignmentFlow);

const users = ref<AdminUserRow[]>([]);
const userOptions = computed<SearchableSelectOption[]>(() =>
  users.value.map((u) => ({ value: u.username, label: `${u.displayName} (${u.username})` }))
);

const rows = ref<TaskAssignmentRow[]>([]);
const loading = ref(true);
const error = ref("");
const savingIds = ref<Record<string, boolean>>({});

// Flow-specific context fields, unioned across the loaded rows (order kept
// stable by first appearance).
const CONTEXT_SKIP = new Set(["id", "label", "status", "assignee"]);
const contextKeys = computed<string[]>(() => {
  const keys: string[] = [];
  for (const r of rows.value) {
    for (const k of Object.keys(r)) {
      if (!CONTEXT_SKIP.has(k) && !keys.includes(k)) keys.push(k);
    }
  }
  return keys;
});

function cellText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rows.value = await flow.listTaskAssignments(activeFlow.value);
  } catch (e: any) {
    error.value = e?.message ?? String(e);
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

watch(activeTab, (tab) => {
  if (tab !== "lifecycle") load();
});

/** Optimistic assignee edit shared by the flow tabs and the lifecycle view.
 *  picking/labeling/label-printing steps are the same picking_orders row, so
 *  a saved value is synced onto the sibling steps. */
async function saveAssignee(
  taskFlow: TaskAssignmentFlow,
  row: TaskAssignmentRow | TaskLifecycleStep,
  value: string[] | string
) {
  const next = typeof value === "string" ? value : "";
  const prev = row.assignee ?? "";
  if (next === prev || savingIds.value[row.id]) return;
  row.assignee = next || null;
  savingIds.value = { ...savingIds.value, [row.id]: true };
  error.value = "";
  try {
    await flow.setTaskAssignment(taskFlow, row.id, next || null);
    for (const s of lcSteps.value) if (s !== row && s.id === row.id) s.assignee = row.assignee;
  } catch (e: any) {
    row.assignee = prev || null;
    error.value = `${t("taskAssignments.saveFailed")}: ${e?.message ?? String(e)}`;
  } finally {
    savingIds.value = { ...savingIds.value, [row.id]: false };
  }
}

// Lifecycle panel (CR-048): one order/batch (or box) number per search; steps
// with no open task simply don't appear.
const lcKey = ref("");
const lcSteps = ref<TaskLifecycleStep[]>([]);
const lcLoading = ref(false);
const lcSearched = ref(false);

async function searchLifecycle() {
  const key = lcKey.value.trim();
  if (!key || lcLoading.value) return;
  lcLoading.value = true;
  error.value = "";
  try {
    lcSteps.value = (await flow.getTaskLifecycle(key)).steps;
    lcSearched.value = true;
  } catch (e: any) {
    error.value = e?.message ?? String(e);
    lcSteps.value = [];
  } finally {
    lcLoading.value = false;
  }
}

onMounted(() => {
  load();
  flow
    .listAdminUsers()
    .then((list) => (users.value = list))
    .catch(() => {}); // picker options stay empty; the table still loads
});
</script>

<template>
  <div>
    <div class="page-head">
      <h1>{{ $t("taskAssignments.title") }}</h1>
      <button class="btn" :disabled="loading" @click="load">
        {{ $t("admin.common.refresh") }}
      </button>
    </div>

    <p class="muted explainer">{{ $t("taskAssignments.explainer") }}</p>

    <div class="flow-tabs">
      <button
        v-for="tab in TABS"
        :key="tab"
        type="button"
        class="flow-tab"
        :class="{ active: activeTab === tab }"
        @click="activeTab = tab"
      >
        {{ tab === "lifecycle" ? $t("taskAssignments.lifecycleTab") : $t(`taskAssignments.flows.${tab}`) }}
      </button>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>

    <template v-if="isLifecycle">
      <div class="search-bar">
        <input
          v-model="lcKey"
          type="search"
          class="search-input"
          :placeholder="$t('taskAssignments.lifecyclePlaceholder')"
          @keyup.enter="searchLifecycle"
        />
        <button class="btn" :disabled="lcLoading || !lcKey.trim()" @click="searchLifecycle">
          {{ $t("admin.common.search") }}
        </button>
      </div>
      <div v-if="lcLoading" class="loading">{{ $t("admin.common.loading") }}</div>
      <div v-else-if="lcSearched" class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("taskAssignments.lifecycleColStep") }}</th>
              <th>{{ $t("taskAssignments.colTask") }}</th>
              <th>{{ $t("taskAssignments.colStatus") }}</th>
              <th class="assignee-col">{{ $t("taskAssignments.colAssignee") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="step in lcSteps" :key="`${step.flow}-${step.id}`">
              <td>{{ $t(`taskAssignments.flows.${step.flow}`) }}</td>
              <td>{{ step.label }}</td>
              <td>{{ step.status }}</td>
              <td class="assignee-col">
                <SearchableSelect
                  :model-value="step.assignee ?? ''"
                  :options="userOptions"
                  :all-label="$t('taskAssignments.unassigned')"
                  :aria-label="$t('taskAssignments.colAssignee')"
                  :multiple="false"
                  :disabled="!!savingIds[step.id]"
                  @update:model-value="saveAssignee(step.flow, step, $event)"
                />
              </td>
            </tr>
            <tr v-if="lcSteps.length === 0">
              <td colspan="4" class="muted">{{ $t("taskAssignments.lifecycleNone") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted explainer">{{ $t("taskAssignments.lifecycleHint") }}</p>
    </template>

    <template v-else>
      <div v-if="loading" class="loading">{{ $t("admin.common.loading") }}</div>

      <div v-else class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>{{ $t("taskAssignments.colTask") }}</th>
              <th>{{ $t("taskAssignments.colStatus") }}</th>
              <th v-for="k in contextKeys" :key="k">{{ k }}</th>
              <th class="assignee-col">{{ $t("taskAssignments.colAssignee") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td>{{ row.label }}</td>
              <td>{{ row.status }}</td>
              <td v-for="k in contextKeys" :key="k">{{ cellText(row[k]) }}</td>
              <td class="assignee-col">
                <SearchableSelect
                  :model-value="row.assignee ?? ''"
                  :options="userOptions"
                  :all-label="$t('taskAssignments.unassigned')"
                  :aria-label="$t('taskAssignments.colAssignee')"
                  :multiple="false"
                  :disabled="!!savingIds[row.id]"
                  @update:model-value="saveAssignee(activeFlow, row, $event)"
                />
              </td>
            </tr>
            <tr v-if="rows.length === 0">
              <td :colspan="3 + contextKeys.length" class="muted">{{ $t("taskAssignments.none") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.explainer {
  margin: 0 0 0.75rem;
  font-size: 0.8125rem;
}
.flow-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-bottom: 0.75rem;
}
.flow-tab {
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  border: 1px solid #b6c2cd;
  border-radius: 0.25rem;
  background: #fff;
  color: #52606d;
  cursor: pointer;
}
.flow-tab.active {
  background: #0b5cab;
  border-color: #0b5cab;
  color: #fff;
}
.assignee-col {
  min-width: 13.75rem;
}
</style>
