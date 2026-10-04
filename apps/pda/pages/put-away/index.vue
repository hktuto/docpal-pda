<template>
  <AppListPage
    :loading="pending"
    :error="error"
    :empty="taskMode ? tasks.length === 0 : candidates.length === 0"
    :empty-text="taskMode ? 'putAway.noTasks' : 'common.noReceivingOrdersNeedPutAway'"
    :shown="taskMode ? tasks.length : candidates.length"
    :total="taskMode ? tasks.length : candidates.length"
    :has-more="false"
    hide-footer
    :reload="load"
    :topics="['/put-away-tasks']"
  >
    <template #header>
      <p class="page-hint">
        {{ $t(taskMode ? 'putAway.tasksHint' : 'putAway.hint') }}
      </p>
    </template>

    <template v-if="taskMode">
      <AppListRow
        v-for="task in tasks"
        :key="task.id"
        :to="`/put-away/${task.receivingOrderId}?task=${task.id}`"
        :title="formatRow('put-away', 'title', task)"
        :meta="[formatRow('put-away', 'meta', task), $t('putAway.taskProgress', { unboxed: task.unboxedItems, received: task.receivedItems })]"
        :chip-text="statusLabel.putAway(task.status)"
        :chip-class="badgeClass(task.status)"
      />
    </template>
    <template v-else>
      <AppListRow
        v-for="ro in candidates"
        :key="ro.id"
        :to="`/put-away/${ro.id}`"
        :title="formatRow('put-away', 'title', ro)"
        :meta="[formatRow('put-away', 'meta', ro), $t('putAway.unboxedItems', { count: ro.unboxedItems })]"
        :chip-text="statusLabel.receiving(ro.status)"
        :chip-class="badgeClass(ro.status)"
      />
    </template>
  </AppListPage>
</template>

<script setup lang="ts">
import { badgeClass } from "~/composables/useStatusBadge";
import { useWarehouse } from "~/composables/useWarehouse";
import type { PutAwayCandidate, PutAwayTaskListRow } from "~/services/types";

definePageMeta({ title: "meta.putAway" });

const { t } = useI18n();
const statusLabel = useStatusLabel();
const errorMessage = useErrorMessage();
const warehouse = useWarehouse();
const { putAwayConfig, loadFlowSteps } = useFlowSteps();
// Row title/meta come from the warehouse's pdaListTemplates flow config
// (spec 2026-09-21-pda-list-row-templates-design.md); tasks and candidates
// share the put-away list config.
const { formatRow } = useListTemplates();

useHead({ title: t("putAway.title") });

const pending = ref(true);
const error = ref<string | null>(null);
const candidates = ref<PutAwayCandidate[]>([]);
const tasks = ref<PutAwayTaskListRow[]>([]);

// Task-queue mode: the backend auto-creates one put-away task per receiving
// order (putAway.autoCreateTasks); otherwise the derived candidates list.
const taskMode = computed(() => putAwayConfig.value.autoCreateTasks);

async function load() {
  try {
    // Make sure the config is resolved before picking the list source.
    await loadFlowSteps();
    if (taskMode.value) {
      tasks.value = await warehouse.listPutAwayTasks("pending");
    } else {
      candidates.value = await warehouse.getPutAwayCandidates();
    }
  } catch (e: any) {
    error.value = errorMessage(e);
  } finally {
    pending.value = false;
  }
}
</script>

<style scoped>
.page-hint {
  margin: -0.25rem 0 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}
</style>
