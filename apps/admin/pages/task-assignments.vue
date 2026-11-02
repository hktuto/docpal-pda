<script setup lang="ts">
import type { AdminUserRow, TaskAssignmentFlow, TaskAssignmentRow } from "~/utils/flowApi";
import type { SearchableSelectOption } from "~/components/SearchableSelect.vue";

// Per-flow task assignee editing (spec 2026-11-01): one tab per PDA task
// queue, each a table of open tasks with an inline assignee picker. Changes
// save immediately via PATCH /admin/task-assignment (optimistic, rolled back
// on error). Context columns beyond id/label/status/assignee are rendered
// from whatever extra fields the backend row carries.
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

const activeFlow = ref<TaskAssignmentFlow>("receiving-cn");

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

watch(activeFlow, load);

async function onAssigneeChange(row: TaskAssignmentRow, value: string[] | string) {
  const next = typeof value === "string" ? value : "";
  const prev = row.assignee ?? "";
  if (next === prev || savingIds.value[row.id]) return;
  row.assignee = next || null;
  savingIds.value = { ...savingIds.value, [row.id]: true };
  error.value = "";
  try {
    await flow.setTaskAssignment(activeFlow.value, row.id, next || null);
  } catch (e: any) {
    row.assignee = prev || null;
    error.value = `${t("taskAssignments.saveFailed")}: ${e?.message ?? String(e)}`;
  } finally {
    savingIds.value = { ...savingIds.value, [row.id]: false };
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
        v-for="f in FLOWS"
        :key="f"
        type="button"
        class="flow-tab"
        :class="{ active: activeFlow === f }"
        @click="activeFlow = f"
      >
        {{ $t(`taskAssignments.flows.${f}`) }}
      </button>
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
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
                @update:model-value="onAssigneeChange(row, $event)"
              />
            </td>
          </tr>
          <tr v-if="rows.length === 0">
            <td :colspan="3 + contextKeys.length" class="muted">{{ $t("taskAssignments.none") }}</td>
          </tr>
        </tbody>
      </table>
    </div>
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
